import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../dist/db.js";
import { TaskOperationCoordinator } from "../dist/task-operation-coordinator.js";
import { WorktreeManager } from "../dist/git/worktree-manager.js";
import { QueueManager } from "../dist/queue/queue-manager.js";

let MergeManager;
let importError;
try {
  ({ MergeManager } = await import("../dist/agents/merge-manager.js"));
} catch (error) {
  importError = error;
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function requireManager() {
  assert.equal(typeof MergeManager, "function",
    `Expected Phase 9 MergeManager; ${importError?.message ?? "export is missing"}`);
}

async function setup(t, { validationStart = async () => ({ run_id: "fresh-validation", status: "QUEUED" }),
  failCleanup = false, beforeRefUpdate } = {}) {
  requireManager();
  const temp = mkdtempSync(join(tmpdir(), "kanban-phase9-merge-"));
  const repo = join(temp, "repo");
  const worktreeRoot = join(temp, "worktrees");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Phase 9 Test");
  git(repo, "config", "user.email", "phase9@example.invalid");
  writeFileSync(join(repo, "shared.txt"), "base\n");
  git(repo, "add", "shared.txt");
  git(repo, "commit", "-m", "base");
  const baseSha = git(repo, "rev-parse", "HEAD");

  const db = openDatabase(join(temp, "app.sqlite"));
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, worktree_root, created_at, updated_at)
    VALUES ('p', 'Project', ?, ?, ?, ?)`).run(repo, worktreeRoot, now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, review_tag, created_at, updated_at)
    VALUES ('t', 'p', 'Task', '', 'REVIEW', 'IMPLEMENTATION_COMPLETE', ?, ?)`).run(now, now);
  const worktrees = new WorktreeManager(db);
  const worktreePath = (await worktrees.createTaskWorktree("t")).worktreePath;
  writeFileSync(join(worktreePath, "shared.txt"), "task change\n");
  const candidateSha = await worktrees.createCheckpoint("t");
  db.prepare("UPDATE tasks SET latest_task_commit_sha = ? WHERE id = 't'").run(candidateSha);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('validation-run', 't', 'VALIDATION_REVIEW', 1, 'COMPLETED')`).run();
  db.prepare(`INSERT INTO validation_results (id, task_id, run_id, result, findings_json, created_at)
    VALUES ('result-1', 't', 'validation-run', 'PASSED', '[]', ?)`).run(now);
  db.prepare(`INSERT INTO validation_snapshots (id, task_id, validation_run_id, validated_task_sha,
    validated_base_sha, messages_watermark, result, created_at)
    VALUES ('snapshot-1', 't', 'validation-run', ?, ?, '0', 'PASSED', ?)`).run(candidateSha, baseSha, now);
  db.prepare(`UPDATE tasks SET review_tag = 'READY_TO_MERGE', active_validation_snapshot_id = 'snapshot-1'
    WHERE id = 't'`).run();

  const validationCalls = [];
  const validation = { async start(taskId, options) {
    validationCalls.push({ taskId, options });
    return validationStart(taskId, options);
  } };
  const mergeWorktrees = failCleanup ? Object.assign(Object.create(worktrees), {
    async removeTaskWorktree(taskId) {
      db.prepare("UPDATE tasks SET cleanup_status = 'CLEANUP_PENDING' WHERE id = ?").run(taskId);
      throw new Error("simulated cleanup failure");
    },
  }) : worktrees;
  const operations = new TaskOperationCoordinator();
  const manager = new MergeManager({ db, worktrees: mergeWorktrees, operations, validation, beforeRefUpdate });
  t.after(() => {
    db.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { db, repo, baseSha, candidateSha, worktreePath, baseWorktrees: worktrees, worktrees: mergeWorktrees,
    manager, operations, validation, validationCalls };
}

test("unchanged validated SHAs require approval, then fast-forward and close as MERGED", async (t) => {
  const state = await setup(t);
  const before = git(state.repo, "rev-parse", "refs/heads/main");
  await assert.rejects(state.manager.start("t", { confirmed: false }), /confirm|approval/i);
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), before, "declined merge must not move the base ref");

  const result = await state.manager.start("t", { confirmed: true });
  assert.equal(result.status, "MERGED");
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), state.candidateSha);
  const task = state.db.prepare("SELECT workflow_state, resolution FROM tasks WHERE id = 't'").get();
  assert.deepEqual(task, { workflow_state: "DONE", resolution: "MERGED" });
  const attempt = state.db.prepare("SELECT approval_status, status, validated_base_sha, validated_task_sha FROM merge_attempts WHERE task_id = 't'").get();
  assert.deepEqual(attempt, { approval_status: "APPROVED", status: "COMPLETED", validated_base_sha: state.baseSha, validated_task_sha: state.candidateSha });
  assert.equal(git(state.repo, "show-ref", "--verify", "refs/heads/agent/task-t").split(" ")[0], state.candidateSha,
    "successful merge preserves the task branch");
  assert.equal(state.validationCalls.length, 0, "same-base merge uses the still-current validation snapshot");
});

test("missing or mismatched active validation snapshots block merge without moving refs", async (t) => {
  for (const scenario of ["missing", "candidate-mismatch", "base-mismatch", "issues"]) {
    await t.test(scenario, async (t2) => {
      const state = await setup(t2);
      if (scenario === "missing") {
        state.db.prepare("UPDATE tasks SET active_validation_snapshot_id = NULL WHERE id = 't'").run();
      } else if (scenario === "candidate-mismatch") {
        state.db.prepare("UPDATE validation_snapshots SET validated_task_sha = ? WHERE id = 'snapshot-1'").run("d".repeat(40));
      } else if (scenario === "base-mismatch") {
        state.db.prepare("UPDATE validation_snapshots SET validated_base_sha = ? WHERE id = 'snapshot-1'").run("d".repeat(40));
      } else {
        state.db.prepare("UPDATE validation_snapshots SET result = 'ISSUES_FOUND' WHERE id = 'snapshot-1'").run();
        state.db.prepare("UPDATE validation_results SET result = 'ISSUES_FOUND', findings_json = ? WHERE id = 'result-1'")
          .run(JSON.stringify([{ attribution: "DIRECT" }]));
      }
      const preview = await state.manager.preview("t");
      assert.equal(preview.eligible, false);
      await assert.rejects(state.manager.start("t", { confirmed: true }), /validation|snapshot|finding|checkpoint/i);
      assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), state.baseSha);
    });
  }
});

test("merge acquisition serializes against the same task-operation lease", async (t) => {
  const state = await setup(t);
  const release = state.operations.tryAcquire("t");
  assert.equal(typeof release, "function");
  await assert.rejects(state.manager.start("t", { confirmed: true }), /operation|busy|active/i);
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), state.baseSha);
  release();
});

test("active task work blocks merge and leaves the queued/running run untouched", async (t) => {
  const state = await setup(t);
  const now = new Date().toISOString();
  state.db.prepare("INSERT INTO task_runs (id, task_id, stage, sequence, status) VALUES ('active-run', 't', 'IMPLEMENTATION', 2, 'RUNNING')").run();
  state.db.prepare(`INSERT INTO agent_jobs (id, task_run_id, queue_position, priority, status, created_at)
    VALUES ('active-job', 'active-run', NULL, 0, 'CLAIMED', ?)`)
    .run(now);
  await assert.rejects(state.manager.start("t", { confirmed: true }), /active|queued|operation/i);
  assert.equal(state.db.prepare("SELECT status FROM task_runs WHERE id = 'active-run'").get().status, "RUNNING");
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), state.baseSha);
});

test("task HEAD movement after merge preview invalidates the candidate before integration", async (t) => {
  const state = await setup(t);
  await state.manager.preview("t");
  git(state.worktreePath, "commit", "--allow-empty", "-m", "move task branch after preview");
  await assert.rejects(state.manager.start("t", { confirmed: true }), /head|candidate|checkpoint|branch/i);
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), state.baseSha);
});

test("unchecked base branch integrates with an expected-old-SHA compare-and-swap", async (t) => {
  const state = await setup(t);
  git(state.repo, "switch", "--detach", state.baseSha);
  assert.equal(git(state.repo, "branch", "--show-current"), "");
  const result = await state.manager.start("t", { confirmed: true });
  assert.equal(result.status, "MERGED");
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), state.candidateSha);
  assert.equal(git(state.repo, "rev-parse", "HEAD"), state.baseSha,
    "updating an unchecked-out base ref leaves the primary checkout untouched");
});

test("a compare-and-swap failure preserves a concurrent base update and revokes approval", async (t) => {
  let state;
  let concurrentSha;
  state = await setup(t, { beforeRefUpdate: async ({ branch, expectedOldSha }) => {
    assert.equal(branch, "main");
    assert.equal(expectedOldSha, state.baseSha);
    const tree = git(state.repo, "rev-parse", `${expectedOldSha}^{tree}`);
    concurrentSha = git(state.repo, "commit-tree", tree, "-p", expectedOldSha, "-m", "concurrent base update");
    git(state.repo, "update-ref", `refs/heads/${branch}`, concurrentSha, expectedOldSha);
  } });
  git(state.repo, "switch", "--detach", state.baseSha);

  await assert.rejects(state.manager.start("t", { confirmed: true }), /ref|compare|expected|changed/i);
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), concurrentSha,
    "the concurrent writer's newer ref must never be overwritten");
  const attempt = state.db.prepare("SELECT approval_status FROM merge_attempts WHERE task_id = 't'").get();
  assert.equal(attempt.approval_status, "REVOKED", "CAS failure requires a fresh user decision");
});

test("a base branch checked out in a non-primary linked worktree is blocked with safe recovery guidance", async (t) => {
  const state = await setup(t);
  const secondary = join(state.repo, "..", "secondary-base");
  git(state.repo, "switch", "--detach", state.baseSha);
  git(state.repo, "worktree", "add", secondary, "main");
  const before = git(state.repo, "rev-parse", "refs/heads/main");
  await assert.rejects(state.manager.start("t", { confirmed: true }), /linked worktree|primary checkout|detach|move/i);
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), before);
  assert.equal(git(secondary, "status", "--porcelain"), "");
});

test("new delivered guidance beyond the validation watermark blocks merge until revalidated", async (t) => {
  const state = await setup(t);
  const now = new Date().toISOString();
  state.db.prepare("INSERT INTO task_runs (id, task_id, stage, sequence, status) VALUES ('impl-run', 't', 'IMPLEMENTATION', 2, 'COMPLETED')").run();
  state.db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content,
    delivery_type, delivery_status, accepted_at, delivered_at) VALUES ('new-guidance', 't', 'impl-run', 1,
    'new-guidance-key', 'Please also update the license.', 'STEERING', 'DELIVERED', ?, ?)`)
    .run(now, now);
  await assert.rejects(state.manager.start("t", { confirmed: true }), /guidance|validation|watermark/i);
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), state.baseSha);
});

test("restart reconciles a ref already moved before the database completion record", async (t) => {
  const state = await setup(t);
  state.db.exec(`CREATE TRIGGER fail_merge_completion BEFORE UPDATE OF workflow_state ON tasks
    WHEN NEW.workflow_state = 'DONE' BEGIN SELECT RAISE(ABORT, 'simulated process crash'); END;`);
  await assert.rejects(state.manager.start("t", { confirmed: true }), /crash|aborted|fail/i);
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), state.candidateSha,
    "the Git update may have completed before persistence was interrupted");
  state.db.exec("DROP TRIGGER fail_merge_completion");
  const restarted = new MergeManager({ db: state.db, worktrees: state.baseWorktrees,
    operations: new TaskOperationCoordinator(), validation: state.validation });
  await restarted.reconcileAfterRestart();
  assert.deepEqual(state.db.prepare("SELECT workflow_state, resolution FROM tasks WHERE id = 't'").get(),
    { workflow_state: "DONE", resolution: "MERGED" });
  assert.equal(state.db.prepare("SELECT status FROM merge_attempts WHERE task_id = 't'").get().status, "COMPLETED");
});

test("restart revokes pending merge approval and never resumes integration", async (t) => {
  const state = await setup(t);
  const now = new Date().toISOString();
  state.db.prepare(`INSERT INTO merge_attempts (id, task_id, validation_snapshot_id, approval_status,
    validated_base_sha, validated_task_sha, status, started_at) VALUES ('pending-merge', 't', 'snapshot-1',
    'APPROVED', ?, ?, 'APPROVED', ?)`)
    .run(state.baseSha, state.candidateSha, now);
  await state.manager.reconcileAfterRestart();
  assert.equal(state.db.prepare("SELECT approval_status FROM merge_attempts WHERE id = 'pending-merge'").get().approval_status, "REVOKED");
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), state.baseSha);
});

test("repeat merge requests reuse the completed attempt without integrating twice", async (t) => {
  const state = await setup(t);
  const first = await state.manager.start("t", { confirmed: true });
  const second = await state.manager.start("t", { confirmed: true });
  assert.equal(first.merge_attempt_id, second.merge_attempt_id);
  assert.equal(state.db.prepare("SELECT COUNT(*) FROM merge_attempts WHERE task_id = 't'").pluck().get(), 1);
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), state.candidateSha);
});

test("dirty primary checkout blocks merge without changing its files or branch", async (t) => {
  const state = await setup(t);
  const beforeHead = git(state.repo, "rev-parse", "HEAD");
  writeFileSync(join(state.repo, "primary-only.txt"), "preserve me\n");
  await assert.rejects(state.manager.start("t", { confirmed: true }), /primary|checkout|dirty|uncommitted/i);
  assert.equal(git(state.repo, "rev-parse", "HEAD"), beforeHead);
  assert.equal(readFileSync(join(state.repo, "primary-only.txt"), "utf8"), "preserve me\n");
  assert.notEqual(git(state.repo, "rev-parse", "refs/heads/main"), state.candidateSha);
});

test("base movement syncs into the task and queues fresh priority Validation without integrating", async (t) => {
  let syncSha;
  const state = await setup(t, { validationStart: async (taskId, options) => {
    assert.equal(taskId, "t");
    assert.equal(options.priority, true);
    assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), syncSha,
      "base sync must not modify the primary checkout");
    return { run_id: "fresh-validation", status: "QUEUED" };
  } });
  writeFileSync(join(state.repo, "base-only.txt"), "new base\n");
  git(state.repo, "add", "base-only.txt");
  git(state.repo, "commit", "-m", "move base");
  syncSha = git(state.repo, "rev-parse", "HEAD");
  const oldCandidate = state.candidateSha;

  const result = await state.manager.start("t", { confirmed: true });
  assert.equal(result.status, "VALIDATION_QUEUED");
  assert.notEqual(git(state.worktreePath, "rev-parse", "HEAD"), oldCandidate);
  assert.equal(state.db.prepare("SELECT base_commit_sha FROM tasks WHERE id = 't'").get().base_commit_sha, syncSha);
  assert.equal(state.db.prepare("SELECT active_validation_snapshot_id FROM tasks WHERE id = 't'").get().active_validation_snapshot_id, null);
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), syncSha,
    "the task branch is synced first; base is not integrated until fresh Validation succeeds");
  assert.equal(state.validationCalls.length, 1);
});

test("stopping priority Validation revokes approval and preserves the synced task branch", async (t) => {
  const state = await setup(t, { validationStart: async () => ({ run_id: "fresh-validation", status: "QUEUED" }) });
  writeFileSync(join(state.repo, "base-update.txt"), "new base\n");
  git(state.repo, "add", "base-update.txt");
  git(state.repo, "commit", "-m", "move base before stoppable validation");
  const movedBaseSha = git(state.repo, "rev-parse", "HEAD");
  const queued = await state.manager.start("t", { confirmed: true });
  assert.equal(queued.status, "VALIDATION_QUEUED");
  const stopped = await state.manager.onValidationStopped(queued.merge_attempt_id, "fresh-validation");
  assert.equal(stopped.status, "VALIDATION_STOPPED");
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), movedBaseSha);
  assert.deepEqual(state.db.prepare("SELECT workflow_state, review_tag FROM tasks WHERE id = 't'").get(),
    { workflow_state: "REVIEW", review_tag: "VALIDATION_FAILED" });
  assert.equal(state.db.prepare("SELECT approval_status FROM merge_attempts WHERE id = ?").get(queued.merge_attempt_id).approval_status, "REVOKED");
  const lateCompletion = await state.manager.onValidationCompleted(queued.merge_attempt_id, "fresh-validation");
  assert.equal(lateCompletion.status, "APPROVAL_REVOKED", "a late Validation event must not honor stopped merge intent");
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), movedBaseSha);
});

test("removing queued priority Validation revokes merge approval and blocks late completion", async (t) => {
  const state = await setup(t, { validationStart: async () => ({ run_id: "fresh-validation", status: "QUEUED" }) });
  writeFileSync(join(state.repo, "base-update.txt"), "new base\n");
  git(state.repo, "add", "base-update.txt");
  git(state.repo, "commit", "-m", "move base before removable validation");
  const movedBaseSha = git(state.repo, "rev-parse", "HEAD");
  const queued = await state.manager.start("t", { confirmed: true });
  assert.equal(queued.status, "VALIDATION_QUEUED");

  if (!state.db.prepare("SELECT id FROM task_runs WHERE id = 'fresh-validation'").get()) {
    state.db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, return_workflow_state,
      return_review_tag) VALUES ('fresh-validation', 't', 'VALIDATION_REVIEW', 2, 'QUEUED', 'REVIEW', 'IMPLEMENTATION_COMPLETE')`).run();
  }
  let queuedJob = state.db.prepare("SELECT id FROM agent_jobs WHERE task_run_id = 'fresh-validation'").get();
  if (!queuedJob) {
    const now = new Date().toISOString();
    if (!state.db.prepare("SELECT id FROM run_inputs WHERE run_id = 'fresh-validation'").get()) {
      state.db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content,
        delivery_type, delivery_status, accepted_at) VALUES ('fresh-validation-input', 't', 'fresh-validation', 1,
        'fresh-validation-key', 'review', 'INITIAL_PROMPT', 'PENDING', ?)`).run(now);
    }
    state.db.prepare(`INSERT INTO agent_jobs (id, task_run_id, queue_position, priority, status, created_at)
      VALUES ('fresh-validation-job', 'fresh-validation', 1, 1, 'QUEUED', ?)`).run(now);
    queuedJob = { id: "fresh-validation-job" };
  }
  const queue = new QueueManager(state.db, { start() { throw new Error("removed validation must not dispatch"); } }, 1);
  queue.remove(queuedJob.id);
  assert.equal(state.db.prepare("SELECT status FROM task_runs WHERE id = 'fresh-validation'").get().status, "CANCELLED");

  const removed = await state.manager.onValidationStopped(queued.merge_attempt_id, "fresh-validation");
  assert.equal(removed.status, "VALIDATION_STOPPED");
  assert.equal(state.db.prepare("SELECT approval_status FROM merge_attempts WHERE id = ?").get(queued.merge_attempt_id).approval_status, "REVOKED");
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), movedBaseSha);
  const lateCompletion = await state.manager.onValidationCompleted(queued.merge_attempt_id, "fresh-validation");
  assert.equal(lateCompletion.status, "APPROVAL_REVOKED");
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), movedBaseSha);
});

test("one approved base sync plus fresh exact-SHA Validation integrates after final rechecks", async (t) => {
  let state;
  state = await setup(t, { validationStart: async () => ({ run_id: "fresh-validation", status: "QUEUED" }) });
  writeFileSync(join(state.repo, "base-update.txt"), "new base\n");
  git(state.repo, "add", "base-update.txt");
  git(state.repo, "commit", "-m", "move base for validation");
  const movedBaseSha = git(state.repo, "rev-parse", "HEAD");
  const queued = await state.manager.start("t", { confirmed: true });
  assert.equal(queued.status, "VALIDATION_QUEUED");
  const task = state.db.prepare("SELECT base_commit_sha, latest_task_commit_sha FROM tasks WHERE id = 't'").get();
  const now = new Date().toISOString();
  state.db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('fresh-validation', 't', 'VALIDATION_REVIEW', 2, 'COMPLETED')`).run();
  state.db.prepare(`INSERT INTO validation_results (id, task_id, run_id, result, findings_json, created_at)
    VALUES ('fresh-result', 't', 'fresh-validation', 'PASSED', '[]', ?)`).run(now);
  state.db.prepare(`INSERT INTO validation_snapshots (id, task_id, validation_run_id, validated_task_sha,
    validated_base_sha, messages_watermark, result, created_at)
    VALUES ('fresh-snapshot', 't', 'fresh-validation', ?, ?, '0', 'PASSED', ?)`)
    .run(task.latest_task_commit_sha, task.base_commit_sha, now);
  state.db.prepare(`UPDATE tasks SET review_tag = 'READY_TO_MERGE', active_validation_snapshot_id = 'fresh-snapshot'
    WHERE id = 't'`).run();

  const integrated = await state.manager.onValidationCompleted(queued.merge_attempt_id, "fresh-validation");
  assert.equal(integrated.status, "MERGED");
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), task.latest_task_commit_sha);
  assert.equal(task.base_commit_sha, movedBaseSha);
  assert.deepEqual(state.db.prepare("SELECT workflow_state, resolution FROM tasks WHERE id = 't'").get(),
    { workflow_state: "DONE", resolution: "MERGED" });
});

test("a second base movement after fresh Validation drops approval and requires a new decision", async (t) => {
  let state;
  const validationStart = async () => ({ run_id: "fresh-validation", status: "QUEUED" });
  state = await setup(t, { validationStart });
  const preview = await state.manager.preview("t");
  writeFileSync(join(state.repo, "base-once.txt"), "first movement\n");
  git(state.repo, "add", "base-once.txt");
  git(state.repo, "commit", "-m", "move base once");
  const onceSha = git(state.repo, "rev-parse", "HEAD");
  const queued = await state.manager.start("t", { confirmed: true, preview_id: preview.preview_id });
  assert.equal(queued.status, "VALIDATION_QUEUED");
  const syncedTask = state.db.prepare("SELECT base_commit_sha, latest_task_commit_sha FROM tasks WHERE id = 't'").get();
  const validatedAt = new Date().toISOString();
  state.db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('fresh-validation', 't', 'VALIDATION_REVIEW', 2, 'COMPLETED')`).run();
  state.db.prepare(`INSERT INTO validation_results (id, task_id, run_id, result, findings_json, created_at)
    VALUES ('fresh-result', 't', 'fresh-validation', 'PASSED', '[]', ?)`).run(validatedAt);
  state.db.prepare(`INSERT INTO validation_snapshots (id, task_id, validation_run_id, validated_task_sha,
    validated_base_sha, messages_watermark, result, created_at)
    VALUES ('fresh-snapshot', 't', 'fresh-validation', ?, ?, '0', 'PASSED', ?)`)
    .run(syncedTask.latest_task_commit_sha, syncedTask.base_commit_sha, validatedAt);
  state.db.prepare(`UPDATE tasks SET review_tag = 'READY_TO_MERGE', active_validation_snapshot_id = 'fresh-snapshot'
    WHERE id = 't'`).run();
  writeFileSync(join(state.repo, "base-twice.txt"), "second movement\n");
  git(state.repo, "add", "base-twice.txt");
  git(state.repo, "commit", "-m", "move base twice");
  const twiceSha = git(state.repo, "rev-parse", "HEAD");

  const finalized = await state.manager.onValidationCompleted(queued.merge_attempt_id, "fresh-validation");
  assert.equal(finalized.status, "REAPPROVAL_REQUIRED");
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), twiceSha,
    "a second movement is not overwritten by the pending approval");
  assert.notEqual(twiceSha, onceSha);
  assert.equal(state.db.prepare("SELECT approval_status FROM merge_attempts WHERE id = ?").get(queued.merge_attempt_id).approval_status, "REVOKED");
});

test("manual conflict resolution must be committed as a new checkpoint before fresh Validation and approval", async (t) => {
  const state = await setup(t);
  writeFileSync(join(state.repo, "shared.txt"), "base conflict\n");
  git(state.repo, "add", "shared.txt");
  git(state.repo, "commit", "-m", "conflicting base change");
  const conflict = await state.manager.start("t", { confirmed: true });
  assert.equal(conflict.status, "MERGE_CONFLICT");
  await assert.rejects(state.manager.retry("t"), /resolve|checkpoint|conflict/i);

  writeFileSync(join(state.worktreePath, "shared.txt"), "manually resolved content\n");
  git(state.worktreePath, "add", "shared.txt");
  git(state.worktreePath, "commit", "-m", "manually resolve conflict");
  const resolvedHead = git(state.worktreePath, "rev-parse", "HEAD");
  const retried = await state.manager.retry("t");
  assert.equal(retried.status, "VALIDATION_QUEUED");
  assert.equal(state.db.prepare("SELECT latest_task_commit_sha FROM tasks WHERE id = 't'").get().latest_task_commit_sha, resolvedHead);
  assert.equal(state.db.prepare("SELECT active_validation_snapshot_id FROM tasks WHERE id = 't'").get().active_validation_snapshot_id, null);
  assert.equal(state.db.prepare("SELECT approval_status FROM merge_attempts WHERE id = ?").get(conflict.merge_attempt_id).approval_status, "REVOKED");
  assert.equal(state.validationCalls.length, 1, "manual resolution needs a fresh Validation before a new merge approval");
});

test("merge success is retained when cleanup fails and the clean worktree remains available for retry", async (t) => {
  const state = await setup(t, { failCleanup: true });
  const result = await state.manager.start("t", { confirmed: true });
  assert.equal(result.status, "MERGED_CLEANUP_PENDING");
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), state.candidateSha);
  assert.deepEqual(state.db.prepare("SELECT workflow_state, resolution, cleanup_status, worktree_path FROM tasks WHERE id = 't'").get(), {
    workflow_state: "DONE", resolution: "MERGED", cleanup_status: "CLEANUP_PENDING", worktree_path: state.worktreePath,
  });
  assert.equal(existsSync(state.worktreePath), true);
  const restarted = new MergeManager({ db: state.db, worktrees: state.baseWorktrees,
    operations: new TaskOperationCoordinator(), validation: state.validation });
  await restarted.reconcileAfterRestart();
  assert.equal(existsSync(state.worktreePath), false, "restart may retry cleanup after verifying the worktree is clean");
  assert.equal(state.db.prepare("SELECT worktree_path, cleanup_status FROM tasks WHERE id = 't'").get().worktree_path, null);
});

test("base sync conflict preserves MERGE_HEAD and user edits, marks conflict, and clears approval", async (t) => {
  const state = await setup(t);
  writeFileSync(join(state.repo, "shared.txt"), "base conflict\n");
  git(state.repo, "add", "shared.txt");
  git(state.repo, "commit", "-m", "conflicting base change");
  const taskEdit = readFileSync(join(state.worktreePath, "shared.txt"), "utf8");

  const result = await state.manager.start("t", { confirmed: true });
  assert.equal(result.status, "MERGE_CONFLICT");
  assert.notEqual(git(state.worktreePath, "ls-files", "-u"), "", "unmerged index entries remain for manual resolution");
  assert.match(readFileSync(join(state.worktreePath, "shared.txt"), "utf8"), /<<<<<<<|=======|>>>>>>>/);
  assert.notEqual(readFileSync(join(state.worktreePath, "shared.txt"), "utf8"), taskEdit,
    "conflict markers are retained for manual resolution, not overwritten");
  const task = state.db.prepare("SELECT review_tag, workflow_state FROM tasks WHERE id = 't'").get();
  assert.deepEqual(task, { review_tag: "MERGE_CONFLICT", workflow_state: "REVIEW" });
  const attempt = state.db.prepare("SELECT id, approval_status FROM merge_attempts WHERE task_id = 't'").get();
  assert.equal(attempt.approval_status, "REVOKED");
  assert.notEqual(git(state.repo, "rev-parse", "refs/heads/main"), state.candidateSha);
  await state.manager.reconcileAfterRestart();
  assert.notEqual(git(state.worktreePath, "ls-files", "-u"), "", "restart must preserve conflict markers for manual recovery");
  await assert.rejects(state.manager.retry("t"), /resolve|commit|conflict/i);
  assert.notEqual(git(state.worktreePath, "ls-files", "-u"), "", "Retry cannot repeat a conflict operation");
  await assert.rejects(state.manager.viewConflicts("t"), /IDE|configure/i);
  assert.notEqual(git(state.worktreePath, "ls-files", "-u"), "", "failed IDE launch must leave conflict state intact");
  writeFileSync(join(state.worktreePath, "manual-note.txt"), "preserve during abort\n");
  const aborted = await state.manager.abort("t");
  assert.equal(aborted.status, "ABORTED");
  assert.equal(git(state.worktreePath, "ls-files", "-u"), "");
  assert.match(readFileSync(join(state.worktreePath, "shared.txt"), "utf8"), /^task change\r?\n$/);
  assert.equal(readFileSync(join(state.worktreePath, "manual-note.txt"), "utf8"), "preserve during abort\n");
  assert.equal(state.db.prepare("SELECT approval_status FROM merge_attempts WHERE id = ?").get(attempt.id).approval_status, "REVOKED");
});
