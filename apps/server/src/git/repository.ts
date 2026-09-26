import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { runGit } from "./git-command.js";

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(args, { cwd });
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
