import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { openDatabase } from "../dist/db.js";
import { registerTaskRoutes } from "../dist/tasks.js";
import { registerQueueRoutes } from "../dist/queue/queue-routes.js";
import { TaskOperationCoordinator } from "../dist/task-operation-coordinator.js";
import { WorktreeManager } from "../dist/git/worktree-manager.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function confirmation(preview, includeUntrackedFiles = preview.untracked_files) {
  return {
    tracked_changes: preview.tracked_changes,
    include_untracked_files: includeUntrackedFiles,
    branch: preview.branch,
    commit_sha: preview.commit_sha,
    state_token: preview.state_token,
  };
}

test("checkpoint API requires the exact untracked-file approval and persists the checkpoint SHA", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "kanban-checkpoint-api-"));
  const repo = join(temp, "repo");
  const worktreeRoot = join(temp, "worktrees");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Checkpoint API Test");
  git(repo, "config", "user.email", "checkpoint-api@example.invalid");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");

  const db = openDatabase(join(temp, "app.sqlite"));
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, worktree_root, created_at, updated_at)
    VALUES ('p', 'Project', ?, ?, ?, ?)`).run(repo, worktreeRoot, now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, review_tag, created_at, updated_at)
    VALUES ('t', 'p', 'Task', '', 'REVIEW', 'IMPLEMENTATION_COMPLETE', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('run-1', 't', 'IMPLEMENTATION', 1, 'COMPLETED')`).run();
  const worktrees = new WorktreeManager(db);
  let worktreePath;
  const app = Fastify();
  registerTaskRoutes(app, db, worktrees);
  t.after(async () => {
    await app.close();
    if (worktreePath) {
      try { git(repo, "worktree", "remove", "--force", worktreePath); } catch {}
    }
    db.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  worktreePath = (await worktrees.createTaskWorktree("t")).worktreePath;
  db.prepare("UPDATE tasks SET review_tag = 'VALIDATION_FAILED' WHERE id = 't'").run();
  const retryPreview = await app.inject({ method: "GET", url: "/api/tasks/t/checkpoint-preview" });
  assert.equal(retryPreview.statusCode, 200, "failed validation may inspect the worktree before retrying");
  const retryCheckpoint = await app.inject({ method: "POST", url: "/api/tasks/t/checkpoint", payload: confirmation(retryPreview.json()) });
  assert.equal(retryCheckpoint.statusCode, 409, "failed validation preview must not authorize a checkpoint");
  db.prepare("UPDATE tasks SET review_tag = 'IMPLEMENTATION_COMPLETE' WHERE id = 't'").run();
  writeFileSync(join(worktreePath, "new.txt"), "new file\n");
  const preview = await app.inject({ method: "GET", url: "/api/tasks/t/checkpoint-preview" });
  assert.equal(preview.statusCode, 200);
  assert.deepEqual(preview.json().untracked_files, ["new.txt"]);
  assert.match(preview.json().diff, /new file/,
    "review preview must include the uncheckpointed patch, including untracked file contents");

  const declined = await app.inject({ method: "POST", url: "/api/tasks/t/checkpoint", payload: confirmation(preview.json(), []) });
  assert.equal(declined.statusCode, 409);
  assert.deepEqual(declined.json().untracked_files, ["new.txt"]);
  assert.equal(db.prepare("SELECT latest_task_commit_sha FROM tasks WHERE id = 't'").get().latest_task_commit_sha, null);
  assert.equal(db.prepare("SELECT workflow_state FROM tasks WHERE id = 't'").get().workflow_state, "REVIEW");
  assert.equal(git(worktreePath, "status", "--porcelain"), "?? new.txt");
  writeFileSync(join(worktreePath, "new.txt"), "changed after preview\n");
  const staleContents = await app.inject({ method: "POST", url: "/api/tasks/t/checkpoint", payload: confirmation(preview.json()) });
  assert.equal(staleContents.statusCode, 409);
  assert.match(staleContents.json().error, /Git state changed/);
  writeFileSync(join(worktreePath, "appeared-after-preview.txt"), "late file\n");
  const staleApproval = await app.inject({ method: "POST", url: "/api/tasks/t/checkpoint", payload: confirmation(preview.json()) });
  assert.equal(staleApproval.statusCode, 409);
  assert.deepEqual(staleApproval.json().untracked_files, ["appeared-after-preview.txt", "new.txt"]);
  assert.equal(git(worktreePath, "status", "--porcelain"), "?? appeared-after-preview.txt\n?? new.txt");
  const freshPreview = await app.inject({ method: "GET", url: "/api/tasks/t/checkpoint-preview" });

  const confirmed = await app.inject({
    method: "POST", url: "/api/tasks/t/checkpoint", payload: confirmation(freshPreview.json()),
  });
  assert.equal(confirmed.statusCode, 200);
  const sha = confirmed.json().commit_sha;
  assert.equal(db.prepare("SELECT latest_task_commit_sha FROM tasks WHERE id = 't'").get().latest_task_commit_sha, sha);
  assert.equal(db.prepare("SELECT task_commit_sha FROM task_runs WHERE id = 'run-1'").get().task_commit_sha, sha);
  assert.equal(db.prepare("SELECT workflow_state, review_tag FROM tasks WHERE id = 't'").get().workflow_state, "REVIEW");
  const duplicate = await app.inject({ method: "POST", url: "/api/tasks/t/checkpoint", payload: confirmation(freshPreview.json()) });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(git(worktreePath, "rev-parse", "HEAD"), sha);
  assert.deepEqual(git(worktreePath, "show", "--pretty=format:", "--name-only").trim().split("\n").sort(), ["appeared-after-preview.txt", "new.txt"]);
  assert.equal(git(repo, "status", "--porcelain"), "");

  git(worktreePath, "commit", "--allow-empty", "-m", "move task branch after checkpoint");
  const movedBranchDiff = await app.inject({ method: "GET", url: "/api/tasks/t/checkpoint-diff" });
  assert.equal(movedBranchDiff.json().to_sha, sha, "later branch movement must not retarget the saved diff");
  writeFileSync(join(worktreePath, "new.txt"), "later uncommitted edit\n");
  const diff = await app.inject({ method: "GET", url: "/api/tasks/t/checkpoint-diff" });
  assert.equal(diff.statusCode, 200);
  assert.equal(diff.json().from_sha, db.prepare("SELECT base_commit_sha FROM tasks WHERE id = 't'").get().base_commit_sha);
  assert.equal(diff.json().to_sha, sha);
  assert.deepEqual(diff.json().files, ["appeared-after-preview.txt", "new.txt"]);
  assert.match(diff.json().diff, /new file/);
  assert.doesNotMatch(diff.json().diff, /later uncommitted edit/);

  const unusualName = "odd café [tag] file.txt";
  writeFileSync(join(worktreePath, unusualName), "unusual path\n");
  const unusualPreview = await app.inject({ method: "GET", url: "/api/tasks/t/checkpoint-preview" });
  const unusualCommit = await app.inject({ method: "POST", url: "/api/tasks/t/checkpoint", payload: confirmation(unusualPreview.json()) });
  assert.equal(unusualCommit.statusCode, 200);
  const unusualDiff = await app.inject({ method: "GET", url: "/api/tasks/t/checkpoint-diff" });
  assert.equal(unusualDiff.statusCode, 200);
  assert.ok(unusualDiff.json().files.includes(unusualName));
  assert.match(unusualDiff.json().diff, /unusual path/);

  const largeName = "large-patch.txt";
  writeFileSync(join(worktreePath, largeName), "large line\n".repeat(6000));
  writeFileSync(join(worktreePath, "binary-content.bin"), Buffer.from([0, 1, 2, 3, 255]));
  const contentPreview = await app.inject({ method: "GET", url: "/api/tasks/t/checkpoint-preview" });
  const contentCommit = await app.inject({ method: "POST", url: "/api/tasks/t/checkpoint", payload: confirmation(contentPreview.json()) });
  assert.equal(contentCommit.statusCode, 200);
  const contentDiff = await app.inject({ method: "GET", url: "/api/tasks/t/checkpoint-diff" });
  assert.equal(contentDiff.statusCode, 200);
  assert.ok(contentDiff.json().files.includes(largeName));
  assert.ok(contentDiff.json().diff.length > 50_000, "large checkpoint patches are returned without truncation");
  assert.match(contentDiff.json().diff, /Binary files .* differ/);

  const emptySha = db.prepare("SELECT base_commit_sha FROM tasks WHERE id = 't'").get().base_commit_sha;
  db.prepare("UPDATE tasks SET latest_task_commit_sha = ? WHERE id = 't'").run(emptySha);
  const emptyDiff = await app.inject({ method: "GET", url: "/api/tasks/t/checkpoint-diff" });
  assert.equal(emptyDiff.statusCode, 200);
  assert.deepEqual(emptyDiff.json().files, []);
  assert.equal(emptyDiff.json().diff, "");
  const headBeforeInvalid = git(worktreePath, "rev-parse", "HEAD");
  const statusBeforeInvalid = git(worktreePath, "status", "--porcelain");
  db.prepare("UPDATE tasks SET latest_task_commit_sha = ? WHERE id = 't'").run("f".repeat(40));
  const missingObject = await app.inject({ method: "GET", url: "/api/tasks/t/checkpoint-diff" });
  assert.equal(missingObject.statusCode, 409);
  assert.match(missingObject.json().error, /diff|commit|object/i);
  assert.equal(git(worktreePath, "rev-parse", "HEAD"), headBeforeInvalid);
  assert.equal(git(worktreePath, "status", "--porcelain"), statusBeforeInvalid);
  db.prepare("UPDATE tasks SET latest_task_commit_sha = 'not-a-sha' WHERE id = 't'").run();
  const invalidSha = await app.inject({ method: "GET", url: "/api/tasks/t/checkpoint-diff" });
  assert.equal(invalidSha.statusCode, 409);
  assert.match(invalidSha.json().error, /SHA|commit|diff/i);
  assert.equal(git(worktreePath, "rev-parse", "HEAD"), headBeforeInvalid);
  assert.equal(git(worktreePath, "status", "--porcelain"), statusBeforeInvalid);
});

test("checkpoint lock rejects concurrent start and delete operations for the same task", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "kanban-checkpoint-lock-"));
  const repo = join(temp, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Checkpoint lock test");
  git(repo, "config", "user.email", "checkpoint-lock@example.invalid");
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-m", "base");
  const db = openDatabase(join(temp, "app.sqlite"));
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, worktree_root, created_at, updated_at)
    VALUES ('p', 'Project', ?, ?, ?, ?)`).run(repo, join(temp, "worktrees"), now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, review_tag, created_at, updated_at)
    VALUES ('t', 'p', 'Task', '', 'REVIEW', 'IMPLEMENTATION_COMPLETE', ?, ?)`).run(now, now);
  const worktrees = new WorktreeManager(db);
  const operations = new TaskOperationCoordinator();
  const app = Fastify();
  registerTaskRoutes(app, db, worktrees, operations);
  registerQueueRoutes(app, {
    enqueueTask: () => ({ job_id: "job", run_id: "run", queue_position: 1, created: true }),
    getSnapshot: () => ({ jobs: [], max_concurrent_agents: 1, active_count: 0 }),
    stopRun() {}, reorder() {}, remove() {},
  }, operations);
  t.after(async () => {
    await app.close();
    db.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const worktreePath = (await worktrees.createTaskWorktree("t")).worktreePath;
  writeFileSync(join(worktreePath, "tracked.txt"), "changed\n");
  const preview = await app.inject({ method: "GET", url: "/api/tasks/t/checkpoint-preview" });
  let enterPreview;
  const entered = new Promise((resolve) => { enterPreview = resolve; });
  let unblockPreview;
  const blocked = new Promise((resolve) => { unblockPreview = resolve; });
  const originalPreview = worktrees.previewCheckpoint.bind(worktrees);
  worktrees.previewCheckpoint = async (taskId) => {
    const result = await originalPreview(taskId);
    enterPreview();
    await blocked;
    return result;
  };
  const checkpoint = app.inject({ method: "POST", url: "/api/tasks/t/checkpoint", payload: confirmation(preview.json()) });
  await entered;
  const [start, deletion, duplicate] = await Promise.all([
    app.inject({ method: "POST", url: "/api/tasks/t/queue", payload: {
      task_id: "t", prompt: "continue", idempotency_key: "start-during-checkpoint",
    } }),
    app.inject({ method: "DELETE", url: "/api/tasks/t" }),
    app.inject({ method: "POST", url: "/api/tasks/t/checkpoint", payload: confirmation(preview.json()) }),
  ]);
  assert.equal(start.statusCode, 409);
  assert.equal(deletion.statusCode, 409);
  assert.equal(duplicate.statusCode, 409);
  assert.equal(db.prepare("SELECT is_active FROM tasks WHERE id = 't'").get().is_active, 1);
  unblockPreview();
  const committed = await checkpoint;
  assert.equal(committed.statusCode, 200);
});

test("checkpoint rejects a changed task branch and an in-progress Git operation", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "kanban-checkpoint-git-state-"));
  const repo = join(temp, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Checkpoint safety test");
  git(repo, "config", "user.email", "checkpoint-safety@example.invalid");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");

  const db = openDatabase(join(temp, "app.sqlite"));
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, worktree_root, created_at, updated_at)
    VALUES ('p', 'Project', ?, ?, ?, ?)`).run(repo, join(temp, "worktrees"), now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, review_tag, created_at, updated_at)
    VALUES ('t', 'p', 'Task', '', 'REVIEW', 'IMPLEMENTATION_COMPLETE', ?, ?)`).run(now, now);
  const worktrees = new WorktreeManager(db);
  let worktreePath;
  const app = Fastify();
  registerTaskRoutes(app, db, worktrees);
  t.after(async () => {
    await app.close();
    db.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  worktreePath = (await worktrees.createTaskWorktree("t")).worktreePath;
  writeFileSync(join(worktreePath, "new.txt"), "new file\n");
  const preview = await app.inject({ method: "GET", url: "/api/tasks/t/checkpoint-preview" });
  git(worktreePath, "checkout", "-b", "unexpected-branch");
  const changedBranch = await app.inject({ method: "POST", url: "/api/tasks/t/checkpoint", payload: confirmation(preview.json()) });
  assert.equal(changedBranch.statusCode, 409);
  assert.match(changedBranch.json().error, /branch/i);
  assert.equal(git(worktreePath, "status", "--porcelain"), "?? new.txt");

  git(worktreePath, "checkout", "agent/task-t");
  const mergeHead = git(worktreePath, "rev-parse", "--git-path", "MERGE_HEAD");
  writeFileSync(isAbsolute(mergeHead) ? mergeHead : resolve(worktreePath, mergeHead), `${git(repo, "rev-parse", "HEAD")}\n`);
  const operationInProgress = await app.inject({ method: "POST", url: "/api/tasks/t/checkpoint", payload: confirmation(preview.json()) });
  assert.equal(operationInProgress.statusCode, 409);
  assert.match(operationInProgress.json().error, /merge/i);
  assert.equal(git(worktreePath, "status", "--porcelain"), "?? new.txt");
});
