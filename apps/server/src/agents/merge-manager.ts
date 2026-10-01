import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { realpathSync } from "node:fs";
import { runGit } from "../git/git-command.js";
import { getCurrentBranch, getGitOperationState, getHeadSha, getStatus } from "../git/repository.js";
import type { WorktreeManager } from "../git/worktree-manager.js";
import type { TaskOperationCoordinator } from "../task-operation-coordinator.js";

interface MergeOptions { confirmed: boolean; preview_id?: string }
interface MergeTask {
  id: string; root_path: string; base_branch: string | null; base_commit_sha: string | null;
  latest_task_commit_sha: string | null; worktree_path: string | null; agent_branch: string | null;
  active_validation_snapshot_id: string | null; ide_command: string | null;
}
interface MergeAttempt {
  id: string; task_id: string; approval_status: string; status: string; validated_base_sha: string;
  validated_task_sha: string; validation_snapshot_id: string | null; priority_validation_run_id: string | null;
  sync_base_sha: string | null; sync_candidate_sha: string | null; base_branch: string | null;
}

export interface MergeManagerOptions {
  db: Database.Database;
  worktrees: WorktreeManager;
  operations: TaskOperationCoordinator;
  validation: { start(taskId: string, options?: { priority?: boolean }): Promise<{ run_id: string; status: string }> };
  beforeRefUpdate?: (input: { branch: string; expectedOldSha: string; candidateSha: string }) => Promise<void> | void;
}

function fail(message: string): Error { return Object.assign(new Error(message), { statusCode: 409 }); }
function gitError(result: { stderr: string }, fallback: string): Error { return fail(result.stderr.trim() || fallback); }

export class MergeManager {
  private readonly previews = new Map<string, string>();
  constructor(private readonly options: MergeManagerOptions) {}

  private get db() { return this.options.db; }

  private task(taskId: string): MergeTask {
    const task = this.db.prepare(`SELECT t.id, t.base_branch, t.base_commit_sha, t.latest_task_commit_sha,
      t.worktree_path, t.agent_branch, t.active_validation_snapshot_id, p.root_path, p.ide_command
      FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`).get(taskId) as MergeTask | undefined;
    if (!task) throw Object.assign(new Error("Task not found."), { statusCode: 404 });
    return task;
  }

  async preview(taskId: string) {
    const task = this.task(taskId);
    const reasons: string[] = [];
    let liveBase = "";
    try {
      if (!task.base_branch || !task.base_commit_sha || !task.latest_task_commit_sha || !task.worktree_path || !task.agent_branch) {
        reasons.push("Create a task checkpoint and worktree before merging.");
      } else {
        liveBase = (await runGit(["rev-parse", "--verify", `refs/heads/${task.base_branch}`], { cwd: realpathSync(task.root_path) })).stdout.trim();
        if (await getCurrentBranch(task.worktree_path) !== task.agent_branch) reasons.push("Task branch changed.");
        if (await getHeadSha(task.worktree_path) !== task.latest_task_commit_sha) reasons.push("Task checkpoint changed.");
        if ((await getStatus(task.worktree_path)).length) reasons.push("Task worktree has uncommitted changes.");
        if ((await getGitOperationState(task.worktree_path)).operation) reasons.push("A Git operation is in progress.");
        const snapshot = task.active_validation_snapshot_id ? this.db.prepare(`SELECT s.id, s.validated_task_sha,
          s.validated_base_sha, s.result, r.findings_json FROM validation_snapshots s
          JOIN validation_results r ON r.run_id = s.validation_run_id WHERE s.id = ?`).get(task.active_validation_snapshot_id) as {
            id: string; validated_task_sha: string; validated_base_sha: string; result: string; findings_json: string | null;
          } | undefined : undefined;
        if (!snapshot || snapshot.result !== "PASSED" || snapshot.validated_task_sha !== task.latest_task_commit_sha ||
          snapshot.validated_base_sha !== task.base_commit_sha) reasons.push("A current passing Validation is required.");
        if (snapshot?.findings_json && JSON.parse(snapshot.findings_json).some((finding: { attribution?: string }) =>
          finding.attribution === "DIRECT" || finding.attribution === "UNCERTAIN")) reasons.push("Validation findings block merge.");
        const guidance = this.db.prepare(`SELECT COUNT(*) AS count FROM run_inputs i JOIN task_runs r ON r.id = i.run_id
          WHERE r.task_id = ? AND i.delivery_type = 'STEERING' AND i.delivery_status = 'DELIVERED'
          AND i.sequence > COALESCE((SELECT CAST(messages_watermark AS INTEGER) FROM validation_snapshots WHERE id = ?), 0)`)
          .get(taskId, snapshot?.id ?? "") as { count: number };
        if (guidance.count > 0) reasons.push("New guidance requires fresh Validation.");
        const active = this.db.prepare(`SELECT 1 FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id
          WHERE r.task_id = ? AND j.status IN ('QUEUED', 'CLAIMED') LIMIT 1`).get(taskId);
        if (active) reasons.push("Another task run is active or queued.");
      }
    } catch (error) { reasons.push(error instanceof Error ? error.message : String(error)); }
    const previewId = randomUUID();
    this.previews.set(previewId, `${taskId}:${task.latest_task_commit_sha ?? ""}:${task.base_commit_sha ?? ""}`);
    return { task_id: taskId, eligible: reasons.length === 0, reasons, candidate_sha: task.latest_task_commit_sha,
      validated_base_sha: task.base_commit_sha, current_base_sha: liveBase, base_moved: !!liveBase && liveBase !== task.base_commit_sha,
      preview_id: previewId };
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
      const task = this.task(taskId);
      const preview = await this.preview(taskId);
      if (!preview.eligible) throw fail(preview.reasons.join(" "));
      if (options.preview_id && this.previews.get(options.preview_id) !== `${taskId}:${task.latest_task_commit_sha}:${task.base_commit_sha}`) {
        throw fail("Merge preview changed; review the current candidate and try again.");
      }
      const snapshot = this.db.prepare("SELECT id FROM validation_snapshots WHERE id = ?").get(task.active_validation_snapshot_id) as { id: string };
      const now = new Date().toISOString();
      const attemptId = randomUUID();
      this.db.prepare(`INSERT INTO merge_attempts (id, task_id, validation_snapshot_id, approval_status,
        validated_base_sha, validated_task_sha, status, started_at, base_branch)
        VALUES (?, ?, ?, 'APPROVED', ?, ?, 'APPROVED', ?, ?)`)
        .run(attemptId, taskId, snapshot.id, task.base_commit_sha, task.latest_task_commit_sha, now, task.base_branch);
      if (preview.current_base_sha !== task.base_commit_sha) {
        return await this.syncMovedBase(task, attemptId, preview.current_base_sha);
      }
      await this.integrate(task, attemptId, task.base_commit_sha!, task.latest_task_commit_sha!);
      return { status: this.cleanupPending(taskId) ? "MERGED_CLEANUP_PENDING" : "MERGED", merge_attempt_id: attemptId };
    } finally { release(); }
  }

  private async syncMovedBase(task: MergeTask, attemptId: string, baseSha: string) {
    const worktree = task.worktree_path!;
    const merge = await runGit(["merge", "--no-edit", baseSha], { cwd: worktree });
    if (merge.exitCode !== 0) {
      const operation = await getGitOperationState(worktree);
      if (operation.operation === "MERGE" || (await runGit(["ls-files", "-u"], { cwd: worktree })).stdout.trim()) {
        this.db.prepare("UPDATE merge_attempts SET approval_status = 'REVOKED', status = 'MERGE_CONFLICT', error_reason = ? WHERE id = ?")
          .run(merge.stderr.trim() || "Base sync has conflicts.", attemptId);
        this.db.prepare("UPDATE tasks SET workflow_state = 'REVIEW', review_tag = 'MERGE_CONFLICT', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), task.id);
        return { status: "MERGE_CONFLICT", merge_attempt_id: attemptId };
      }
      this.revoke(attemptId, "BASE_SYNC_FAILED");
      throw gitError(merge, "Unable to sync the current base into the task branch.");
    }
    const candidate = await getHeadSha(worktree);
    this.db.prepare(`UPDATE tasks SET base_commit_sha = ?, latest_task_commit_sha = ?, active_validation_snapshot_id = NULL,
      review_tag = 'IMPLEMENTATION_COMPLETE', updated_at = ? WHERE id = ?`).run(baseSha, candidate, new Date().toISOString(), task.id);
    this.db.prepare("UPDATE merge_attempts SET status = 'VALIDATION_QUEUED', sync_base_sha = ?, sync_candidate_sha = ? WHERE id = ?")
      .run(baseSha, candidate, attemptId);
    try {
      const validation = await this.options.validation.start(task.id, { priority: true });
      this.db.prepare("UPDATE merge_attempts SET priority_validation_run_id = ? WHERE id = ?").run(validation.run_id, attemptId);
      return { status: "VALIDATION_QUEUED", merge_attempt_id: attemptId, run_id: validation.run_id };
    } catch (error) {
      this.revoke(attemptId, "VALIDATION_START_FAILED");
      throw error;
    }
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
      this.revoke(attemptId, "TASK_CHANGED"); throw fail("Task branch, candidate, worktree, or Git state changed; review and validate again.");
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
      this.db.prepare("UPDATE tasks SET workflow_state = 'DONE', resolution = 'MERGED', active_validation_snapshot_id = NULL, updated_at = ? WHERE id = ?").run(now, task.id);
    })();
    try { await this.options.worktrees.removeTaskWorktree(task.id); }
    catch { /* successful integration remains authoritative; cleanup is retried separately */ }
  }

  private revoke(attemptId: string, reason: string) {
    this.db.prepare("UPDATE merge_attempts SET approval_status = 'REVOKED', status = ?, error_reason = ? WHERE id = ?")
      .run(reason, reason, attemptId);
  }

  async onValidationStopped(attemptId: string, runId: string) {
    const attempt = this.db.prepare("SELECT * FROM merge_attempts WHERE id = ?").get(attemptId) as MergeAttempt | undefined;
    if (!attempt || attempt.priority_validation_run_id !== runId || attempt.approval_status !== "APPROVED") return { status: "APPROVAL_REVOKED" };
    this.revoke(attemptId, "VALIDATION_STOPPED");
    this.db.prepare("UPDATE tasks SET workflow_state = 'REVIEW', review_tag = 'VALIDATION_FAILED', active_validation_snapshot_id = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), attempt.task_id);
    return { status: "VALIDATION_STOPPED" };
  }

  async onJobRemoved(jobId: string) {
    const run = this.db.prepare("SELECT r.id, r.task_id, r.stage FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id WHERE j.id = ?")
      .get(jobId) as { id: string; task_id: string; stage: string } | undefined;
    if (!run || run.stage !== "VALIDATION_REVIEW") return;
    const attempt = this.db.prepare("SELECT id FROM merge_attempts WHERE priority_validation_run_id = ? AND approval_status = 'APPROVED'")
      .get(run.id) as { id: string } | undefined;
    if (attempt) await this.onValidationStopped(attempt.id, run.id);
  }

  async onValidationCompleted(attemptId: string, runId: string) {
    const attempt = this.db.prepare("SELECT * FROM merge_attempts WHERE id = ?").get(attemptId) as MergeAttempt | undefined;
    if (!attempt || attempt.priority_validation_run_id !== runId || attempt.approval_status !== "APPROVED") return { status: "APPROVAL_REVOKED" };
    const task = this.task(attempt.task_id);
    const currentBase = (await runGit(["rev-parse", "--verify", `refs/heads/${attempt.base_branch}`], { cwd: realpathSync(task.root_path) })).stdout.trim();
    if (currentBase !== attempt.sync_base_sha) { this.revoke(attemptId, "BASE_MOVED_AGAIN"); return { status: "REAPPROVAL_REQUIRED" }; }
    const snapshot = this.db.prepare(`SELECT s.id, s.validated_task_sha, s.validated_base_sha, s.result, r.findings_json
      FROM validation_snapshots s JOIN validation_results r ON r.run_id = s.validation_run_id WHERE s.id = ?`)
      .get(task.active_validation_snapshot_id) as { id: string; validated_task_sha: string; validated_base_sha: string; result: string; findings_json: string | null } | undefined;
    const invalidFindings = snapshot?.findings_json && JSON.parse(snapshot.findings_json).some((finding: { attribution?: string }) =>
      finding.attribution === "DIRECT" || finding.attribution === "UNCERTAIN");
    const watermark = snapshot && this.db.prepare("SELECT CAST(messages_watermark AS INTEGER) AS value FROM validation_snapshots WHERE id = ?")
      .get(snapshot.id) as { value: number } | undefined;
    const newGuidance = this.db.prepare(`SELECT 1 FROM run_inputs i JOIN task_runs r ON r.id = i.run_id
      WHERE r.task_id = ? AND i.delivery_type = 'STEERING' AND i.delivery_status = 'DELIVERED'
      AND i.sequence > COALESCE(?, 0) LIMIT 1`).get(task.id, watermark?.value ?? 0);
    if (!snapshot || snapshot.result !== "PASSED" || invalidFindings || newGuidance ||
      snapshot.validated_task_sha !== attempt.sync_candidate_sha || snapshot.validated_base_sha !== attempt.sync_base_sha) {
      this.revoke(attemptId, "VALIDATION_NOT_READY");
      return { status: "APPROVAL_REVOKED" };
    }
    await this.integrate(task, attemptId, attempt.sync_base_sha!, attempt.sync_candidate_sha!);
    return { status: this.cleanupPending(task.id) ? "MERGED_CLEANUP_PENDING" : "MERGED" };
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
    if (branch !== task.agent_branch) throw fail("Task branch changed; cannot retry validation.");
    this.db.prepare("UPDATE tasks SET latest_task_commit_sha = ?, active_validation_snapshot_id = NULL, workflow_state = 'REVIEW', review_tag = 'IMPLEMENTATION_COMPLETE', updated_at = ? WHERE id = ?")
      .run(state.head_sha, new Date().toISOString(), taskId);
    const attempt = this.db.prepare("SELECT id FROM merge_attempts WHERE task_id = ? ORDER BY rowid DESC LIMIT 1").get(taskId) as { id: string };
    this.revoke(attempt.id, "MANUAL_RESOLUTION");
    const validation = await this.options.validation.start(taskId, { priority: true });
    return { status: "VALIDATION_QUEUED", run_id: validation.run_id };
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
    this.db.prepare("UPDATE tasks SET workflow_state = 'REVIEW', review_tag = 'IMPLEMENTATION_COMPLETE', updated_at = ? WHERE id = ?")
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
          this.db.prepare("UPDATE tasks SET workflow_state = 'DONE', resolution = 'MERGED', active_validation_snapshot_id = NULL, updated_at = ? WHERE id = ?").run(now, task.id);
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
