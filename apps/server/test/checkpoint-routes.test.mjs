import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { openDatabase } from "../dist/db.js";
import { registerTaskRoutes } from "../dist/tasks.js";
import { WorktreeManager } from "../dist/git/worktree-manager.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
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
  writeFileSync(join(worktreePath, "new.txt"), "new file\n");
  const preview = await app.inject({ method: "GET", url: "/api/tasks/t/checkpoint-preview" });
  assert.equal(preview.statusCode, 200);
  assert.deepEqual(preview.json().untracked_files, ["new.txt"]);

  const declined = await app.inject({ method: "POST", url: "/api/tasks/t/checkpoint", payload: {} });
  assert.equal(declined.statusCode, 409);
  assert.deepEqual(declined.json().untracked_files, ["new.txt"]);
  assert.equal(db.prepare("SELECT latest_task_commit_sha FROM tasks WHERE id = 't'").get().latest_task_commit_sha, null);
  assert.equal(db.prepare("SELECT workflow_state FROM tasks WHERE id = 't'").get().workflow_state, "REVIEW");
  assert.equal(git(worktreePath, "status", "--porcelain"), "?? new.txt");

  const confirmed = await app.inject({
    method: "POST", url: "/api/tasks/t/checkpoint", payload: { include_untracked_files: ["new.txt"] },
  });
  assert.equal(confirmed.statusCode, 200);
  const sha = confirmed.json().commit_sha;
  assert.equal(db.prepare("SELECT latest_task_commit_sha FROM tasks WHERE id = 't'").get().latest_task_commit_sha, sha);
  assert.equal(db.prepare("SELECT task_commit_sha FROM task_runs WHERE id = 'run-1'").get().task_commit_sha, sha);
  assert.equal(db.prepare("SELECT workflow_state, review_tag FROM tasks WHERE id = 't'").get().workflow_state, "REVIEW");
  assert.equal(git(worktreePath, "show", "--pretty=format:", "--name-only").trim(), "new.txt");
  assert.equal(git(repo, "status", "--porcelain"), "");

  writeFileSync(join(worktreePath, "new.txt"), "later uncommitted edit\n");
  const diff = await app.inject({ method: "GET", url: "/api/tasks/t/checkpoint-diff" });
  assert.equal(diff.statusCode, 200);
  assert.equal(diff.json().from_sha, db.prepare("SELECT base_commit_sha FROM tasks WHERE id = 't'").get().base_commit_sha);
  assert.equal(diff.json().to_sha, sha);
  assert.deepEqual(diff.json().files, ["new.txt"]);
  assert.match(diff.json().diff, /new file/);
  assert.doesNotMatch(diff.json().diff, /later uncommitted edit/);
});
