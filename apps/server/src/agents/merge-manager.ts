import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { realpathSync } from "node:fs";
import { runGit } from "../git/git-command.js";
import { getCurrentBranch, getGitOperationState, getHeadSha, getStatus } from "../git/repository.js";
import type { WorktreeManager } from "../git/worktree-manager.js";
import type { TaskOperationCoordinator } from "../task-operation-coordinator.js";

interface MergeOptions { confirmed: boolean; preview_id?: string }
interface MergeTask {
  id: string; workflow_state: string; root_path: string; base_branch: string | null; base_commit_sha: string | null;
  latest_task_commit_sha: string | null; worktree_path: string | null; agent_branch: string | null;
  ide_command: string | null;
}
interface MergeAttempt {
  id: string; task_id: string; approval_status: string; status: string; validated_base_sha: string;
  validated_task_sha: string; sync_base_sha: string | null; sync_candidate_sha: string | null; base_branch: string | null;
}

export interface MergeManagerOptions {
  db: Database.Database;
  worktrees: WorktreeManager;
  operations: TaskOperationCoordinator;
  beforeRefUpdate?: (input: { branch: string; expectedOldSha: string; candidateSha: string }) => Promise<void> | void;
}

function fail(message: string): Error { return Object.assign(new Error(message), { statusCode: 409 }); }
function gitError(result: { stderr: string }, fallback: string): Error { return fail(result.stderr.trim() || fallback); }

export class MergeManager {
  private readonly previews = new Map<string, { taskId: string; baseSha: string; taskSha: string; branch: string; baseBranch: string }>();
  constructor(private readonly options: MergeManagerOptions) {}

  private get db() { return this.options.db; }

  private task(taskId: string): MergeTask {
    const task = this.db.prepare(`SELECT t.id, t.workflow_state, t.base_branch, t.base_commit_sha, t.latest_task_commit_sha,
      t.worktree_path, t.agent_branch, p.root_path, p.ide_command
      FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`).get(taskId) as MergeTask | undefined;
    if (!task) throw Object.assign(new Error("Task not found."), { statusCode: 404 });
    return task;
  }

  async checkSync(taskId: string, acquireLock = true) {
    const blocked = (reasons: string[], currentBase: string | null = null, taskSha: string | null = null, branch: string | null = null,
      recordedBase: string | null = null, baseMoved = false) => ({
      task_id: taskId, status: "BLOCKED" as const, in_sync: false, base_sha: currentBase,
      recorded_base_sha: recordedBase, task_sha: taskSha, branch, base_moved: baseMoved,
      checked_at: new Date().toISOString(), reasons,
    });
    const release = acquireLock ? this.options.operations.tryAcquire(taskId) : undefined;
    if (acquireLock && !release) return blocked(["Another task operation is active; retry Check sync when it finishes."]);
    try {
      const task = this.task(taskId);
      const reasons: string[] = [];
      let currentBase: string | null = null;
      let state: Awaited<ReturnType<WorktreeManager["getTaskSyncState"]>> | null = null;
      if (task.workflow_state !== "REVIEW") reasons.push("Check sync is available only for tasks in Review.");
      if (!task.base_branch || !task.base_commit_sha || !task.worktree_path || !task.agent_branch) {
        reasons.push("Task base branch and task worktree metadata are required.");
      } else {
        try { currentBase = await this.options.worktrees.getBaseBranchTip(taskId); }
        catch (error) { reasons.push(error instanceof Error ? error.message : String(error)); }
        try { state = await this.options.worktrees.getTaskSyncState(taskId); }
        catch (error) { reasons.push(error instanceof Error ? error.message : String(error)); }
      }
      if (state) {
        if (state.branch !== task.agent_branch) reasons.push(`Task branch changed; expected ${task.agent_branch}.`);
        if (state.dirty) reasons.push("Task worktree has uncommitted changes.");
        if (state.operation) reasons.push(`A Git ${state.operation.toLowerCase()} operation is in progress.`);
        if (state.hasUnmergedPaths && !state.operation) reasons.push("Task worktree has unresolved Git conflicts.");
        if (!task.latest_task_commit_sha) reasons.push("Create a task checkpoint before checking sync readiness.");
        else if (state.headSha !== task.latest_task_commit_sha) reasons.push("Task HEAD differs from the recorded checkpoint.");
      }
      const activeSync = this.db.prepare(`SELECT 1 FROM git_sync_attempts WHERE task_id = ?
        AND status IN ('PREPARED', 'MERGING', 'RUNNING', 'CONFLICT', 'ABORTING', 'INTERRUPTED') LIMIT 1`).get(taskId);
      if (activeSync) reasons.push("Resolve or clear the active sync recovery before checking readiness.");
      const baseMoved = !!currentBase && currentBase !== task.base_commit_sha;
      let behindCurrentBase = false;
      const structurallySafe = !!state && !state.dirty && !state.operation && !state.hasUnmergedPaths &&
        state.branch === task.agent_branch && !!task.latest_task_commit_sha && state.headSha === task.latest_task_commit_sha &&
        !activeSync && task.workflow_state === "REVIEW";
      if (structurallySafe && currentBase) {
        try {
          behindCurrentBase = !await this.options.worktrees.isBaseAncestorOfTask(taskId, currentBase, state!.headSha);
          if (behindCurrentBase) reasons.push("The current base is not an ancestor of the task commit; use Sync with main, then check again.");
        } catch (error) {
          reasons.push(`Unable to verify current-base ancestry: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const status = reasons.length ? (structurallySafe && behindCurrentBase ? "STALE" as const : "BLOCKED" as const) : "IN_SYNC" as const;
      return { task_id: taskId, status, in_sync: status === "IN_SYNC", base_sha: currentBase,
        recorded_base_sha: task.base_commit_sha, task_sha: state?.headSha ?? null, branch: state?.branch ?? null,
        base_moved: baseMoved, checked_at: new Date().toISOString(), reasons };
    } finally { release?.(); }
  }

  async preview(taskId: string) {
    const task = this.task(taskId);
    const sync = await this.checkSync(taskId);
    const reasons = [...sync.reasons];
    const active = this.db.prepare(`SELECT 1 FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id
      WHERE r.task_id = ? AND j.status IN ('QUEUED', 'CLAIMED') LIMIT 1`).get(taskId);
    if (active) reasons.push("Another task run is active or queued.");
    const previewId = randomUUID();
    for (const [id, preview] of this.previews) if (preview.taskId === taskId) this.previews.delete(id);
    const eligible = sync.status === "IN_SYNC" && !active;
    if (sync.status === "IN_SYNC" && sync.base_sha && sync.task_sha && sync.branch && task.base_branch) {
      this.previews.set(previewId, { taskId, baseSha: sync.base_sha, taskSha: sync.task_sha,
        branch: sync.branch, baseBranch: task.base_branch });
    }
    return { task_id: taskId, eligible, reasons, base_branch: task.base_branch, candidate_sha: sync.task_sha,
      checked_base_sha: sync.base_sha, recorded_base_sha: sync.recorded_base_sha, current_base_sha: sync.base_sha,
      base_moved: sync.base_moved, sync_status: sync.status, checked_at: sync.checked_at, preview_id: previewId };
  }

  async start(taskId: string, options: MergeOptions) {
    if (!options.confirmed) throw fail("Explicit merge approval confirmation is required.");
    const release = this.options.operations.tryAcquire(taskId);
    if (!release) throw fail("Another operation is active for this task.");
    try {
      const prior = this.db.prepare("SELECT * FROM merge_attempts WHERE task_id = ? ORDER BY rowid DESC LIMIT 1").get(taskId) as MergeAttempt | undefined;
      if (prior?.status === "COMPLETED") {
        const task = this.task(taskId);
        if (task.latest_task_commit_sha === prior.validated_task_sha &&
          (this.db.prepare("SELECT workflow_state, resolution FROM tasks WHERE id = ?").get(taskId) as { workflow_state: string; resolution: string | null }).resolution === "MERGED") {
          return { status: "MERGED", merge_attempt_id: prior.id };
        }
      }
      if (!options.preview_id) throw fail("Merge preview is missing or expired; refresh Check sync and confirm again.");
      const approvedPreview = this.previews.get(options.preview_id);
      if (!approvedPreview || approvedPreview.taskId !== taskId) {
        throw fail("Merge preview is missing or expired; refresh Check sync and confirm again.");
      }
      const task = this.task(taskId);
      const sync = await this.checkSync(taskId, false);
      if (sync.status !== "IN_SYNC") {
        const advice = sync.status === "STALE" ? "Sync with main, then Check sync again." : "Resolve the blocked Git state, then Check sync again.";
        throw fail(`${sync.reasons.join(" ")} ${advice}`);
      }
      if (sync.base_sha !== approvedPreview.baseSha || sync.task_sha !== approvedPreview.taskSha ||
        sync.branch !== approvedPreview.branch || task.base_branch !== approvedPreview.baseBranch) {
        this.previews.delete(options.preview_id);
        throw fail("Git state changed since the merge preview; refresh Check sync and confirm again. If the base moved, Sync with main first.");
      }
      const active = this.db.prepare(`SELECT 1 FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id
        WHERE r.task_id = ? AND j.status IN ('QUEUED', 'CLAIMED') LIMIT 1`).get(taskId);
      if (active) throw fail("Another task run is active or queued.");
      this.previews.delete(options.preview_id);
      const now = new Date().toISOString();
      const attemptId = randomUUID();
      this.db.prepare(`INSERT INTO merge_attempts (id, task_id, approval_status,
        validated_base_sha, validated_task_sha, status, started_at, base_branch, sync_base_sha, sync_candidate_sha)
        VALUES (?, ?, 'APPROVED', ?, ?, 'APPROVED', ?, ?, ?, ?)`)
        .run(attemptId, taskId, sync.base_sha, sync.task_sha, now, task.base_branch, sync.base_sha, sync.task_sha);
      await this.integrate(task, attemptId, sync.base_sha!, sync.task_sha!);
      return { status: this.cleanupPending(taskId) ? "MERGED_CLEANUP_PENDING" : "MERGED", merge_attempt_id: attemptId };
    } finally { release(); }
  }

  private cleanupPending(taskId: string): boolean {
    const task = this.db.prepare("SELECT cleanup_status FROM tasks WHERE id = ?").get(taskId) as { cleanup_status: string | null };
    return task.cleanup_status === "CLEANUP_PENDING";
  }

  private async integrate(task: MergeTask, attemptId: string, expectedBase: string, candidate: string) {
    const root = realpathSync(task.root_path);
    const baseRef = `refs/heads/${task.base_branch}`;
    const live = await runGit(["rev-parse", "--verify", baseRef], { cwd: root });
    if (live.exitCode !== 0 || live.stdout.trim() !== expectedBase) {
      this.revoke(attemptId, "BASE_MOVED"); throw fail("Base ref changed; merge approval was revoked.");
    }
    if (await getCurrentBranch(task.worktree_path!) !== task.agent_branch ||
      await getHeadSha(task.worktree_path!) !== candidate || (await getStatus(task.worktree_path!)).length ||
      (await getGitOperationState(task.worktree_path!)).operation) {
      this.revoke(attemptId, "TASK_CHANGED"); throw fail("Task branch, candidate, worktree, or Git state changed; review, check sync, and confirm again.");
    }
    const ancestor = await runGit(["merge-base", "--is-ancestor", expectedBase, candidate], { cwd: root });
    if (ancestor.exitCode !== 0) { this.revoke(attemptId, "NOT_FAST_FORWARD"); throw fail("Task candidate is not a fast-forward of the base."); }
    this.db.prepare("UPDATE merge_attempts SET status = 'INTEGRATING' WHERE id = ?").run(attemptId);
    const worktrees = await runGit(["worktree", "list", "--porcelain"], { cwd: root });
    const branchLine = `branch ${baseRef}`;
    const entries = worktrees.stdout.split(/\n\n/);
    const checked = entries.find((entry) => entry.split("\n").includes(branchLine));
    if (checked) {
      const checkedPath = checked.match(/^worktree (.+)$/m)?.[1];
      if (!checkedPath || realpathSync(checkedPath) !== root) {
        this.revoke(attemptId, "BASE_IN_LINKED_WORKTREE");
        throw fail("Base is checked out in a non-primary linked worktree. Detach or move that worktree, then retry.");
      }
      if (await getCurrentBranch(root) !== task.base_branch || await getHeadSha(root) !== expectedBase ||
        (await getStatus(root)).length || (await getGitOperationState(root)).operation) {
        this.revoke(attemptId, "PRIMARY_CHECKOUT_UNSAFE");
        throw fail("Primary checkout is dirty, busy, or no longer on the base branch; preserve its state and retry when safe.");
      }
      const update = await runGit(["update-ref", baseRef, candidate, expectedBase], { cwd: root });
      if (update.exitCode !== 0) { this.revoke(attemptId, "REF_CAS_FAILED"); throw gitError(update, "Base ref changed during merge; approval was revoked."); }
      const reset = await runGit(["reset", "--keep", candidate], { cwd: root });
      if (reset.exitCode !== 0) { this.revoke(attemptId, "PRIMARY_CHECKOUT_UPDATE_FAILED"); throw gitError(reset, "The base ref moved but the primary checkout could not be safely updated; preserve it and reconcile."); }
    } else {
      await this.options.beforeRefUpdate?.({ branch: task.base_branch!, expectedOldSha: expectedBase, candidateSha: candidate });
      const update = await runGit(["update-ref", baseRef, candidate, expectedBase], { cwd: root });
      if (update.exitCode !== 0) { this.revoke(attemptId, "REF_CAS_FAILED"); throw gitError(update, "Base ref changed during merge; approval was revoked."); }
    }
    if ((await runGit(["rev-parse", baseRef], { cwd: root })).stdout.trim() !== candidate) {
      this.revoke(attemptId, "POST_MERGE_CHECK_FAILED"); throw fail("Post-merge ref verification failed; approval was revoked.");
    }
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE merge_attempts SET status = 'COMPLETED', completed_at = ?, error_reason = NULL WHERE id = ?").run(now, attemptId);
      this.db.prepare("UPDATE tasks SET workflow_state = 'DONE', resolution = 'MERGED', updated_at = ? WHERE id = ?").run(now, task.id);
    })();
    try { await this.options.worktrees.removeTaskWorktree(task.id); }
    catch { /* successful integration remains authoritative; cleanup is retried separately */ }
  }

  private revoke(attemptId: string, reason: string) {
    this.db.prepare("UPDATE merge_attempts SET approval_status = 'REVOKED', status = ?, error_reason = ? WHERE id = ?")
      .run(reason, reason, attemptId);
  }
  async retry(taskId: string) {
    const release = this.options.operations.tryAcquire(taskId);
    if (!release) throw fail("Another operation is active for this task.");
    try {
      const task = this.task(taskId);
      const operation = await getGitOperationState(task.worktree_path!);
      if (operation.operation || (await runGit(["ls-files", "-u"], { cwd: task.worktree_path! })).stdout.trim()) {
        throw fail("Resolve the merge conflicts in the IDE and commit the resolution before Retry.");
      }
    const state = await this.options.worktrees.getTaskWorktreeState(taskId);
    if (state.dirty) throw fail("Commit the resolved conflict as a checkpoint before Retry.");
    const branch = await getCurrentBranch(task.worktree_path!);
    if (branch !== task.agent_branch) throw fail("Task branch changed; cannot retry merge recovery.");
    this.db.prepare("UPDATE tasks SET latest_task_commit_sha = ?, workflow_state = 'REVIEW', review_tag = 'WORK_COMPLETE', updated_at = ? WHERE id = ?")
      .run(state.head_sha, new Date().toISOString(), taskId);
    const attempt = this.db.prepare("SELECT id FROM merge_attempts WHERE task_id = ? ORDER BY rowid DESC LIMIT 1").get(taskId) as { id: string };
    this.revoke(attempt.id, "MANUAL_RESOLUTION");
    return { status: "CHECK_SYNC_REQUIRED" };
    } finally { release(); }
  }

  async abort(taskId: string) {
    const release = this.options.operations.tryAcquire(taskId);
    if (!release) throw fail("Another operation is active for this task.");
    try {
    const task = this.task(taskId);
    const latestAttempt = this.db.prepare("SELECT id, status FROM merge_attempts WHERE task_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(taskId) as { id: string; status: string } | undefined;
    const operation = await getGitOperationState(task.worktree_path!);
    if (!latestAttempt || latestAttempt.status !== "MERGE_CONFLICT" || operation.operation !== "MERGE") {
      throw fail("There is no active Phase 9 base-sync conflict to abort.");
    }
    const result = await runGit(["merge", "--abort"], { cwd: task.worktree_path! });
    if (result.exitCode !== 0) throw gitError(result, "Unable to abort the base sync; preserve the worktree and resolve Git state manually.");
    this.db.prepare("UPDATE merge_attempts SET status = 'ABORTED', approval_status = 'REVOKED' WHERE id = ?").run(latestAttempt.id);
    this.db.prepare("UPDATE tasks SET workflow_state = 'REVIEW', review_tag = 'WORK_COMPLETE', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), taskId);
    return { status: "ABORTED" };
    } finally { release(); }
  }

  async viewConflicts(taskId: string) { await this.options.worktrees.openInIDE(taskId); return { status: "OPENED" }; }

  async reconcileAfterRestart() {
    const pending = this.db.prepare("SELECT * FROM merge_attempts WHERE status NOT IN ('COMPLETED', 'MERGE_CONFLICT')").all() as MergeAttempt[];
    for (const attempt of pending) {
      const task = this.task(attempt.task_id);
      const base = await runGit(["rev-parse", "--verify", `refs/heads/${attempt.base_branch ?? task.base_branch}`], { cwd: realpathSync(task.root_path) });
      if (attempt.status === "INTEGRATING" && attempt.validated_task_sha && base.exitCode === 0 && base.stdout.trim() === attempt.validated_task_sha) {
        const now = new Date().toISOString();
        this.db.transaction(() => {
          this.db.prepare("UPDATE merge_attempts SET status = 'COMPLETED', completed_at = ? WHERE id = ?").run(now, attempt.id);
          this.db.prepare("UPDATE tasks SET workflow_state = 'DONE', resolution = 'MERGED', updated_at = ? WHERE id = ?").run(now, task.id);
        })();
      } else {
        this.revoke(attempt.id, "RESTARTED");
      }
    }
    const completed = this.db.prepare("SELECT task_id FROM merge_attempts WHERE status = 'COMPLETED'").all() as Array<{ task_id: string }>;
    for (const row of completed) {
      try { await this.options.worktrees.removeTaskWorktree(row.task_id); } catch { /* retain visible cleanup state */ }
    }
  }
}
