import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../dist/db.js";
import { getCurrentBranch, getHeadSha, getStatus } from "../dist/git/repository.js";
import { WorktreeManager } from "../dist/git/worktree-manager.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

test("task worktree creation records base metadata and leaves primary checkout untouched", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "kanban-worktree-manager-"));
  const repo = join(temp, "cpp repo");
  const worktreeRoot = join(temp, "short worktrees");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Worktree Test");
  git(repo, "config", "user.email", "worktree-test@example.invalid");
  writeFileSync(join(repo, "main.cpp"), "int main() { return 0; }\n");
  git(repo, "add", "main.cpp");
  git(repo, "commit", "-m", "initial C++ source");
  const baseSha = git(repo, "rev-parse", "HEAD");

  const db = openDatabase(join(temp, "app.sqlite"));
  db.prepare(`INSERT INTO projects (id, name, root_path, worktree_root, created_at, updated_at)
    VALUES ('project-1', 'Fixture', ?, ?, ?, ?)`)
    .run(repo, worktreeRoot, new Date().toISOString(), new Date().toISOString());
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'C++ task', '', 'TODO', ?, ?)`)
    .run(new Date().toISOString(), new Date().toISOString());

  t.after(async () => {
    const saved = db.prepare("SELECT worktree_path FROM tasks WHERE id = 'task-1'").get();
    if (saved?.worktree_path) {
      try { git(repo, "worktree", "remove", "--force", saved.worktree_path); } catch {}
    }
    db.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const manager = new WorktreeManager(db);
  const worktree = await manager.createTaskWorktree("task-1");
  assert.equal(worktree.baseBranch, "main");
  assert.equal(worktree.baseCommitSha, baseSha);
  assert.equal(await getCurrentBranch(worktree.worktreePath), worktree.agentBranch);
  assert.equal(await getHeadSha(worktree.worktreePath), baseSha);
  assert.deepEqual(await getStatus(repo), []);
  assert.equal(await getCurrentBranch(repo), "main");
  assert.deepEqual(
    db.prepare("SELECT base_branch, base_commit_sha, agent_branch, worktree_path FROM tasks WHERE id = 'task-1'").get(),
    {
      base_branch: "main",
      base_commit_sha: baseSha,
      agent_branch: worktree.agentBranch,
      worktree_path: worktree.worktreePath,
    },
  );
  await assert.rejects(manager.createTaskWorktree("task-1"), /already has a worktree/);

  writeFileSync(join(worktree.worktreePath, "main.cpp"), "int main() { return 1; }\n");
  writeFileSync(join(worktree.worktreePath, "new.cpp"), "int helper() { return 2; }\n");
  assert.deepEqual((await manager.getChangedFiles("task-1")).sort(), ["main.cpp", "new.cpp"]);
  assert.deepEqual((await manager.getStatus("task-1")).map((file) => file.path).sort(), ["main.cpp", "new.cpp"]);
  assert.match(await manager.getDiff("task-1"), /return 1/);
  await assert.rejects(manager.openInIDE("task-1"), /Configure an IDE executable/);

  const validationPath = await manager.createValidationWorktree("task-1", baseSha);
  assert.equal(await getCurrentBranch(validationPath), null);
  assert.equal(await getHeadSha(validationPath), baseSha);
  writeFileSync(join(validationPath, "build-output.txt"), "validation artifact");
  await assert.rejects(manager.removeValidationWorktree("task-1", worktree.worktreePath), /Refusing to remove/);
  await manager.removeValidationWorktree("task-1", validationPath);
  assert.equal(existsSync(validationPath), false);
  assert.equal(await getHeadSha(worktree.worktreePath), baseSha);
  assert.match(await manager.getDiff("task-1"), /return 1/);
  await assert.rejects(manager.removeTaskWorktree("task-1"), /uncommitted changes/);
  assert.equal(db.prepare("SELECT cleanup_status FROM tasks WHERE id = 'task-1'").get().cleanup_status, "CLEANUP_PENDING");
  assert.equal(existsSync(worktree.worktreePath), true);
  git(worktree.worktreePath, "reset", "--hard");
  git(worktree.worktreePath, "clean", "-fd");
  await manager.removeTaskWorktree("task-1");
  assert.equal(existsSync(worktree.worktreePath), false);
  assert.equal(db.prepare("SELECT worktree_path FROM tasks WHERE id = 'task-1'").get().worktree_path, null);
  assert.equal(git(repo, "show-ref", "--verify", "--quiet", `refs/heads/${worktree.agentBranch}`), "");
});

test("checkpoint commit stages tracked and untracked task changes only in the task worktree", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "kanban-checkpoint-"));
  const repo = join(temp, "repo");
  const worktreeRoot = join(temp, "worktrees");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Checkpoint Test");
  git(repo, "config", "user.email", "checkpoint@example.invalid");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git(repo, "add", "file.txt");
  git(repo, "commit", "-m", "base");
  const db = openDatabase(join(temp, "app.sqlite"));
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, worktree_root, created_at, updated_at)
    VALUES ('p', 'P', ?, ?, ?, ?)`).run(repo, worktreeRoot, now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('t', 'p', 'Task', '', 'REVIEW', ?, ?)`).run(now, now);
  t.after(() => { db.close(); rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const manager = new WorktreeManager(db);
  const worktree = await manager.createTaskWorktree("t");
  writeFileSync(join(worktree.worktreePath, "file.txt"), "updated\n");
  writeFileSync(join(worktree.worktreePath, "new.txt"), "new file\n");
  const preview = await manager.previewCheckpoint("t");
  assert.deepEqual(preview.trackedChanges, ["file.txt"]);
  assert.deepEqual(preview.untrackedFiles, ["new.txt"]);
  const sha = await manager.createCheckpoint("t");
  assert.match(sha, /^[0-9a-f]{40}$/i);
  assert.equal(await getHeadSha(worktree.worktreePath), sha);
  assert.deepEqual(await manager.getStatus("t"), []);
  assert.deepEqual(await getStatus(repo), []);
  assert.deepEqual(git(worktree.worktreePath, "show", "--pretty=format:", "--name-only").split("\n").sort(), ["file.txt", "new.txt"]);
});

test("task worktree creation requires a configured root outside the repository", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "kanban-worktree-config-"));
  const repo = join(temp, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Worktree Test");
  git(repo, "config", "user.email", "worktree-test@example.invalid");
  git(repo, "commit", "--allow-empty", "-m", "initial");
  const db = openDatabase(join(temp, "app.sqlite"));
  db.prepare(`INSERT INTO projects (id, name, root_path, worktree_root, created_at, updated_at)
    VALUES ('project-1', 'Fixture', ?, ?, ?, ?)`)
    .run(repo, repo, new Date().toISOString(), new Date().toISOString());
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', '', 'TODO', ?, ?)`)
    .run(new Date().toISOString(), new Date().toISOString());
  t.after(() => {
    db.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await assert.rejects(new WorktreeManager(db).createTaskWorktree("task-1"), /outside the project repository/);
  assert.equal(db.prepare("SELECT worktree_path FROM tasks WHERE id = 'task-1'").get().worktree_path, null);
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1);
});
