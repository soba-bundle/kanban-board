import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../dist/db.js";
import { WorktreeManager } from "../dist/git/worktree-manager.js";

let ValidationCleanupManager;
let importError;
try {
  ({ ValidationCleanupManager } = await import("../dist/agents/validation-cleanup.js"));
} catch (error) {
  importError = error;
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

test("validation cleanup failure is recorded per attempt and reconciled without touching the task worktree", async (t) => {
  assert.equal(typeof ValidationCleanupManager, "function",
    `Expected per-attempt validation cleanup recovery; ${importError?.message ?? "export is missing"}`);
  const temp = mkdtempSync(join(tmpdir(), "kanban-validation-cleanup-"));
  const repo = join(temp, "repo");
  const worktreeRoot = join(temp, "worktrees");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Validation Cleanup Test");
  git(repo, "config", "user.email", "validation-cleanup@example.invalid");
  writeFileSync(join(repo, "source.txt"), "base\n");
  git(repo, "add", "source.txt");
  git(repo, "commit", "-m", "base");
  const baseSha = git(repo, "rev-parse", "HEAD");
  const db = openDatabase(join(temp, "app.sqlite"));
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, worktree_root, created_at, updated_at)
    VALUES ('p', 'Project', ?, ?, ?, ?)`).run(repo, worktreeRoot, now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('t', 'p', 'Task', '', 'REVIEW', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('validation-1', 't', 'VALIDATION_REVIEW', 1, 'COMPLETED')`).run();
  db.prepare(`INSERT INTO validation_results (id, task_id, run_id, result, findings_json, created_at)
    VALUES ('result-1', 't', 'validation-1', 'PASSED', '[]', ?)`).run(now);
  const worktrees = new WorktreeManager(db);
  let taskWorktree;
  let validationWorktree;
  t.after(async () => {
    if (validationWorktree) {
      try { await worktrees.removeValidationWorktree("t", validationWorktree); }
      catch { try { git(repo, "worktree", "remove", "--force", validationWorktree); } catch {} }
    }
    if (taskWorktree) {
      try { git(taskWorktree, "reset", "--hard"); git(taskWorktree, "clean", "-fd"); } catch {}
      try { await worktrees.removeTaskWorktree("t"); }
      catch { try { git(repo, "worktree", "remove", "--force", taskWorktree); } catch {} }
    }
    db.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  taskWorktree = (await worktrees.createTaskWorktree("t")).worktreePath;
  validationWorktree = await worktrees.createValidationWorktree("t", baseSha);
  writeFileSync(join(taskWorktree, "task-only.txt"), "preserve task worktree\n");
  const taskHead = git(taskWorktree, "rev-parse", "HEAD");
  const manager = new ValidationCleanupManager(db, {
    async removeValidationWorktree() { throw new Error("simulated transient Git cleanup failure"); },
  });

  await manager.cleanup("t", "validation-1", validationWorktree);
  const pending = db.prepare(`SELECT validation_worktree_path, cleanup_status FROM validation_results
    WHERE run_id = 'validation-1'`).get();
  assert.equal(pending.validation_worktree_path, validationWorktree);
  assert.equal(pending.cleanup_status, "CLEANUP_PENDING");
  assert.equal(existsSync(validationWorktree), true);
  assert.equal(db.prepare("SELECT worktree_path FROM tasks WHERE id = 't'").get().worktree_path, taskWorktree);
  assert.equal(git(taskWorktree, "rev-parse", "HEAD"), taskHead);
  assert.equal(git(taskWorktree, "status", "--porcelain"), "?? task-only.txt");
  assert.equal(readFileSync(join(taskWorktree, "task-only.txt"), "utf8"), "preserve task worktree\n");

  const recovered = new ValidationCleanupManager(db, worktrees);
  await recovered.reconcilePending();
  assert.equal(existsSync(validationWorktree), false);
  const cleared = db.prepare(`SELECT validation_worktree_path, cleanup_status FROM validation_results
    WHERE run_id = 'validation-1'`).get();
  assert.equal(cleared.validation_worktree_path, null);
  assert.equal(cleared.cleanup_status, null);
  assert.equal(db.prepare("SELECT worktree_path FROM tasks WHERE id = 't'").get().worktree_path, taskWorktree);
  assert.equal(git(taskWorktree, "rev-parse", "HEAD"), taskHead);
  assert.equal(git(taskWorktree, "status", "--porcelain"), "?? task-only.txt");
  assert.equal(readFileSync(join(taskWorktree, "task-only.txt"), "utf8"), "preserve task worktree\n");
});
