import type Database from "better-sqlite3";
import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { runGit } from "./git-command.js";
import { openInIde } from "../ide/ide-launcher.js";
import {
  getChangedFiles,
  getCurrentBranch,
  getDiff,
  getGitOperationState,
  getCheckpointStateToken,
  getUncheckpointedDiff,
  createCheckpointCommit,
  getHeadSha,
  getStatus,
  type GitFileStatus,
} from "./repository.js";

interface TaskProjectRow {
  task_id: string;
  project_id: string;
  worktree_path: string | null;
  agent_branch: string | null;
  base_commit_sha: string | null;
  base_branch: string | null;
  root_path: string;
  worktree_root: string | null;
  ide_command: string | null;
}

export interface TaskWorktree {
  taskId: string;
  projectId: string;
  baseBranch: string;
  baseCommitSha: string;
  agentBranch: string;
  worktreePath: string;
}

export interface CheckpointPreview {
  trackedChanges: string[];
  untrackedFiles: string[];
  branch: string;
  commitSha: string;
  stateToken: string;
  diff: string;
}

function sameCheckpointPreview(left: CheckpointPreview, right: Omit<CheckpointPreview, "diff">): boolean {
  return JSON.stringify(left.trackedChanges) === JSON.stringify(right.trackedChanges) &&
    JSON.stringify(left.untrackedFiles) === JSON.stringify(right.untrackedFiles) &&
    left.branch === right.branch && left.commitSha === right.commitSha && left.stateToken === right.stateToken;
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function gitFailure(result: { stderr: string }, fallback: string): Error {
  return new Error(result.stderr.trim() || fallback);
}

function taskSegment(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9._-]/g, "-");
}

export class WorktreeManager {
  constructor(private readonly db: Database.Database) {}

  private getTaskProject(taskId: string): TaskProjectRow {
    const row = this.db.prepare(`SELECT
      tasks.id AS task_id,
      tasks.project_id AS project_id,
      tasks.worktree_path AS worktree_path,
      tasks.agent_branch AS agent_branch,
      tasks.base_commit_sha AS base_commit_sha,
      tasks.base_branch AS base_branch,
      projects.root_path AS root_path,
      projects.worktree_root AS worktree_root,
      projects.ide_command AS ide_command
      FROM tasks JOIN projects ON projects.id = tasks.project_id
      WHERE tasks.id = ?`).get(taskId) as TaskProjectRow | undefined;
    if (!row) throw new Error("Task not found.");
    return row;
  }

  private getTaskWorktreePath(taskId: string): { row: TaskProjectRow; path: string } {
    const row = this.getTaskProject(taskId);
    if (!row.worktree_path) throw new Error("Task does not have a worktree.");
    const path = realpathSync(row.worktree_path);
    const worktreeRoot = this.getWorktreeRoot(row);
    if (!isWithin(worktreeRoot, path) || path === worktreeRoot) {
      throw new Error("Task worktree path is outside the configured worktree root.");
    }
    return { row, path };
  }

  private getWorktreeRoot(row: TaskProjectRow): string {
    if (!row.worktree_root) throw new Error("Configure a short worktree root for this project first.");
    const root = resolve(row.worktree_root);
    mkdirSync(root, { recursive: true });
    const canonicalRoot = realpathSync(root);
    if (isWithin(realpathSync(row.root_path), canonicalRoot)) {
      throw new Error("Worktree root must be outside the project repository.");
    }
    return canonicalRoot;
  }

  async createTaskWorktree(taskId: string): Promise<TaskWorktree> {
    const row = this.getTaskProject(taskId);
    if (row.worktree_path) throw new Error("Task already has a worktree configured.");

    const repositoryRoot = realpathSync(row.root_path);
    const worktreeRoot = this.getWorktreeRoot(row);
    const baseBranch = await getCurrentBranch(repositoryRoot);
    if (!baseBranch) throw new Error("Cannot create a task worktree from a detached HEAD.");
    const baseCommitSha = await getHeadSha(repositoryRoot);
    const id = taskSegment(taskId);
    const agentBranch = `agent/task-${id}`;
    const worktreePath = resolve(worktreeRoot, id);
    const branchExists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${agentBranch}`], {
      cwd: repositoryRoot,
    });
    if (branchExists.exitCode === 0) throw new Error(`Task branch already exists: ${agentBranch}`);
    if (branchExists.exitCode !== 1) throw gitFailure(branchExists, "Unable to inspect task branch.");

    const create = await runGit(["worktree", "add", "-b", agentBranch, worktreePath, baseCommitSha], {
      cwd: repositoryRoot,
    });
    if (create.exitCode !== 0) throw gitFailure(create, "Unable to create task worktree.");

    try {
      const update = this.db.prepare(`UPDATE tasks SET
        base_branch = ?, base_commit_sha = ?, agent_branch = ?, worktree_path = ?, updated_at = ?
        WHERE id = ? AND worktree_path IS NULL`)
        .run(baseBranch, baseCommitSha, agentBranch, worktreePath, new Date().toISOString(), taskId);
      if (update.changes !== 1) throw new Error("Task metadata changed while creating its worktree.");
    } catch (error) {
      const cleanup = await runGit(["worktree", "remove", "--force", worktreePath], { cwd: repositoryRoot });
      if (cleanup.exitCode !== 0) {
        throw new Error(`Could not persist task worktree metadata, and cleanup failed: ${cleanup.stderr.trim()}`);
      }
      await runGit(["branch", "-D", agentBranch], { cwd: repositoryRoot });
      throw error;
    }

    return { taskId, projectId: row.project_id, baseBranch, baseCommitSha, agentBranch, worktreePath };
  }

  async getStatus(taskId: string): Promise<GitFileStatus[]> {
    const { path } = this.getTaskWorktreePath(taskId);
    return getStatus(path);
  }

  async getTaskWorktreeState(taskId: string): Promise<{ head_sha: string; dirty: boolean }> {
    const { path } = this.getTaskWorktreePath(taskId);
    const [headSha, status] = await Promise.all([getHeadSha(path), getStatus(path)]);
    return { head_sha: headSha, dirty: status.length > 0 };
  }

  async getBaseBranchTip(taskId: string): Promise<string> {
    const row = this.getTaskProject(taskId);
    if (!row.base_branch) throw new Error("Task has no recorded base branch.");
    const result = await runGit(["rev-parse", "--verify", `refs/heads/${row.base_branch}`], { cwd: realpathSync(row.root_path) });
    if (result.exitCode !== 0) throw gitFailure(result, "Unable to read the current base branch tip.");
    return result.stdout.trim();
  }

  async getTaskSyncState(taskId: string): Promise<{
    branch: string | null; headSha: string; dirty: boolean; operation: string | null;
    hasUnmergedPaths: boolean; stateToken: string;
  }> {
    const { path } = this.getTaskWorktreePath(taskId);
    const readState = async () => {
      const [branch, headSha, status, operation, unmerged, stateToken] = await Promise.all([
        getCurrentBranch(path), getHeadSha(path), getStatus(path), getGitOperationState(path),
        runGit(["ls-files", "-u"], { cwd: path }), getCheckpointStateToken(path),
      ]);
      return {
        branch, headSha, dirty: status.length > 0, operation: operation.operation,
        hasUnmergedPaths: !!unmerged.stdout.trim(), stateToken,
      };
    };
    const first = await readState();
    const confirmed = await readState();
    if (JSON.stringify(first) !== JSON.stringify(confirmed)) {
      throw new Error("Task worktree changed while reading sync state; preserve it and refresh before continuing.");
    }
    return confirmed;
  }

  async isBaseAncestorOfTask(taskId: string, baseSha: string, taskSha: string): Promise<boolean> {
    const { path } = this.getTaskWorktreePath(taskId);
    const result = await runGit(["merge-base", "--is-ancestor", baseSha, taskSha], { cwd: path });
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error(result.stderr.trim() || "Unable to verify whether the current base is in the task history.");
  }

  async taskSyncContains(taskId: string, baseSha: string, priorTaskSha: string, candidateSha: string): Promise<boolean> {
    const { path } = this.getTaskWorktreePath(taskId);
    const [containsBase, containsPrior] = await Promise.all([
      runGit(["merge-base", "--is-ancestor", baseSha, candidateSha], { cwd: path }),
      runGit(["merge-base", "--is-ancestor", priorTaskSha, candidateSha], { cwd: path }),
    ]);
    return containsBase.exitCode === 0 && containsPrior.exitCode === 0;
  }

  async abortTaskSync(taskId: string, input: { expectedBranch: string; expectedHead: string; stateToken: string }): Promise<void> {
    const { path } = this.getTaskWorktreePath(taskId);
    const state = await this.getTaskSyncState(taskId);
    if (state.branch !== input.expectedBranch || state.headSha !== input.expectedHead || state.operation !== "MERGE" || !state.hasUnmergedPaths) {
      throw new Error("The task no longer has the captured sync conflict; preserve its current Git state and inspect it.");
    }
    if (state.stateToken !== input.stateToken) {
      throw new Error("The conflict worktree changed since the conflict snapshot; commit or preserve those edits before aborting.");
    }
    const abort = await runGit(["merge", "--abort"], { cwd: path });
    if (abort.exitCode !== 0) throw gitFailure(abort, "Unable to abort the sync; preserve the task worktree and resolve Git state manually.");
    const after = await this.getTaskSyncState(taskId);
    if (after.branch !== input.expectedBranch || after.headSha !== input.expectedHead || after.dirty || after.operation || after.hasUnmergedPaths) {
      throw new Error("Sync abort returned with unexpected Git state; preserve the task worktree and inspect it before continuing.");
    }
  }

  async mergeBaseIntoTask(taskId: string, input: {
    baseSha: string; expectedBranch: string; expectedHead: string;
  }): Promise<{ status: "SYNCED"; candidateSha: string } | { status: "CONFLICT"; candidateSha: string }> {
    const { path } = this.getTaskWorktreePath(taskId);
    const [branch, head, status, operation] = await Promise.all([
      getCurrentBranch(path), getHeadSha(path), getStatus(path), getGitOperationState(path),
    ]);
    if (branch !== input.expectedBranch) throw new Error(`Task branch changed; expected ${input.expectedBranch}.`);
    if (head !== input.expectedHead) throw new Error("Task branch tip changed; refresh task state before syncing.");
    if (operation.operation) throw new Error(`A Git ${operation.operation.toLowerCase()} operation is already in progress.`);
    if (status.length > 0) throw new Error("Task worktree is dirty; checkpoint or preserve its changes before syncing.");

    const merge = await runGit(["merge", "--no-edit", input.baseSha], { cwd: path });
    if (merge.exitCode !== 0) {
      const [currentOperation, unmerged] = await Promise.all([
        getGitOperationState(path), runGit(["ls-files", "-u"], { cwd: path }),
      ]);
      if (currentOperation.operation === "MERGE" || unmerged.stdout.trim()) {
        return { status: "CONFLICT", candidateSha: await getHeadSha(path) };
      }
      throw gitFailure(merge, "Unable to merge the captured base into the task branch; preserve the worktree state.");
    }

    const [finalBranch, candidateSha, finalStatus, finalOperation] = await Promise.all([
      getCurrentBranch(path), getHeadSha(path), getStatus(path), getGitOperationState(path),
    ]);
    if (finalBranch !== input.expectedBranch || finalStatus.length > 0 || finalOperation.operation) {
      throw new Error("Task worktree changed during sync; preserve its current Git state and inspect it before retrying.");
    }
    const containsBase = await runGit(["merge-base", "--is-ancestor", input.baseSha, candidateSha], { cwd: path });
    if (containsBase.exitCode !== 0) throw new Error("Synchronized task commit does not contain the captured base.");
    return { status: "SYNCED", candidateSha };
  }

  async getTaskCompletionStatus(taskId: string): Promise<{
    ready: boolean;
    reason: "WORKTREE_CHANGES" | "BRANCH_CHANGES" | "GIT_STATE_UNAVAILABLE" | null;
  }> {
    const row = this.getTaskProject(taskId);
    if (!row.worktree_path && !row.agent_branch && !row.base_commit_sha) return { ready: true, reason: null };
    if (!row.agent_branch || !row.base_commit_sha) return { ready: false, reason: "GIT_STATE_UNAVAILABLE" };

    if (row.worktree_path) {
      const { path } = this.getTaskWorktreePath(taskId);
      const operation = await getGitOperationState(path);
      if (operation.operation) return { ready: false, reason: "GIT_STATE_UNAVAILABLE" };
      const status = await getStatus(path);
      if (status.length > 0) return { ready: false, reason: "WORKTREE_CHANGES" };
      if (await getCurrentBranch(path) !== row.agent_branch) return { ready: false, reason: "GIT_STATE_UNAVAILABLE" };
      return await getHeadSha(path) === row.base_commit_sha
        ? { ready: true, reason: null }
        : { ready: false, reason: "BRANCH_CHANGES" };
    }

    const branch = await runGit(["rev-parse", "--verify", `refs/heads/${row.agent_branch}`], { cwd: realpathSync(row.root_path) });
    if (branch.exitCode !== 0) return { ready: false, reason: "GIT_STATE_UNAVAILABLE" };
    return branch.stdout.trim() === row.base_commit_sha
      ? { ready: true, reason: null }
      : { ready: false, reason: "BRANCH_CHANGES" };
  }

  async createCheckpoint(taskId: string, expected?: Omit<CheckpointPreview, "diff">): Promise<string> {
    const current = await this.previewCheckpoint(taskId);
    if (expected && !sameCheckpointPreview(current, expected)) {
      throw new Error("Task worktree changed; review the checkpoint contents again.");
    }
    if (current.trackedChanges.length === 0 && current.untrackedFiles.length === 0) {
      throw new Error("There are no changes to checkpoint.");
    }
    const { path } = this.getTaskWorktreePath(taskId);
    return createCheckpointCommit(path, `Checkpoint task ${taskId}`, current.branch);
  }

  async previewCheckpoint(taskId: string): Promise<CheckpointPreview> {
    const { row, path } = this.getTaskWorktreePath(taskId);
    const branch = await getCurrentBranch(path);
    if (!row.agent_branch || branch !== row.agent_branch) {
      throw new Error(`Task worktree branch changed; expected ${row.agent_branch ?? "the configured task branch"}.`);
    }
    const operation = await getGitOperationState(path);
    if (operation.operation) throw new Error(`Cannot checkpoint while a Git ${operation.operation.toLowerCase()} operation is in progress.`);
    const status = await getStatus(path);
    const commitSha = await getHeadSha(path);
    const initialToken = await getCheckpointStateToken(path);
    const diff = await getUncheckpointedDiff(path, status);
    const [verifiedStatus, verifiedBranch, verifiedCommitSha, stateToken] = await Promise.all([
      getStatus(path), getCurrentBranch(path), getHeadSha(path), getCheckpointStateToken(path),
    ]);
    if (stateToken !== initialToken || JSON.stringify(status) !== JSON.stringify(verifiedStatus) ||
        branch !== verifiedBranch || commitSha !== verifiedCommitSha) {
      throw new Error("Task worktree changed while preparing the preview; refresh and review it again.");
    }
    return {
      trackedChanges: status.filter((file) => !file.untracked).map((file) => file.path),
      untrackedFiles: status.filter((file) => file.untracked).map((file) => file.path),
      branch,
      commitSha,
      stateToken,
      diff,
    };
  }

  async getDiff(taskId: string, from?: string, to?: string): Promise<string> {
    const { path } = this.getTaskWorktreePath(taskId);
    return getDiff(path, from, to);
  }

  async getPinnedDiff(taskId: string, baseSha: string, candidateSha: string): Promise<{ changedFiles: string[]; diff: string }> {
    if (!/^[0-9a-f]{40}$/i.test(baseSha) || !/^[0-9a-f]{40}$/i.test(candidateSha)) {
      throw new Error("Pinned diff requires full commit SHAs.");
    }
    const row = this.getTaskProject(taskId);
    const repositoryRoot = realpathSync(row.root_path);
    const changedFiles = await getChangedFiles(repositoryRoot, baseSha, candidateSha);
    const diff = await getDiff(repositoryRoot, baseSha, candidateSha);
    return { changedFiles, diff };
  }

  async getChangedFiles(taskId: string, from?: string, to?: string): Promise<string[]> {
    const { path } = this.getTaskWorktreePath(taskId);
    return getChangedFiles(path, from, to);
  }

  async openInIDE(taskId: string): Promise<void> {
    const { row, path } = this.getTaskWorktreePath(taskId);
    if (!row.ide_command) throw new Error("Configure an IDE executable for this project first.");
    await openInIde(row.ide_command, path);
  }

  async removeTaskWorktree(taskId: string): Promise<void> {
    const { row, path } = this.getTaskWorktreePath(taskId);
    const repositoryRoot = realpathSync(row.root_path);
    const status = await getStatus(path);
    if (status.length > 0) {
      this.db.prepare("UPDATE tasks SET cleanup_status = 'CLEANUP_PENDING', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), taskId);
      throw new Error("Task worktree has uncommitted changes; preserved it and marked cleanup pending.");
    }

    const result = await runGit(["worktree", "remove", path], { cwd: repositoryRoot });
    if (result.exitCode !== 0) {
      this.db.prepare("UPDATE tasks SET cleanup_status = 'CLEANUP_PENDING', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), taskId);
      throw gitFailure(result, "Unable to remove task worktree; cleanup is pending.");
    }
    this.db.prepare("UPDATE tasks SET worktree_path = NULL, cleanup_status = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), taskId);
  }

}
