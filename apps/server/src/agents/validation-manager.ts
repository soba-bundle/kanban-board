import { randomUUID } from "node:crypto";
import { getAgentDir, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type Database from "better-sqlite3";
import type { ValidationReport } from "@kanban-board/shared";
import { buildValidationContext } from "./validation-context.js";
import { ValidationCleanupManager } from "./validation-cleanup.js";
import { buildValidationPrompt } from "./validation-prompt.js";
import { normalizePiEvent } from "./pi-events.js";
import { recordValidationResult } from "./validation-results.js";
import { createValidationSession } from "./validation-session.js";
import { evaluateValidationEligibility } from "./validation-policy.js";
import type { AgentManager } from "./agent-manager.js";
import type { QueueManager } from "../queue/queue-manager.js";
import type { WorktreeManager } from "../git/worktree-manager.js";

interface ValidationRun {
  id: string;
  task_id: string;
  status: string;
  task_commit_sha: string;
  validation_context_json: string;
  validation_base_tip_sha: string;
  validation_guidance_watermark: number;
  validation_task_head_sha: string;
  validation_worktree_path: string | null;
  prompt: string;
}

interface ActiveValidation {
  stopping: boolean;
  finalizing: boolean;
  session?: Awaited<ReturnType<typeof createValidationSession>>;
  done?: Promise<void>;
}

export class ValidationManager {
  private readonly active = new Map<string, ActiveValidation>();
  private readonly cleanup: ValidationCleanupManager;
  private readonly sessionDir: string;
  private readonly agentDir: string;

  constructor(
    private readonly db: Database.Database,
    private readonly worktrees: WorktreeManager,
    private readonly queue: QueueManager,
    private readonly agents: AgentManager,
    sessionDir = process.env.KANBAN_SESSION_DIR ?? "data/sessions",
    agentDir = getAgentDir(),
  ) {
    this.sessionDir = sessionDir;
    this.agentDir = agentDir;
    this.cleanup = new ValidationCleanupManager(db, worktrees);
  }

  reconcileCleanup(): Promise<void> {
    return this.cleanup.reconcilePending();
  }

  async start(taskId: string, options: { priority?: boolean } = {}): Promise<{ run_id: string; status: string }> {
    const task = this.db.prepare(`SELECT t.id, t.title, t.description, t.workflow_state, t.review_tag,
        t.latest_task_commit_sha, t.base_commit_sha, t.base_branch, p.root_path
      FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.id = ? AND t.is_active = 1 AND p.is_active = 1`).get(taskId) as {
        id: string; title: string; description: string; workflow_state: string; review_tag: string | null;
        latest_task_commit_sha: string | null; base_commit_sha: string | null; base_branch: string | null; root_path: string;
      } | undefined;
    if (!task) throw Object.assign(new Error(`Task ${taskId} not found.`), { statusCode: 404 });
    if (!task.latest_task_commit_sha || !task.base_commit_sha) {
      throw Object.assign(new Error("Create a checkpoint before validation."), { statusCode: 409 });
    }

    let worktree;
    let diff;
    let baseTip: string;
    try {
      [worktree, diff, baseTip] = await Promise.all([
        this.worktrees.getTaskWorktreeState(taskId),
        task.base_commit_sha && task.latest_task_commit_sha
          ? this.worktrees.getPinnedDiff(taskId, task.base_commit_sha, task.latest_task_commit_sha)
          : Promise.resolve({ changedFiles: [], diff: "" }),
        this.worktrees.getBaseBranchTip(taskId),
      ]);
    } catch (error) {
      throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { statusCode: 409 });
    }

    const activeRows = this.db.prepare(`SELECT r.stage FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id
      WHERE r.task_id = ? AND j.status IN ('QUEUED', 'CLAIMED')`).all(taskId) as Array<{ stage: string }>;
    const previousRow = this.db.prepare(`SELECT v.result, v.candidate_sha, v.findings_json FROM validation_results v
      JOIN task_runs r ON r.id = v.run_id WHERE v.task_id = ? ORDER BY r.sequence DESC LIMIT 1`).get(taskId) as {
        result: string; candidate_sha: string | null; findings_json: string | null;
      } | undefined;
    let previousHadBlockingFindings = previousRow?.result === "ISSUES_FOUND";
    if (previousRow?.findings_json) {
      try {
        const previousFindings = JSON.parse(previousRow.findings_json) as Array<{ attribution: string }>;
        previousHadBlockingFindings = previousFindings.some((finding) =>
          finding.attribution === "DIRECT" || finding.attribution === "UNCERTAIN");
      } catch {
        // Treat an unreadable issue report conservatively; it still requires a new checkpoint.
      }
    }
    const eligibility = evaluateValidationEligibility({
      task,
      worktree,
      queue: {
        has_active_work: activeRows.length > 0,
        validation_already_queued_or_running: activeRows.some((row) => row.stage === "VALIDATION_REVIEW"),
      },
      operation_locked: false,
      previous_validation: previousRow ? {
        result: previousRow.result,
        candidate_sha: previousRow.candidate_sha,
        had_direct_findings: previousHadBlockingFindings,
      } : null,
    });
    if (!eligibility.eligible) throw Object.assign(new Error(eligibility.reason ?? "Validation is not eligible."), { statusCode: 409 });

    const handovers = this.db.prepare(`SELECT id AS run_id, stage, sequence, status, handover_json, task_commit_sha
      FROM task_runs WHERE task_id = ? AND stage = 'IMPLEMENTATION' AND status = 'COMPLETED'
      ORDER BY sequence`).all(taskId) as Array<{
        run_id: string; stage: string; sequence: number; status: string; handover_json: string | null; task_commit_sha: string | null;
      }>;
    const checkpointRun = handovers.find((run) => run.task_commit_sha === task.latest_task_commit_sha);
    const runHandovers = handovers.map(({ handover_json, ...run }) => ({
      ...run,
      handover: handover_json ? JSON.parse(handover_json) as Record<string, unknown> : null,
    }));
    const guidanceRows = this.db.prepare(`SELECT i.id, i.content, i.delivery_status, i.sequence
      FROM run_inputs i JOIN task_runs r ON r.id = i.run_id
      WHERE i.task_id = ? AND r.stage IN ('INVESTIGATION', 'IMPLEMENTATION')
      ORDER BY r.sequence, i.sequence`).all(taskId) as Array<{
        id: string; content: string; delivery_status: string; sequence: number;
      }>;
    const guidance = guidanceRows.map((item, index) => ({ ...item, sequence: index + 1 }));
    const guidanceWatermark = guidance.length;
    const repositoryContext = `Repository root: ${task.root_path}\nRecorded base branch: ${task.base_branch ?? "unknown"}.`;
    let context;
    try {
      context = buildValidationContext({
        task: { id: task.id, title: task.title, description: task.description },
        checkpoint: { sha: task.latest_task_commit_sha!, producing_run_id: checkpointRun?.run_id ?? "" },
        base: { sha: task.base_commit_sha! },
        handovers: runHandovers,
        guidance_watermark: guidanceWatermark,
        guidance,
        changed_files: diff.changedFiles,
        diff: diff.diff,
        repository_context: repositoryContext,
      });
    } catch (error) {
      throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { statusCode: 409 });
    }

    const queued = this.queue.enqueueValidation(taskId, buildValidationPrompt(context), randomUUID(), {
      context,
      candidate_sha: task.latest_task_commit_sha!,
      base_sha: task.base_commit_sha!,
      base_tip_sha: baseTip,
      guidance_watermark: guidanceWatermark,
      task_head_sha: worktree.head_sha,
      priority: options.priority,
    });
    return { run_id: queued.run_id, status: "QUEUED" };
  }

  async execute(runId: string): Promise<void> {
    const execution: ActiveValidation = { stopping: false, finalizing: false };
    this.active.set(runId, execution);
    execution.done = this.executeAttempt(runId, execution);
    try {
      await execution.done;
    } finally {
      if (this.active.get(runId) === execution) this.active.delete(runId);
    }
  }

  async stop(runId: string): Promise<void> {
    const execution = this.active.get(runId);
    if (!execution) return;
    if (execution.finalizing) throw new Error("Validation is finalizing and can no longer be stopped.");
    execution.stopping = true;
    if (execution.session) await execution.session.abort().catch(() => {});
    await execution.done;
  }

  private async executeAttempt(runId: string, execution: ActiveValidation): Promise<void> {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Validation run ${runId} not found.`);
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE task_runs SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'QUEUED'`)
      .run(now, runId);

    let worktreePath: string | null = run.validation_worktree_path;
    let report: ValidationReport | undefined;
    let reportPersisted = false;
    let failure: { kind: string; message: string } | undefined;
    let unsubscribe = () => {};
    try {
      const context = JSON.parse(run.validation_context_json) as ReturnType<typeof buildValidationContext>;
      const prompt = run.prompt;
      worktreePath ??= await this.worktrees.createValidationWorktree(run.task_id, run.task_commit_sha);
      this.db.prepare("UPDATE task_runs SET validation_worktree_path = ? WHERE id = ?").run(worktreePath, runId);
      if (execution.stopping) throw Object.assign(new Error("Validation stopped before dispatch."), { kind: "USER_STOPPED" });

      const session = await createValidationSession({
        cwd: worktreePath,
        sessionDir: this.sessionDir,
        agentDir: this.agentDir,
        stage: "VALIDATION_REVIEW",
        onReport: (received) => {
          if (report) throw new Error("Validation submitted more than one report.");
          report = received;
        },
      });
      execution.session = session;
      const transcriptStart = session.sessionManager.getLeafId();
      this.db.prepare(`UPDATE task_runs SET session_id = ?, session_file = ?, transcript_start_entry_id = ? WHERE id = ?`)
        .run(session.sessionId, session.sessionFile ?? null, transcriptStart, runId);
      this.db.prepare(`UPDATE run_inputs SET session_id = ?, session_sequence = 1, transcript_boundary_entry_id = ?
        WHERE run_id = ? AND delivery_type = 'INITIAL_PROMPT'`).run(session.sessionId, transcriptStart, runId);
      unsubscribe = session.subscribe((event) => this.publishSessionEvent(run, session.sessionId, event, prompt));
      if (execution.stopping) throw Object.assign(new Error("Validation stopped before the reviewer prompt."), { kind: "USER_STOPPED" });
      await session.prompt(prompt);
      if (execution.stopping) throw Object.assign(new Error("Validation stopped by user."), { kind: "USER_STOPPED" });
      if (!report) throw Object.assign(new Error("Validation ended without a structured report."), { kind: "MALFORMED_REPORT" });

      const validationStatus = await this.worktrees.getValidationWorktreeStatus(run.task_id, worktreePath);
      const taskState = await this.worktrees.getTaskWorktreeState(run.task_id);
      if (execution.stopping) throw Object.assign(new Error("Validation stopped by user."), { kind: "USER_STOPPED" });
      execution.finalizing = true;
      await recordValidationResult(this.db, {
        task_id: run.task_id,
        run_id: runId,
        candidate_sha: run.task_commit_sha,
        base_sha: context.base_commit_sha,
        base_tip_at_start: run.validation_base_tip_sha,
        base_tip_at_finish: run.validation_base_tip_sha,
        guidance_watermark: String(run.validation_guidance_watermark),
        task_head_at_start: run.validation_task_head_sha,
        task_head_at_finish: taskState.head_sha,
        task_worktree_clean_at_start: true,
        task_worktree_clean_at_finish: !taskState.dirty,
        validation_worktree_clean: validationStatus.every((file) => file.untracked),
        validation_worktree_path: worktreePath,
        read_live_base_tip: () => this.worktrees.getBaseBranchTip(run.task_id),
        report,
      });
      reportPersisted = true;
      const outcome = (this.db.prepare("SELECT result FROM validation_results WHERE run_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(runId) as { result: string }).result;
      this.completeRun(runId, outcome === "VALIDATION_FAILED", null);
    } catch (error) {
      failure = {
        kind: execution.stopping ? "USER_STOPPED"
          : (error as { kind?: string })?.kind ?? "SESSION_ERROR",
        message: error instanceof Error ? error.message : String(error),
      };
      if (!reportPersisted) {
        const context = JSON.parse(run.validation_context_json) as ReturnType<typeof buildValidationContext>;
        const taskState = await this.worktrees.getTaskWorktreeState(run.task_id).catch(() => null);
        await recordValidationResult(this.db, {
          task_id: run.task_id,
          run_id: runId,
          candidate_sha: run.task_commit_sha,
          base_sha: context.base_commit_sha,
          base_tip_at_start: run.validation_base_tip_sha,
          base_tip_at_finish: run.validation_base_tip_sha,
          guidance_watermark: String(run.validation_guidance_watermark),
          task_head_at_start: run.validation_task_head_sha,
          task_head_at_finish: taskState?.head_sha,
          task_worktree_clean_at_start: true,
          task_worktree_clean_at_finish: taskState ? !taskState.dirty : undefined,
          validation_worktree_path: worktreePath,
          failure,
          report: null,
        });
      }
      this.completeRun(runId, true, failure.kind === "USER_STOPPED" ? "USER_STOPPED" : null, failure.message);
    } finally {
      unsubscribe();
      execution.session?.dispose();
      if (worktreePath) await this.cleanup.cleanup(run.task_id, runId, worktreePath);
    }
  }

  private publishSessionEvent(
    run: ValidationRun,
    sessionId: string,
    event: AgentSessionEvent,
    prompt: string,
  ): void {
    const normalized = normalizePiEvent(event);
    this.agents.publish(run.task_id, run.id, normalized.type, normalized.data);
    if (event.type !== "entry_appended") return;
    const entry = (event as unknown as { entry: { id: string; type: string; message?: { role?: string; content?: Array<{ type: string; text?: string }> } } }).entry;
    const now = new Date().toISOString();
    const sequence = (this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM run_transcript_entries WHERE run_id = ?")
      .get(run.id) as { next: number }).next;
    this.db.transaction(() => {
      this.db.prepare("UPDATE task_runs SET transcript_end_entry_id = ? WHERE id = ?").run(entry.id, run.id);
      this.db.prepare(`INSERT OR IGNORE INTO run_transcript_entries (session_id, entry_id, run_id, sequence)
        VALUES (?, ?, ?, ?)`).run(sessionId, entry.id, run.id, sequence);
      const text = entry.message?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("") ?? "";
      if (entry.message?.role === "user" && text === prompt) {
        this.db.prepare(`UPDATE run_inputs SET delivery_status = 'DELIVERED', delivered_at = ?,
          transcript_entry_id = ?, session_id = ? WHERE run_id = ? AND delivery_type = 'INITIAL_PROMPT'`)
          .run(now, entry.id, sessionId, run.id);
      }
    })();
  }

  private completeRun(runId: string, failed: boolean, reasonCode: string | null, message?: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE task_runs SET status = ?, reason_code = ?, completed_at = ?, interrupted_at = ?, error_message = ?
      WHERE id = ?`).run(failed ? "FAILED" : "COMPLETED", reasonCode, now,
      reasonCode === "USER_STOPPED" ? now : null, message ?? null, runId);
  }

  private getRun(runId: string): ValidationRun | undefined {
    return this.db.prepare(`SELECT r.id, r.task_id, r.status, r.task_commit_sha, r.validation_context_json,
      r.validation_base_tip_sha, r.validation_guidance_watermark, r.validation_task_head_sha,
      r.validation_worktree_path, i.content AS prompt FROM task_runs r
      JOIN run_inputs i ON i.run_id = r.id AND i.delivery_type = 'INITIAL_PROMPT' WHERE r.id = ?`)
      .get(runId) as ValidationRun | undefined;
  }
}
