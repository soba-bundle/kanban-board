import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { runGit } from "./git-command.js";
import { openInIde } from "../ide/ide-launcher.js";
import {
  getChangedFiles,
  getCurrentBranch,
  getDiff,
  createCheckpointCommit,
  getHeadSha,
  getStatus,
  type GitFileStatus,
} from "./repository.js";

interface TaskProjectRow {
  task_id: string;
  project_id: string;
  worktree_path: string | null;
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

  async createCheckpoint(taskId: string): Promise<string> {
    const { path } = this.getTaskWorktreePath(taskId);
    return createCheckpointCommit(path, `Checkpoint task ${taskId}`);
  }

  async previewCheckpoint(taskId: string): Promise<{ trackedChanges: string[]; untrackedFiles: string[]; commitSha: string }> {
    const { path } = this.getTaskWorktreePath(taskId);
    const status = await getStatus(path);
    return {
      trackedChanges: status.filter((file) => !file.untracked).map((file) => file.path),
      untrackedFiles: status.filter((file) => file.untracked).map((file) => file.path),
      commitSha: await getHeadSha(path),
    };
  }

  async getDiff(taskId: string, from?: string, to?: string): Promise<string> {
    const { path } = this.getTaskWorktreePath(taskId);
    return getDiff(path, from, to);
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

  async createValidationWorktree(taskId: string, commitSha: string): Promise<string> {
    const row = this.getTaskProject(taskId);
    const repositoryRoot = realpathSync(row.root_path);
    const worktreeRoot = this.getWorktreeRoot(row);
    const path = resolve(worktreeRoot, `validation-${taskSegment(taskId)}-${randomUUID()}`);
    const result = await runGit(["worktree", "add", "--detach", path, commitSha], { cwd: repositoryRoot });
    if (result.exitCode !== 0) throw gitFailure(result, "Unable to create validation worktree.");
    return path;
  }

  async removeValidationWorktree(taskId: string, worktreePath: string): Promise<void> {
    const row = this.getTaskProject(taskId);
    const repositoryRoot = realpathSync(row.root_path);
    const worktreeRoot = this.getWorktreeRoot(row);
    const path = resolve(worktreePath);
    const expectedPrefix = `validation-${taskSegment(taskId)}-`;
    if (dirname(path) !== worktreeRoot || !basename(path).startsWith(expectedPrefix)) {
      throw new Error("Refusing to remove a path that is not this task's validation worktree.");
    }
    if (!existsSync(path)) return;
    const canonicalPath = realpathSync(path);
    if (dirname(canonicalPath) !== worktreeRoot) {
      throw new Error("Refusing to remove a validation path outside the configured worktree root.");
    }
    const result = await runGit(["worktree", "remove", "--force", canonicalPath], { cwd: repositoryRoot });
    if (result.exitCode !== 0) throw gitFailure(result, "Unable to remove validation worktree.");
  }
}
