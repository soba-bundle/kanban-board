import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { TaskOperationCoordinator } from "../task-operation-coordinator.js";
import type { WorktreeManager } from "../git/worktree-manager.js";

interface SyncTask {
  id: string;
  workflow_state: string;
  base_branch: string;
  base_commit_sha: string;
  latest_task_commit_sha: string | null;
  worktree_path: string;
  agent_branch: string;
}
interface SyncAttempt {
  id: string;
  task_id: string;
  status: string;
  base_sha: string;
  prior_base_sha: string;
  base_branch: string;
  task_branch: string;
  prior_task_sha: string;
  prior_task_recorded_sha: string | null;
  candidate_sha: string | null;
  conflict_state_token: string | null;
  error_message: string | null;
}

export type SyncRecoveryState = "CONFLICT" | "RESOLUTION_COMMITTED" | "SAFE_TO_RETRY" | "INTERRUPTED";
export interface SyncRecovery {
  attempt_id: string;
  state: SyncRecoveryState;
  base_sha: string;
  prior_task_sha: string;
  current_candidate_sha: string | null;
  can_abort: boolean;
  error_message: string | null;
}

function fail(message: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { statusCode });
}

export interface GitSyncManagerOptions {
  db: Database.Database;
  worktrees: WorktreeManager;
  operations: TaskOperationCoordinator;
}

export class GitSyncManager {
  constructor(private readonly options: GitSyncManagerOptions) {}

  async syncWithBase(taskId: string) {
    const release = this.options.operations.tryAcquire(taskId);
    if (!release) throw fail("Another operation is active for this task.");
    try { return await this.startSync(taskId); }
    finally { release(); }
  }

  private task(taskId: string): SyncTask {
    const task = this.options.db.prepare(`SELECT t.id, t.workflow_state, t.base_branch, t.base_commit_sha,
      t.latest_task_commit_sha, t.worktree_path, t.agent_branch FROM tasks t
      JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND t.is_active = 1 AND p.is_active = 1`)
      .get(taskId) as SyncTask | undefined;
    if (!task) throw fail("Task not found.", 404);
    if (task.workflow_state !== "REVIEW") throw fail("Only tasks in Review can sync with main.");
    if (!task.base_branch || !task.base_commit_sha || !task.agent_branch || !task.worktree_path) {
      throw fail("Task worktree and base-branch metadata are required before syncing.");
    }
    return task;
  }

  private latestActiveAttempt(taskId: string): SyncAttempt | undefined {
    return this.options.db.prepare(`SELECT * FROM git_sync_attempts WHERE task_id = ?
      AND status IN ('PREPARED', 'MERGING', 'RUNNING', 'CONFLICT', 'ABORTING', 'INTERRUPTED') ORDER BY rowid DESC LIMIT 1`)
      .get(taskId) as SyncAttempt | undefined;
  }

  private assertNoActiveAttempt(taskId: string): void {
    if (this.latestActiveAttempt(taskId)) {
      throw fail("An active sync recovery exists; inspect or resolve it before starting another sync.");
    }
  }

  private assertNoActiveRun(taskId: string): void {
    const active = this.options.db.prepare(`SELECT 1 FROM task_runs r LEFT JOIN agent_jobs j ON j.task_run_id = r.id
      WHERE r.task_id = ? AND (r.status IN ('QUEUED', 'RUNNING', 'WAITING_FOR_HUMAN', 'WAITING_FOR_INFERENCE')
        OR j.status IN ('QUEUED', 'CLAIMED')) LIMIT 1`).get(taskId);
    if (active) throw fail("Stop or finish active work before syncing with main.");
  }

  private async startSync(taskId: string) {
    this.assertNoActiveAttempt(taskId);
    const task = this.task(taskId);
    this.assertNoActiveRun(taskId);
    const baseSha = await this.options.worktrees.getBaseBranchTip(taskId);
    const state = await this.options.worktrees.getTaskSyncState(taskId);
    const priorTaskSha = task.latest_task_commit_sha ?? task.base_commit_sha!;
    if (state.branch !== task.agent_branch) throw fail(`Task branch changed; expected ${task.agent_branch}.`);
    if (state.headSha !== priorTaskSha) throw fail("Task branch tip changed; refresh task state before syncing.");
    if (state.operation) throw fail(`A Git ${state.operation.toLowerCase()} operation is already in progress.`);
    if (state.dirty) throw fail("Task worktree is dirty; checkpoint or preserve its changes before syncing.");

    const attemptId = randomUUID();
    const startedAt = new Date().toISOString();
    this.options.db.prepare(`INSERT INTO git_sync_attempts (id, task_id, status, base_sha, prior_base_sha,
      base_branch, task_branch, prior_task_sha, prior_task_recorded_sha, started_at)
      VALUES (?, ?, 'PREPARED', ?, ?, ?, ?, ?, ?, ?)`)
      .run(attemptId, taskId, baseSha, task.base_commit_sha, task.base_branch, task.agent_branch,
        priorTaskSha, task.latest_task_commit_sha, startedAt);

    try {
      const merging = this.options.db.prepare("UPDATE git_sync_attempts SET status = 'MERGING' WHERE id = ? AND status = 'PREPARED'")
        .run(attemptId);
      if (merging.changes !== 1) throw fail("Sync attempt changed before Git started; inspect recovery before retrying.");
      const result = await this.options.worktrees.mergeBaseIntoTask(taskId, {
        baseSha, expectedBranch: task.agent_branch, expectedHead: priorTaskSha,
      });
      if (result.status === "CONFLICT") {
        const conflictState = await this.options.worktrees.getTaskSyncState(taskId);
        const recorded = this.options.db.prepare(`UPDATE git_sync_attempts SET status = 'CONFLICT', candidate_sha = ?,
          conflict_state_token = ?, error_message = ? WHERE id = ? AND status = 'MERGING'`)
          .run(result.candidateSha, conflictState.stateToken, "Resolve the sync conflict in the task worktree.", attemptId);
        if (recorded.changes !== 1) {
          throw fail("Conflict state was not recorded; preserve the task worktree and inspect sync recovery.");
        }
        return { status: "CONFLICT" as const, synced_base_sha: baseSha, candidate_sha: result.candidateSha, attempt_id: attemptId };
      }
      await this.completeAttempt(task, {
        id: attemptId, task_id: taskId, status: "MERGING", base_sha: baseSha, prior_base_sha: task.base_commit_sha,
        base_branch: task.base_branch, task_branch: task.agent_branch, prior_task_sha: priorTaskSha,
        prior_task_recorded_sha: task.latest_task_commit_sha, candidate_sha: result.candidateSha, conflict_state_token: null,
        error_message: null,
      }, result.candidateSha);
      return { status: "SYNCED" as const, synced_base_sha: baseSha, candidate_sha: result.candidateSha, attempt_id: attemptId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = await this.options.worktrees.getTaskSyncState(taskId).catch(() => null);
      if (current && (current.operation === "MERGE" || current.hasUnmergedPaths)) {
        this.options.db.prepare(`UPDATE git_sync_attempts SET status = 'CONFLICT', candidate_sha = ?,
          conflict_state_token = ?, error_message = ? WHERE id = ? AND status = 'MERGING'`)
          .run(current.headSha, current.stateToken, message, attemptId);
      } else if (current && current.branch === task.agent_branch && current.headSha === priorTaskSha && !current.dirty && !current.operation) {
        this.options.db.prepare(`UPDATE git_sync_attempts SET status = 'FAILED', completed_at = ?, error_message = ?
          WHERE id = ? AND status = 'MERGING'`).run(new Date().toISOString(), message, attemptId);
      } else {
        this.options.db.prepare(`UPDATE git_sync_attempts SET status = 'INTERRUPTED', candidate_sha = ?, error_message = ?
          WHERE id = ? AND status = 'MERGING'`).run(current?.headSha ?? null, message, attemptId);
      }
      throw error;
    }
  }

  private async completeAttempt(task: SyncTask, attempt: SyncAttempt, candidateSha: string) {
    const state = await this.options.worktrees.getTaskSyncState(task.id);
    const contains = await this.options.worktrees.taskSyncContains(task.id, attempt.base_sha, attempt.prior_task_sha, candidateSha);
    if (state.branch !== attempt.task_branch || state.headSha !== candidateSha || state.dirty || state.operation || state.hasUnmergedPaths || !contains) {
      throw fail("The task worktree changed before sync could be recorded; preserve it and inspect recovery.");
    }
    const now = new Date().toISOString();
    this.options.db.transaction(() => {
      const updated = this.options.db.prepare(`UPDATE tasks SET base_commit_sha = ?, latest_task_commit_sha = ?,
        updated_at = ? WHERE id = ? AND workflow_state = 'REVIEW'
        AND base_branch = ? AND base_commit_sha = ? AND agent_branch = ? AND worktree_path = ?
        AND latest_task_commit_sha IS ?`).run(
          attempt.base_sha, candidateSha, now, task.id, attempt.base_branch, attempt.prior_base_sha,
          attempt.task_branch, task.worktree_path, attempt.prior_task_recorded_sha,
        );
      if (updated.changes !== 1) {
        throw fail("Sync finished but task metadata changed; preserve the task worktree and refresh before continuing.");
      }
      const recorded = this.options.db.prepare(`UPDATE git_sync_attempts SET status = 'SYNCED', candidate_sha = ?,
        completed_at = ?, error_message = NULL WHERE id = ? AND status IN ('PREPARED', 'MERGING', 'RUNNING', 'CONFLICT', 'ABORTING', 'INTERRUPTED')`)
        .run(candidateSha, now, attempt.id);
      if (recorded.changes !== 1) throw fail("Sync attempt state changed; preserve the worktree and inspect sync recovery.");
    })();
  }

  async getSyncRecovery(taskId: string): Promise<SyncRecovery | null> {
    const attempt = this.latestActiveAttempt(taskId);
    if (!attempt) return null;
    const task = this.task(taskId);
    let state: Awaited<ReturnType<WorktreeManager["getTaskSyncState"]>>;
    try { state = await this.options.worktrees.getTaskSyncState(taskId); }
    catch (error) {
      return { attempt_id: attempt.id, state: "INTERRUPTED", base_sha: attempt.base_sha,
        prior_task_sha: attempt.prior_task_sha, current_candidate_sha: null, can_abort: false,
        error_message: error instanceof Error ? error.message : String(error) };
    }
    if (state.operation === "MERGE" || state.hasUnmergedPaths) {
      return { attempt_id: attempt.id, state: "CONFLICT", base_sha: attempt.base_sha,
        prior_task_sha: attempt.prior_task_sha, current_candidate_sha: state.headSha,
        can_abort: state.operation === "MERGE" && !!attempt.conflict_state_token && state.stateToken === attempt.conflict_state_token,
        error_message: attempt.error_message };
    }
    if (!state.dirty && state.branch === attempt.task_branch) {
      const contains = await this.options.worktrees.taskSyncContains(taskId, attempt.base_sha, attempt.prior_task_sha, state.headSha);
      if (contains) return { attempt_id: attempt.id, state: "RESOLUTION_COMMITTED", base_sha: attempt.base_sha,
        prior_task_sha: attempt.prior_task_sha, current_candidate_sha: state.headSha, can_abort: false,
        error_message: attempt.error_message };
      if (state.headSha === attempt.prior_task_sha && attempt.status === "PREPARED") return { attempt_id: attempt.id, state: "SAFE_TO_RETRY",
        base_sha: attempt.base_sha, prior_task_sha: attempt.prior_task_sha, current_candidate_sha: state.headSha,
        can_abort: false, error_message: attempt.error_message };
      if (state.headSha === attempt.prior_task_sha) return { attempt_id: attempt.id, state: "INTERRUPTED",
        base_sha: attempt.base_sha, prior_task_sha: attempt.prior_task_sha, current_candidate_sha: state.headSha,
        can_abort: true, error_message: "No Git operation is in progress. Confirm Abort to clear this recovery before starting a fresh sync." };
    }
    return { attempt_id: attempt.id, state: "INTERRUPTED", base_sha: attempt.base_sha,
      prior_task_sha: attempt.prior_task_sha, current_candidate_sha: state.headSha, can_abort: false,
      error_message: attempt.error_message ?? "Git state does not match a safely recoverable sync state." };
  }

  async viewSyncConflicts(taskId: string) {
    const release = this.options.operations.tryAcquire(taskId);
    if (!release) throw fail("Another operation is active for this task.");
    try {
      if (!this.latestActiveAttempt(taskId)) throw fail("There is no active sync recovery for this task.");
      await this.options.worktrees.openInIDE(taskId);
      return { status: "OPENED" as const };
    } finally { release(); }
  }

  async abortSync(taskId: string, confirmed: boolean) {
    if (confirmed !== true) throw fail("Explicit abort confirmation is required.");
    const release = this.options.operations.tryAcquire(taskId);
    if (!release) throw fail("Another operation is active for this task.");
    try {
      const attempt = this.latestActiveAttempt(taskId);
      if (!attempt) throw fail("There is no active sync to abort.");
      const recovery = await this.getSyncRecovery(taskId);
      if (!recovery || !recovery.can_abort || !["CONFLICT", "INTERRUPTED"].includes(recovery.state)) {
        throw fail("The task worktree changed or its sync state is ambiguous; preserve it and resolve or inspect before aborting.");
      }
      const state = await this.options.worktrees.getTaskSyncState(taskId);
      const hasMerge = state.operation === "MERGE" || state.hasUnmergedPaths;
      const alreadyAtPrior = !state.operation && !state.hasUnmergedPaths && !state.dirty &&
        state.branch === attempt.task_branch && state.headSha === attempt.prior_task_sha;
      if ((!hasMerge && !alreadyAtPrior) || (hasMerge && (!attempt.conflict_state_token || state.stateToken !== attempt.conflict_state_token))) {
        throw fail("The task worktree changed since the saved sync state; preserve its edits and inspect before aborting.");
      }
      const claimed = this.options.db.prepare(`UPDATE git_sync_attempts SET status = 'ABORTING'
        WHERE id = ? AND status IN ('MERGING', 'RUNNING', 'CONFLICT', 'ABORTING', 'INTERRUPTED')`).run(attempt.id);
      if (claimed.changes !== 1) throw fail("Sync recovery changed before abort; refresh its status and retry explicitly.");
      if (hasMerge) {
        await this.options.worktrees.abortTaskSync(taskId, {
          expectedBranch: attempt.task_branch,
          expectedHead: attempt.prior_task_sha,
          stateToken: attempt.conflict_state_token!,
        });
      }
      const recorded = this.options.db.prepare(`UPDATE git_sync_attempts SET status = 'ABORTED', completed_at = ?, error_message = NULL
        WHERE id = ? AND status = 'ABORTING'`).run(new Date().toISOString(), attempt.id);
      if (recorded.changes !== 1) throw fail("Abort could not be recorded; inspect sync recovery before continuing.");
      return { status: "ABORTED" as const };
    } finally { release(); }
  }

  async retrySync(taskId: string) {
    const release = this.options.operations.tryAcquire(taskId);
    if (!release) throw fail("Another operation is active for this task.");
    try {
      const attempt = this.latestActiveAttempt(taskId);
      if (!attempt) throw fail("There is no active sync recovery to continue.");
      const task = this.task(taskId);
      const state = await this.options.worktrees.getTaskSyncState(taskId);
      if (state.operation || state.hasUnmergedPaths) {
        throw fail("Resolve and commit the sync conflict before Retry; the merge will not be repeated.");
      }
      if (state.dirty || state.branch !== attempt.task_branch) {
        throw fail("Task worktree is changed or on the wrong branch; preserve its state and inspect it before Retry.");
      }
      const contains = await this.options.worktrees.taskSyncContains(taskId, attempt.base_sha, attempt.prior_task_sha, state.headSha);
      if (contains) {
        await this.completeAttempt(task, attempt, state.headSha);
        return { status: "SYNCED" as const, synced_base_sha: attempt.base_sha, candidate_sha: state.headSha };
      }
      if (state.headSha !== attempt.prior_task_sha || attempt.status !== "PREPARED") {
        throw fail("Sync state is ambiguous or may have been aborted; confirm Abort to clear recovery, then start a fresh sync.");
      }
      const cleared = this.options.db.prepare(`UPDATE git_sync_attempts SET status = 'ABORTED', completed_at = ?,
        error_message = 'Prepared sync was explicitly superseded by a fresh retry.' WHERE id = ? AND status = 'PREPARED'`)
        .run(new Date().toISOString(), attempt.id);
      if (cleared.changes !== 1) throw fail("Sync recovery changed; refresh its status before retrying.");
      return await this.startSync(taskId);
    } finally { release(); }
  }
}
