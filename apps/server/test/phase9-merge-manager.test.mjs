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
  const rawStart = manager.start.bind(manager);
  manager.start = async (taskId, options) => {
    if (options.confirmed && !options.preview_id) {
      options = { ...options, preview_id: (await manager.preview(taskId)).preview_id };
    }
    return rawStart(taskId, options);
  };
  t.after(() => {
    db.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { db, repo, baseSha, candidateSha, worktreePath, baseWorktrees: worktrees, worktrees: mergeWorktrees,
    manager, operations, validation, validationCalls };
}

test("a current Git sync check requires explicit approval before fast-forwarding as MERGED", async (t) => {
  const state = await setup(t);
  const before = git(state.repo, "rev-parse", "refs/heads/main");
  await assert.rejects(state.manager.start("t", { confirmed: false }), /confirm|approval/i);
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), before, "declined merge must not move the base ref");

  const result = await state.manager.start("t", { confirmed: true });
  assert.equal(result.status, "MERGED");
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), state.candidateSha);
  const task = state.db.prepare("SELECT workflow_state, resolution FROM tasks WHERE id = 't'").get();
  assert.deepEqual(task, { workflow_state: "DONE", resolution: "MERGED" });
  const attempt = state.db.prepare("SELECT approval_status, status, validated_base_sha, validated_task_sha, validation_snapshot_id FROM merge_attempts WHERE task_id = 't'").get();
  assert.deepEqual(attempt, { approval_status: "APPROVED", status: "COMPLETED", validated_base_sha: state.baseSha,
    validated_task_sha: state.candidateSha, validation_snapshot_id: null });
  assert.equal(git(state.repo, "show-ref", "--verify", "refs/heads/agent/task-t").split(" ")[0], state.candidateSha,
    "successful merge preserves the task branch");
  assert.equal(attempt.validation_snapshot_id, null, "merge records no Validation snapshot dependency");
  assert.equal(state.validationCalls.length, 0, "merge never starts automated Validation");
});

test("a current Git sync check, not an active Validation snapshot, gates merge-back", async (t) => {
  const state = await setup(t);
  assert.equal(typeof state.manager.checkSync, "function",
    "merge readiness needs an explicit Git-only Check sync operation");
  const sync = await state.manager.checkSync("t");
  assert.equal(sync.in_sync, true);

  // Retain the historical Validation rows, but ensure they are not a merge prerequisite.
  state.db.prepare("UPDATE tasks SET active_validation_snapshot_id = NULL, review_tag = 'IMPLEMENTATION_COMPLETE' WHERE id = 't'").run();
  const preview = await state.manager.preview("t");
  assert.equal(preview.eligible, true);
  assert.equal("validation_snapshot_id" in preview, false);
  const result = await state.manager.start("t", { confirmed: true });
  assert.equal(result.status, "MERGED");
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), state.candidateSha);
  assert.equal(state.validationCalls.length, 0);
});

test("Check sync is a read-only Git ancestry check and creates no Validation run or snapshot", async (t) => {
  const state = await setup(t);
  const before = {
    task: state.db.prepare("SELECT base_commit_sha, latest_task_commit_sha, active_validation_snapshot_id FROM tasks WHERE id = 't'").get(),
    runs: state.db.prepare("SELECT COUNT(*) AS count FROM task_runs WHERE task_id = 't'").get().count,
    validations: state.db.prepare("SELECT COUNT(*) AS count FROM validation_results WHERE task_id = 't'").get().count,
    snapshots: state.db.prepare("SELECT COUNT(*) AS count FROM validation_snapshots WHERE task_id = 't'").get().count,
  };
  const check = await state.manager.checkSync("t");
  assert.equal(check.status, "IN_SYNC");
  assert.equal(check.in_sync, true);
  assert.equal(check.base_sha, state.baseSha);
  assert.equal(check.task_sha, state.candidateSha);
  assert.equal(check.base_moved, false);
  assert.ok(check.checked_at);
  assert.deepEqual({
    task: state.db.prepare("SELECT base_commit_sha, latest_task_commit_sha, active_validation_snapshot_id FROM tasks WHERE id = 't'").get(),
    runs: state.db.prepare("SELECT COUNT(*) AS count FROM task_runs WHERE task_id = 't'").get().count,
    validations: state.db.prepare("SELECT COUNT(*) AS count FROM validation_results WHERE task_id = 't'").get().count,
    snapshots: state.db.prepare("SELECT COUNT(*) AS count FROM validation_snapshots WHERE task_id = 't'").get().count,
  }, before);
  assert.equal(state.validationCalls.length, 0);
  const release = state.operations.tryAcquire("t");
  assert.equal(typeof release, "function", "read-only check releases its task operation lock");
  release();
});

test("a base that advances after a passing Check sync is stale until the task is synced", async (t) => {
  const state = await setup(t);
  const firstCheck = await state.manager.checkSync("t");
  assert.equal(firstCheck.status, "IN_SYNC");
  writeFileSync(join(state.repo, "main-only.txt"), "base moved after task checkpoint\n");
  git(state.repo, "add", "main-only.txt"); git(state.repo, "commit", "-m", "advance base after check");
  const currentBase = git(state.repo, "rev-parse", "HEAD");
  const check = await state.manager.checkSync("t");
  assert.equal(check.status, "STALE");
  assert.equal(check.in_sync, false);
  assert.equal(check.base_moved, true);
  assert.equal(check.recorded_base_sha, state.baseSha);
  assert.equal(check.base_sha, currentBase);
  assert.match(check.reasons.join(" "), /sync with main|current base/i);
});

test("Check sync blocks a dirty or unexpected task worktree without Git or database changes", async (t) => {
  const state = await setup(t);
  writeFileSync(join(state.worktreePath, "uncommitted.txt"), "preserve me\n");
  const dirty = await state.manager.checkSync("t");
  assert.equal(dirty.status, "BLOCKED");
  assert.equal(dirty.in_sync, false);
  assert.match(dirty.reasons.join(" "), /dirty|uncommitted/i);
  assert.equal(git(state.worktreePath, "rev-parse", "HEAD"), state.candidateSha);
  assert.equal(readFileSync(join(state.worktreePath, "uncommitted.txt"), "utf8"), "preserve me\n");
  git(state.worktreePath, "checkout", "--detach", state.candidateSha);
  const wrongBranch = await state.manager.checkSync("t");
  assert.equal(wrongBranch.status, "BLOCKED");
  assert.match(wrongBranch.reasons.join(" "), /branch/i);
});

test("Check sync reports Git ancestry errors as blocked, not stale", async (t) => {
  const state = await setup(t);
  state.worktrees.isBaseAncestorOfTask = async () => { throw new Error("corrupt or unavailable Git object"); };
  const check = await state.manager.checkSync("t");
  assert.equal(check.status, "BLOCKED");
  assert.equal(check.in_sync, false);
  assert.match(check.reasons.join(" "), /unable to verify.*corrupt or unavailable/i);
});

test("Check sync blocks an active task operation and persisted sync recovery", async (t) => {
  const state = await setup(t);
  const release = state.operations.tryAcquire("t");
  assert.equal(typeof release, "function");
  const busy = await state.manager.checkSync("t");
  assert.equal(busy.status, "BLOCKED");
  assert.match(busy.reasons.join(" "), /operation is active/i);
  release();

  const taskBranch = git(state.worktreePath, "branch", "--show-current");
  state.db.prepare(`INSERT INTO git_sync_attempts (id, task_id, status, base_sha, prior_base_sha, base_branch,
    task_branch, prior_task_sha, prior_task_recorded_sha, started_at)
    VALUES ('sync-recovery', 't', 'CONFLICT', ?, ?, 'main', ?, ?, ?, ?)`)
    .run(state.baseSha, state.baseSha, taskBranch, state.candidateSha, state.candidateSha, new Date().toISOString());
  const recovery = await state.manager.checkSync("t");
  assert.equal(recovery.status, "BLOCKED");
  assert.match(recovery.reasons.join(" "), /sync recovery/i);
});

test("Check sync classifies an in-progress Git merge as blocked", async (t) => {
  const state = await setup(t);
  writeFileSync(join(state.repo, "shared.txt"), "base conflict\n");
  git(state.repo, "add", "shared.txt"); git(state.repo, "commit", "-m", "conflicting base update");
  const currentBase = git(state.repo, "rev-parse", "HEAD");
  let mergeFailed = false;
  try { git(state.worktreePath, "merge", "--no-edit", currentBase); }
  catch { mergeFailed = true; }
  assert.equal(mergeFailed, true);
  const check = await state.manager.checkSync("t");
  assert.equal(check.status, "BLOCKED");
  assert.match(check.reasons.join(" "), /git.*progress|conflict/i);
  assert.notEqual(git(state.worktreePath, "ls-files", "-u"), "");
});

test("historical Validation snapshot state does not gate a current Git-synchronized merge", async (t) => {
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
      assert.equal(preview.eligible, true);
      const result = await state.manager.start("t", { confirmed: true });
      assert.equal(result.status, "MERGED");
      assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), state.candidateSha);
      assert.equal(state.validationCalls.length, 0);
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
  const preview = await state.manager.preview("t");
  git(state.worktreePath, "commit", "--allow-empty", "-m", "move task branch after preview");
  await assert.rejects(state.manager.start("t", { confirmed: true, preview_id: preview.preview_id }), /head|candidate|checkpoint|branch/i);
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

test("new delivered guidance does not replace the current Git sync readiness check", async (t) => {
  const state = await setup(t);
  const now = new Date().toISOString();
  state.db.prepare("INSERT INTO task_runs (id, task_id, stage, sequence, status) VALUES ('impl-run', 't', 'IMPLEMENTATION', 2, 'COMPLETED')").run();
  state.db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content,
    delivery_type, delivery_status, accepted_at, delivered_at) VALUES ('new-guidance', 't', 'impl-run', 1,
    'new-guidance-key', 'Please also update the license.', 'STEERING', 'DELIVERED', ?, ?)`)
    .run(now, now);
  const preview = await state.manager.preview("t");
  assert.equal(preview.eligible, true);
  const result = await state.manager.start("t", { confirmed: true });
  assert.equal(result.status, "MERGED");
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), state.candidateSha);
  assert.equal(state.validationCalls.length, 0);
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

test("base movement after merge preview blocks integration until explicit Sync with main", async (t) => {
  const state = await setup(t);
  const preview = await state.manager.preview("t");
  assert.equal(preview.eligible, true);
  writeFileSync(join(state.repo, "base-only.txt"), "new base\n");
  git(state.repo, "add", "base-only.txt");
  git(state.repo, "commit", "-m", "move base after Check sync");
  const movedBase = git(state.repo, "rev-parse", "HEAD");

  await assert.rejects(state.manager.start("t", { confirmed: true, preview_id: preview.preview_id }),
    /base.*moved|sync with main|stale/i);
  assert.equal(git(state.repo, "rev-parse", "refs/heads/main"), movedBase,
    "merge refusal must preserve the new base ref");
  assert.equal(git(state.worktreePath, "rev-parse", "HEAD"), state.candidateSha,
    "merge refusal must not sync or modify the task branch");
  assert.equal(state.db.prepare("SELECT base_commit_sha FROM tasks WHERE id = 't'").get().base_commit_sha, state.baseSha);
  assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM merge_attempts WHERE task_id = 't'").get().count, 0);
  assert.equal(state.validationCalls.length, 0, "a moved base never queues automatic Validation");
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
