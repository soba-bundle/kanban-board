import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
  assert.deepEqual(await manager.getTaskCompletionStatus("task-1"), { ready: true, reason: null });
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
  assert.deepEqual(await manager.getTaskCompletionStatus("task-1"), { ready: false, reason: "WORKTREE_CHANGES" });
  assert.match(await manager.getDiff("task-1"), /return 1/);
  await assert.rejects(manager.openInIDE("task-1"), /Configure an IDE executable/);

  assert.equal(await getHeadSha(worktree.worktreePath), baseSha);
  assert.match(await manager.getDiff("task-1"), /return 1/);
  await assert.rejects(manager.removeTaskWorktree("task-1"), /uncommitted changes/);
  assert.equal(db.prepare("SELECT cleanup_status FROM tasks WHERE id = 'task-1'").get().cleanup_status, "CLEANUP_PENDING");
  assert.equal(existsSync(worktree.worktreePath), true);
  git(worktree.worktreePath, "reset", "--hard");
  git(worktree.worktreePath, "clean", "-fd");
  assert.deepEqual(await manager.getTaskCompletionStatus("task-1"), { ready: true, reason: null });
  writeFileSync(join(worktree.worktreePath, "main.cpp"), "int main() { return 2; }\n");
  await manager.createCheckpoint("task-1");
  const checkpointSha = await getHeadSha(worktree.worktreePath);
  assert.deepEqual(await manager.getTaskCompletionStatus("task-1"), { ready: false, reason: "BRANCH_CHANGES" });
  const pinnedDiff = await manager.getPinnedDiff("task-1", baseSha, checkpointSha);
  assert.deepEqual(pinnedDiff.changedFiles, ["main.cpp"]);
  assert.match(pinnedDiff.diff, /return 2/);
  writeFileSync(join(worktree.worktreePath, "main.cpp"), "int main() { return 3; }\n");
  git(worktree.worktreePath, "add", "main.cpp");
  git(worktree.worktreePath, "commit", "-m", "later task change");
  assert.notEqual(await getHeadSha(worktree.worktreePath), checkpointSha);
  assert.deepEqual(await manager.getPinnedDiff("task-1", baseSha, checkpointSha), pinnedDiff,
    "diff must stay pinned to the recorded base/candidate even if the task branch moves");
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
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  git(repo, "add", "file.txt", ".gitignore");
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
  writeFileSync(join(worktree.worktreePath, "ignored.txt"), "do not checkpoint\n");
  const preview = await manager.previewCheckpoint("t");
  assert.deepEqual(preview.trackedChanges, ["file.txt"]);
  assert.deepEqual(preview.untrackedFiles, ["new.txt"]);
  const sha = await manager.createCheckpoint("t");
  assert.match(sha, /^[0-9a-f]{40}$/i);
  assert.equal(await getHeadSha(worktree.worktreePath), sha);
  assert.deepEqual(await manager.getStatus("t"), []);
  await assert.rejects(manager.createCheckpoint("t"), /no changes to checkpoint/);
  assert.deepEqual(await getStatus(repo), []);
  assert.deepEqual(git(worktree.worktreePath, "show", "--pretty=format:", "--name-only").split("\n").sort(), ["file.txt", "new.txt"]);
  assert.equal(existsSync(join(worktree.worktreePath, "ignored.txt")), true);
  assert.doesNotMatch(git(worktree.worktreePath, "show", "--pretty=format:", "--name-only"), /ignored\.txt/);
});

test("checkpoint preview includes complete tracked/untracked diffs without changing the index", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "kanban-checkpoint-preview-"));
  const repo = join(temp, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Checkpoint Preview Test");
  git(repo, "config", "user.email", "checkpoint-preview@example.invalid");
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  writeFileSync(join(repo, "deleted.txt"), "remove me\n");
  writeFileSync(join(repo, "rename-old.txt"), "rename me\n");
  git(repo, "add", "tracked.txt", "deleted.txt", "rename-old.txt");
  git(repo, "commit", "-m", "base");

  const db = openDatabase(join(temp, "app.sqlite"));
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, worktree_root, created_at, updated_at)
    VALUES ('p', 'P', ?, ?, ?, ?)`).run(repo, join(temp, "worktrees"), now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('t', 'p', 'Task', '', 'REVIEW', ?, ?)`).run(now, now);
  t.after(() => { db.close(); rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  const manager = new WorktreeManager(db);
  const worktree = await manager.createTaskWorktree("t");
  writeFileSync(join(worktree.worktreePath, "tracked.txt"), "staged content\n");
  git(worktree.worktreePath, "add", "tracked.txt");
  writeFileSync(join(worktree.worktreePath, "tracked.txt"), "final tracked content\n");
  unlinkSync(join(worktree.worktreePath, "deleted.txt"));
  git(worktree.worktreePath, "mv", "rename-old.txt", "rename-new.txt");
  const unusualName = "line break café [x].txt";
  writeFileSync(join(worktree.worktreePath, unusualName), "unusual content\n");
  writeFileSync(join(worktree.worktreePath, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(worktree.worktreePath, "large.txt"), "large line\n".repeat(6000));
  const originalIndexTree = git(worktree.worktreePath, "write-tree");
  const originalStatus = git(worktree.worktreePath, "status", "--porcelain");

  const preview = await manager.previewCheckpoint("t");
  assert.ok(preview.trackedChanges.includes("tracked.txt"));
  assert.ok(preview.trackedChanges.includes("deleted.txt"));
  assert.ok(preview.trackedChanges.includes("rename-new.txt"));
  assert.ok(preview.untrackedFiles.includes(unusualName));
  assert.ok(preview.untrackedFiles.includes("binary.bin"));
  assert.ok(preview.untrackedFiles.includes("large.txt"));
  assert.match(preview.diff, /final tracked content/);
  assert.match(preview.diff, /unusual content/);
  assert.match(preview.diff, /Binary files .*binary\.bin differ/);
  assert.match(preview.diff, /deleted file mode/);
  assert.ok(preview.diff.length > 50_000, "large text patches are not truncated");
  assert.equal(git(worktree.worktreePath, "write-tree"), originalIndexTree);
  assert.equal(git(worktree.worktreePath, "status", "--porcelain"), originalStatus);

  const repeated = await manager.previewCheckpoint("t");
  assert.equal(repeated.stateToken, preview.stateToken, "identical worktree state has a stable token");
  writeFileSync(join(worktree.worktreePath, unusualName), "edited unusual content\n");
  const changed = await manager.previewCheckpoint("t");
  assert.notEqual(changed.stateToken, preview.stateToken, "content edits invalidate the preview token");
  assert.equal(git(worktree.worktreePath, "write-tree"), originalIndexTree);
  assert.deepEqual(await getStatus(repo), [], "preview does not touch the primary checkout");
});

test("checkpoint failure preserves the existing index and worktree files", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "kanban-checkpoint-failure-"));
  const repo = join(temp, "repo");
  const worktreeRoot = join(temp, "worktrees");
  const hooks = join(temp, "hooks");
  mkdirSync(repo, { recursive: true });
  mkdirSync(hooks, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Checkpoint Failure Test");
  git(repo, "config", "user.email", "checkpoint-failure@example.invalid");
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  git(repo, "add", "tracked.txt", ".gitignore");
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
  writeFileSync(join(worktree.worktreePath, "tracked.txt"), "staged content\n");
  git(worktree.worktreePath, "add", "tracked.txt");
  writeFileSync(join(worktree.worktreePath, "tracked.txt"), "working content\n");
  writeFileSync(join(worktree.worktreePath, "new.txt"), "untracked content\n");
  writeFileSync(join(worktree.worktreePath, "ignored.txt"), "ignored content\n");
  const originalHead = await getHeadSha(worktree.worktreePath);
  const originalIndexTree = git(worktree.worktreePath, "write-tree");
  const originalStatus = git(worktree.worktreePath, "status", "--porcelain");
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n");
  git(worktree.worktreePath, "config", "core.hooksPath", hooks);

  await assert.rejects(manager.createCheckpoint("t"), /commit/i);
  assert.equal(await getHeadSha(worktree.worktreePath), originalHead);
  assert.equal(git(worktree.worktreePath, "write-tree"), originalIndexTree);
  assert.equal(git(worktree.worktreePath, "status", "--porcelain"), originalStatus);
  assert.equal(git(worktree.worktreePath, "show", "HEAD:tracked.txt"), "base");
  assert.equal(git(worktree.worktreePath, "show", ":tracked.txt"), "staged content");
  assert.equal(git(worktree.worktreePath, "check-ignore", "ignored.txt"), "ignored.txt");
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nenv -u GIT_INDEX_FILE git add -f ignored.txt\nexit 1\n");
  await assert.rejects(manager.createCheckpoint("t"), /index changed concurrently and was preserved/i);
  assert.equal(await getHeadSha(worktree.worktreePath), originalHead);
  assert.equal(git(worktree.worktreePath, "show", ":ignored.txt"), "ignored content");
  assert.match(git(worktree.worktreePath, "status", "--porcelain"), /A  ignored\.txt/);
  assert.equal(git(repo, "status", "--porcelain"), "");

  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(hooks, "post-commit"), "#!/bin/sh\nif [ ! -f concurrent.txt ]; then printf 'concurrent change\\n' > concurrent.txt; git add concurrent.txt; git commit -m concurrent; fi\n");
  await assert.rejects(manager.createCheckpoint("t"), /outcome is ambiguous|branch tip changed/i);
  assert.equal(db.prepare("SELECT latest_task_commit_sha FROM tasks WHERE id = 't'").get().latest_task_commit_sha, null);
  assert.deepEqual(git(worktree.worktreePath, "log", "-2", "--format=%s").split("\n"), ["concurrent", "Checkpoint task t"]);
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
