import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { runGit } from "./git-command.js";

async function gitOutput(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await runGit(args, { cwd, ...(env ? { env } : {}) });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}

export async function resolveGitRoot(input: string): Promise<string> {
  const resolved = realpathSync(resolve(input));
  const topLevel = await gitOutput(resolved, ["rev-parse", "--show-toplevel"]);
  return realpathSync(topLevel);
}

export async function getCurrentBranch(cwd: string): Promise<string | null> {
  const branch = await gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch === "HEAD" ? null : branch;
}

export async function getHeadSha(cwd: string): Promise<string> {
  return gitOutput(cwd, ["rev-parse", "HEAD"]);
}

export async function getCheckpointStateToken(cwd: string): Promise<string> {
  const [status, head, branch, diff] = await Promise.all([
    getStatus(cwd), getHeadSha(cwd), getCurrentBranch(cwd), getDiff(cwd, "HEAD"),
  ]);
  const untracked = await Promise.all(status.filter((file) => file.untracked).map(async (file) => [
    file.path,
    await gitOutput(cwd, ["hash-object", "--", file.path]),
  ]));
  return createHash("sha256").update(JSON.stringify({ status, head, branch, diff, untracked })).digest("hex");
}

export async function createCheckpointCommit(cwd: string, message: string, expectedBranch: string): Promise<string> {
  const ensureSafeGitState = async () => {
    const branch = await getCurrentBranch(cwd);
    if (branch !== expectedBranch) throw new Error(`Task worktree branch changed; expected ${expectedBranch}.`);
    const operation = await getGitOperationState(cwd);
    if (operation.operation) throw new Error(`Cannot checkpoint while a Git ${operation.operation.toLowerCase()} operation is in progress.`);
  };
  await ensureSafeGitState();
  if ((await getStatus(cwd)).length === 0) throw new Error("There are no changes to checkpoint.");

  const originalHead = await getHeadSha(cwd);
  const indexPath = await gitOutput(cwd, ["rev-parse", "--git-path", "index"]);
  const resolvedIndexPath = isAbsolute(indexPath) ? indexPath : resolve(cwd, indexPath);
  const originalIndex = existsSync(resolvedIndexPath) ? readFileSync(resolvedIndexPath) : null;
  const temporaryIndexPath = `${resolvedIndexPath}.kanban-${randomUUID()}`;
  const temporaryIndexEnv = { GIT_INDEX_FILE: temporaryIndexPath };
  if (originalIndex) writeFileSync(temporaryIndexPath, originalIndex);
  else {
    const initialized = await runGit(["read-tree", "HEAD"], { cwd, env: temporaryIndexEnv });
    if (initialized.exitCode !== 0) throw new Error(initialized.stderr.trim() || "Unable to initialize checkpoint index.");
  }

  const installCheckpointIndex = (): void => {
    const checkpointIndex = readFileSync(temporaryIndexPath);
    const lockPath = `${resolvedIndexPath}.lock`;
    const lockFd = openSync(lockPath, "wx");
    try {
      const currentIndex = existsSync(resolvedIndexPath) ? readFileSync(resolvedIndexPath) : null;
      const unchanged = originalIndex === null
        ? currentIndex === null
        : currentIndex !== null && currentIndex.equals(originalIndex);
      if (!unchanged) return;
      writeFileSync(lockFd, checkpointIndex);
      fsyncSync(lockFd);
      closeSync(lockFd);
      renameSync(lockPath, resolvedIndexPath);
    } catch (error) {
      try { closeSync(lockFd); } catch {}
      throw error;
    } finally {
      if (existsSync(lockPath)) {
        try { closeSync(lockFd); } catch {}
        unlinkSync(lockPath);
      }
    }
  };

  try {
    const add = await runGit(["add", "--all"], { cwd, env: temporaryIndexEnv });
    if (add.exitCode !== 0) throw new Error(add.stderr.trim() || "Unable to stage task worktree changes.");
    const checkpointTree = await gitOutput(cwd, ["write-tree"], temporaryIndexEnv);
    await ensureSafeGitState();
    if (await getHeadSha(cwd) !== originalHead) throw new Error("Git HEAD changed before checkpoint commit.");
    const commit = await runGit(["commit", "-m", message], { cwd, env: temporaryIndexEnv });
    const currentHead = await getHeadSha(cwd);
    if (currentHead === originalHead) {
      if (commit.exitCode !== 0) throw new Error(commit.stderr.trim() || "Unable to create checkpoint commit.");
      throw new Error("Git reported checkpoint success without advancing HEAD.");
    }
    const details = await gitOutput(cwd, ["show", "-s", "--format=%P%n%T", currentHead]);
    const [parents, tree] = details.split("\n");
    const [branchAfterCommit, tipAfterCommit] = await Promise.all([getCurrentBranch(cwd), getHeadSha(cwd)]);
    if (parents !== originalHead || tree !== checkpointTree || branchAfterCommit !== expectedBranch || tipAfterCommit !== currentHead) {
      throw new Error(`Git HEAD or branch tip changed during checkpoint; outcome is ambiguous (branch=${branchAfterCommit}, tip=${tipAfterCommit}, expected branch=${expectedBranch}, observed tip=${currentHead}). Do not retry blindly.`);
    }
    try { installCheckpointIndex(); } catch { /* Keep the committed SHA authoritative; never overwrite a changed or locked user index. */ }
    return currentHead;
  } catch (error) {
    const currentHead = await getHeadSha(cwd).catch(() => null);
    if (currentHead !== originalHead) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} Git HEAD changed or could not be confirmed; the index was left untouched. Do not retry blindly.`);
    }
    const currentIndex = existsSync(resolvedIndexPath) ? readFileSync(resolvedIndexPath) : null;
    const indexChanged = originalIndex === null
      ? currentIndex !== null
      : currentIndex === null || !currentIndex.equals(originalIndex);
    if (indexChanged) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} The Git index changed concurrently and was preserved.`);
    }
    throw error;
  } finally {
    if (existsSync(temporaryIndexPath)) unlinkSync(temporaryIndexPath);
    if (existsSync(`${temporaryIndexPath}.lock`)) unlinkSync(`${temporaryIndexPath}.lock`);
  }
}

export interface GitFileStatus {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  untracked: boolean;
}

export async function getStatus(cwd: string): Promise<GitFileStatus[]> {
  const result = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "git status failed");

  const records = result.stdout.split("\0");
  const files: GitFileStatus[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    files.push({
      path: record.slice(3),
      indexStatus,
      worktreeStatus,
      untracked: indexStatus === "?" && worktreeStatus === "?",
    });
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") i++;
  }
  return files;
}

export async function getDiff(cwd: string, from?: string, to?: string): Promise<string> {
  const args = ["diff", "--no-ext-diff", "--no-color"];
  if (from) args.push(from);
  if (to) args.push(to);
  const result = await runGit(args, { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "git diff failed");
  return result.stdout;
}

export async function getChangedFiles(cwd: string, from?: string, to?: string): Promise<string[]> {
  if (from) {
    const args = ["diff", "--name-only", "-z", from];
    if (to) args.push(to);
    const result = await runGit(args, { cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "git diff failed");
    return result.stdout.split("\0").filter(Boolean);
  }
  return (await getStatus(cwd)).map((file) => file.path);
}

export type GitOperation = "MERGE" | "REBASE" | "CHERRY_PICK" | "REVERT";
export interface GitOperationState {
  operation: GitOperation | null;
  markerPath: string | null;
}

export async function getGitOperationState(cwd: string): Promise<GitOperationState> {
  const markers: Array<{ operation: GitOperation; gitPath: string }> = [
    { operation: "MERGE", gitPath: "MERGE_HEAD" },
    { operation: "REBASE", gitPath: "rebase-merge" },
    { operation: "REBASE", gitPath: "rebase-apply" },
    { operation: "CHERRY_PICK", gitPath: "CHERRY_PICK_HEAD" },
    { operation: "REVERT", gitPath: "REVERT_HEAD" },
  ];

  for (const marker of markers) {
    const gitPath = await gitOutput(cwd, ["rev-parse", "--git-path", marker.gitPath]);
    const markerPath = isAbsolute(gitPath) ? gitPath : resolve(cwd, gitPath);
    if (existsSync(markerPath)) return { operation: marker.operation, markerPath };
  }
  return { operation: null, markerPath: null };
}
