import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getChangedFiles,
  getCurrentBranch,
  getDiff,
  getGitOperationState,
  getHeadSha,
  getStatus,
  resolveGitRoot,
} from "../dist/git/repository.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function makeRepo(path) {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-b", "main", path], { stdio: "ignore" });
  git(path, "config", "user.name", "Git Repository Test");
  git(path, "config", "user.email", "git-repository-test@example.invalid");
  writeFileSync(join(path, "conflict.cpp"), "base\n");
  git(path, "add", "conflict.cpp");
  git(path, "commit", "-m", "base");
}

test("repository inspection reports root, branch, SHA, status, diff, and changed files", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "kanban-git-repository-"));
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const repo = join(temp, "repo with spaces");
  makeRepo(repo);

  assert.equal(await resolveGitRoot(repo), repo);
  assert.equal(await getCurrentBranch(repo), "main");
  assert.match(await getHeadSha(repo), /^[0-9a-f]{40}$/i);

  writeFileSync(join(repo, "conflict.cpp"), "changed\n");
  writeFileSync(join(repo, "new file.cpp"), "new\n");
  const status = await getStatus(repo);
  assert.deepEqual(status.map((file) => file.path).sort(), ["conflict.cpp", "new file.cpp"]);
  assert.equal(status.find((file) => file.path === "new file.cpp").untracked, true);
  assert.match(await getDiff(repo), /changed/);
  assert.deepEqual((await getChangedFiles(repo)).sort(), ["conflict.cpp", "new file.cpp"]);
});

test("Git operation detection finds merge markers in a linked worktree", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "kanban-git-operations-"));
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const repo = join(temp, "repo");
  makeRepo(repo);

  git(repo, "checkout", "-b", "side");
  writeFileSync(join(repo, "conflict.cpp"), "side\n");
  git(repo, "commit", "-am", "side change");
  git(repo, "checkout", "main");
  writeFileSync(join(repo, "conflict.cpp"), "main\n");
  git(repo, "commit", "-am", "main change");

  const worktree = join(temp, "task worktree");
  git(repo, "worktree", "add", "-b", "agent/task", worktree, "main");
  const merge = spawnSync("git", ["-C", worktree, "merge", "side"], { encoding: "utf8" });
  assert.notEqual(merge.status, 0);
  assert.match(`${merge.stdout}${merge.stderr}`, /CONFLICT/);
  const state = await getGitOperationState(worktree);
  assert.equal(state.operation, "MERGE");
  assert.ok(state.markerPath);
});
