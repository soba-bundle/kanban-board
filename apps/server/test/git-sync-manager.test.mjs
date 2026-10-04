import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../dist/db.js";
import { TaskOperationCoordinator } from "../dist/task-operation-coordinator.js";
import { WorktreeManager } from "../dist/git/worktree-manager.js";

let GitSyncManager;
let importError;
try { ({ GitSyncManager } = await import("../dist/agents/git-sync-manager.js")); }
catch (error) { importError = error; }

function requireManager() {
  assert.equal(typeof GitSyncManager, "function",
    `Expected a GitSyncManager for Sync with main / Check sync; ${importError?.message ?? "export is missing"}`);
}
function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

async function setup(t, withCheckpoint = true) {
  requireManager();
  const dir = mkdtempSync(join(tmpdir(), "kanban-git-sync-"));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Git Sync Test");
  git(repo, "config", "user.email", "git-sync@example.invalid");
  writeFileSync(join(repo, "shared.txt"), "base\n");
  git(repo, "add", "shared.txt"); git(repo, "commit", "-m", "base");
  const initialBase = git(repo, "rev-parse", "HEAD");
  const db = openDatabase(join(dir, "app.sqlite"));
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, worktree_root, created_at, updated_at)
    VALUES ('p', 'Project', ?, ?, ?, ?)`).run(repo, join(dir, "worktrees"), now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, review_tag, created_at, updated_at)
    VALUES ('t', 'p', 'Task', '', 'REVIEW', 'IMPLEMENTATION_COMPLETE', ?, ?)`).run(now, now);
  const worktrees = new WorktreeManager(db);
  const taskPath = (await worktrees.createTaskWorktree("t")).worktreePath;
  let candidate = null;
  if (withCheckpoint) {
    writeFileSync(join(taskPath, "shared.txt"), "task version\n");
    candidate = await worktrees.createCheckpoint("t");
    db.prepare("UPDATE tasks SET latest_task_commit_sha = ? WHERE id = 't'").run(candidate);
  }
  const operations = new TaskOperationCoordinator();
  const manager = new GitSyncManager({ db, worktrees, operations });
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { db, dir, repo, taskPath, manager, operations, worktrees, initialBase, candidate };
}

async function setupConflict(t) {
  const state = await setup(t);
  writeFileSync(join(state.repo, "shared.txt"), "main version\n");
  git(state.repo, "add", "shared.txt"); git(state.repo, "commit", "-m", "conflicting main update");
  const result = await state.manager.syncWithBase("t");
  assert.equal(result.status, "CONFLICT");
  return { ...state, result };
}

test("Sync with main merges the captured base, persists both SHAs, and leaves primary checkout untouched", async (t) => {
  const state = await setup(t);
  writeFileSync(join(state.repo, "main-only.txt"), "new base content\n");
  git(state.repo, "add", "main-only.txt"); git(state.repo, "commit", "-m", "advance main");
  const currentBase = git(state.repo, "rev-parse", "HEAD");
  assert.notEqual(currentBase, state.initialBase);
  const primaryHead = currentBase;
  const primaryStatus = git(state.repo, "status", "--porcelain");
  const primaryIndexTree = git(state.repo, "write-tree");

  const synced = await state.manager.syncWithBase("t");
  assert.equal(synced.status, "SYNCED");
  assert.equal(synced.synced_base_sha, currentBase);
  assert.equal(synced.candidate_sha, git(state.taskPath, "rev-parse", "HEAD"));
  assert.equal(git(state.repo, "rev-parse", "HEAD"), primaryHead, "sync must not move the primary branch");
  assert.equal(git(state.repo, "status", "--porcelain"), primaryStatus, "sync must not modify the primary worktree");
  assert.equal(git(state.repo, "write-tree"), primaryIndexTree, "sync must not modify the primary index");
  assert.match(git(state.taskPath, "show", "HEAD:main-only.txt"), /new base content/);
  const task = state.db.prepare("SELECT base_commit_sha, latest_task_commit_sha FROM tasks WHERE id = 't'").get();
  assert.equal(task.base_commit_sha, currentBase);
  assert.equal(task.latest_task_commit_sha, synced.candidate_sha);
  assert.equal(git(state.taskPath, "merge-base", "--is-ancestor", currentBase, synced.candidate_sha), "", "captured base is an ancestor of the synchronized candidate");
});

test("sync works for a no-change task whose task commit has not been recorded yet", async (t) => {
  const state = await setup(t, false);
  writeFileSync(join(state.repo, "main-only.txt"), "base update\n");
  git(state.repo, "add", "main-only.txt"); git(state.repo, "commit", "-m", "advance main");
  const baseSha = git(state.repo, "rev-parse", "HEAD");
  const result = await state.manager.syncWithBase("t");
  assert.equal(result.status, "SYNCED");
  assert.equal(result.synced_base_sha, baseSha);
  const task = state.db.prepare("SELECT base_commit_sha, latest_task_commit_sha FROM tasks WHERE id = 't'").get();
  assert.equal(task.base_commit_sha, baseSha);
  assert.equal(task.latest_task_commit_sha, result.candidate_sha);
});

test("sync refuses dirty task worktrees without changing user files", async (t) => {
  const state = await setup(t);
  writeFileSync(join(state.taskPath, "uncommitted.txt"), "preserve this\n");
  await assert.rejects(state.manager.syncWithBase("t"), /dirty|uncommitted/i);
  assert.equal(readFileSync(join(state.taskPath, "uncommitted.txt"), "utf8"), "preserve this\n");
  assert.equal(git(state.taskPath, "rev-parse", "HEAD"), state.candidate);
});

test("sync refuses a task worktree checked out on the wrong branch", async (t) => {
  const state = await setup(t);
  git(state.taskPath, "checkout", "--detach", state.candidate);
  await assert.rejects(state.manager.syncWithBase("t"), /task branch changed/i);
  assert.equal(git(state.taskPath, "rev-parse", "HEAD"), state.candidate);
});

test("sync acquires the same task-operation lock used by checkpoint and merge", async (t) => {
  const state = await setup(t);
  const release = state.operations.tryAcquire("t");
  assert.ok(release);
  await assert.rejects(state.manager.syncWithBase("t"), /another operation/i);
  release();
});

test("sync conflicts stop for manual resolution and preserve Git conflict state", async (t) => {
  const state = await setupConflict(t);
  const result = state.result;
  assert.notEqual(git(state.taskPath, "ls-files", "-u"), "");
  assert.match(readFileSync(join(state.taskPath, "shared.txt"), "utf8"), /<<<<<<<|=======|>>>>>>>/);
  assert.equal(git(state.taskPath, "rev-parse", "HEAD"), state.candidate, "a conflict must not create a resolution commit");
  const task = state.db.prepare("SELECT base_commit_sha, latest_task_commit_sha FROM tasks WHERE id = 't'").get();
  assert.equal(task.base_commit_sha, state.initialBase);
  assert.equal(task.latest_task_commit_sha, state.candidate);
  await assert.rejects(state.manager.syncWithBase("t"), /active sync recovery/i,
    "a conflict remains unresolved; Sync cannot automatically retry or abort it");
});

test("sync conflict recovery survives manager restart and opens the task IDE explicitly", async (t) => {
  const state = await setupConflict(t);
  let openedTask = null;
  state.worktrees.openInIDE = async (taskId) => { openedTask = taskId; };
  const restarted = new GitSyncManager({ db: state.db, worktrees: state.worktrees, operations: new TaskOperationCoordinator() });
  const recovery = await restarted.getSyncRecovery("t");
  assert.equal(recovery.state, "CONFLICT");
  assert.equal(recovery.can_abort, true);
  assert.equal(recovery.base_sha, git(state.repo, "rev-parse", "HEAD"));
  assert.equal(recovery.prior_task_sha, state.candidate);
  await restarted.viewSyncConflicts("t");
  assert.equal(openedTask, "t");
  await assert.rejects(restarted.retrySync("t"), /resolve.*commit/i,
    "Retry cannot repeat an unresolved merge");
  assert.notEqual(git(state.taskPath, "ls-files", "-u"), "");
});

test("Abort sync only when the captured conflict worktree is unchanged", async (t) => {
  const state = await setupConflict(t);
  const originalHead = git(state.taskPath, "rev-parse", "HEAD");
  await assert.rejects(state.manager.abortSync("t", false), /confirmation/i);
  const aborted = await state.manager.abortSync("t", true);
  assert.equal(aborted.status, "ABORTED");
  assert.equal(git(state.taskPath, "rev-parse", "HEAD"), originalHead);
  assert.equal(git(state.taskPath, "status", "--porcelain"), "");
  assert.equal(await state.manager.getSyncRecovery("t"), null);
  const attempt = state.db.prepare("SELECT status FROM git_sync_attempts WHERE task_id = 't' ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(attempt.status, "ABORTED");
});

test("a crash before Git abort can resume only through explicit Abort confirmation", async (t) => {
  const state = await setupConflict(t);
  const attempt = state.db.prepare("SELECT * FROM git_sync_attempts WHERE task_id = 't' ORDER BY rowid DESC LIMIT 1").get();
  state.db.prepare("UPDATE git_sync_attempts SET status = 'ABORTING' WHERE id = ?").run(attempt.id);
  const restarted = new GitSyncManager({ db: state.db, worktrees: state.worktrees, operations: new TaskOperationCoordinator() });
  const recovery = await restarted.getSyncRecovery("t");
  assert.equal(recovery.state, "CONFLICT");
  assert.equal(recovery.can_abort, true);
  await restarted.abortSync("t", true);
  assert.equal(await restarted.getSyncRecovery("t"), null);
  assert.equal(git(state.taskPath, "status", "--porcelain"), "");
});

test("a crash after Git abort requires explicit recovery and cannot trigger a fresh merge", async (t) => {
  const state = await setupConflict(t);
  const attempt = state.db.prepare("SELECT * FROM git_sync_attempts WHERE task_id = 't' ORDER BY rowid DESC LIMIT 1").get();
  state.db.prepare("UPDATE git_sync_attempts SET status = 'ABORTING' WHERE id = ?").run(attempt.id);
  await state.worktrees.abortTaskSync("t", {
    expectedBranch: attempt.task_branch,
    expectedHead: attempt.prior_task_sha,
    stateToken: attempt.conflict_state_token,
  });
  const restarted = new GitSyncManager({ db: state.db, worktrees: state.worktrees, operations: new TaskOperationCoordinator() });
  const recovery = await restarted.getSyncRecovery("t");
  assert.equal(recovery.state, "INTERRUPTED");
  assert.equal(recovery.can_abort, true);
  await assert.rejects(restarted.retrySync("t"), /confirm Abort/i);
  await restarted.abortSync("t", true);
  assert.equal(await restarted.getSyncRecovery("t"), null);
  assert.equal(git(state.taskPath, "rev-parse", "HEAD"), state.candidate);
});

test("Abort sync refuses to discard edits made after the conflict snapshot", async (t) => {
  const state = await setupConflict(t);
  const file = join(state.taskPath, "shared.txt");
  const edited = readFileSync(file, "utf8") + "user resolution in progress\n";
  writeFileSync(file, edited);
  await assert.rejects(state.manager.abortSync("t", true), /changed|ambiguous/i);
  await assert.rejects(state.manager.retrySync("t"), /resolve and commit/i,
    "an unresolved conflict must never be replayed, even after edits to conflict files");
  assert.equal(readFileSync(file, "utf8"), edited);
  assert.notEqual(git(state.taskPath, "ls-files", "-u"), "");
});

test("an interrupted pre-merge attempt requires an explicit safe retry", async (t) => {
  const state = await setup(t);
  writeFileSync(join(state.repo, "main-only.txt"), "advance main\n");
  git(state.repo, "add", "main-only.txt"); git(state.repo, "commit", "-m", "advance main");
  const baseSha = git(state.repo, "rev-parse", "HEAD");
  const taskBranch = git(state.taskPath, "branch", "--show-current");
  state.db.prepare(`INSERT INTO git_sync_attempts (id, task_id, status, base_sha, prior_base_sha, base_branch,
    task_branch, prior_task_sha, prior_task_recorded_sha, started_at) VALUES
    ('interrupted', 't', 'PREPARED', ?, ?, 'main', ?, ?, ?, ?)`)
    .run(baseSha, state.initialBase, taskBranch, state.candidate, state.candidate, new Date().toISOString());
  const recovery = await state.manager.getSyncRecovery("t");
  assert.equal(recovery.state, "SAFE_TO_RETRY");
  assert.equal(git(state.taskPath, "rev-parse", "HEAD"), state.candidate,
    "inspection after restart must not automatically repeat the merge");
  const result = await state.manager.retrySync("t");
  assert.equal(result.status, "SYNCED");
  assert.equal(result.synced_base_sha, baseSha);
});

test("Retry finalizes a committed manual resolution without replaying the merge", async (t) => {
  const state = await setupConflict(t);
  writeFileSync(join(state.taskPath, "shared.txt"), "manually resolved\n");
  git(state.taskPath, "add", "shared.txt");
  git(state.taskPath, "commit", "-m", "resolve base sync conflict");
  const resolutionSha = git(state.taskPath, "rev-parse", "HEAD");
  const recovery = await state.manager.getSyncRecovery("t");
  assert.equal(recovery.state, "RESOLUTION_COMMITTED");
  const result = await state.manager.retrySync("t");
  assert.equal(result.status, "SYNCED");
  assert.equal(result.candidate_sha, resolutionSha);
  assert.equal(git(state.taskPath, "rev-parse", "HEAD"), resolutionSha, "retry must not create a second merge commit");
  const task = state.db.prepare("SELECT base_commit_sha, latest_task_commit_sha FROM tasks WHERE id = 't'").get();
  assert.equal(task.base_commit_sha, recovery.base_sha);
  assert.equal(task.latest_task_commit_sha, resolutionSha);
});
