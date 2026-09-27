import type Database from "better-sqlite3";
import { AgentManager } from "./agent-manager.js";
import { markCommentsDelivered, revertCommentsToPending, type RunPrompt } from "./prompt-builder.js";
import { markSteeringDelivered, recordSteeringQueued } from "./steering.js";
import { readHandover } from "./handover-tool.js";
import type { ReviewTag, TicketComment } from "@kanban-board/shared";

const HANDOVER_RETRY_PROMPT = [
  "You ended the run without calling submit_handover.",
  "Call submit_handover now with the structured result of this run. Do not do any further work.",
].join(" ");

const COMPLETION_TAG: Record<string, ReviewTag> = {
  INVESTIGATION: "INVESTIGATION_COMPLETE",
  IMPLEMENTATION: "IMPLEMENTATION_COMPLETE",
};

interface RunRow {
  task_id: string;
  stage: string;
  status: string;
}

export class RunManager {
  private readonly stopRequested = new Set<string>();
  private readonly activeRuns = new Map<string, Promise<void>>();

  constructor(private readonly db: Database.Database, private readonly agents: AgentManager) {}

  start(runId: string, prompt: RunPrompt): Promise<void> {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found.`);
    if (run.status !== "QUEUED") throw new Error(`Run ${runId} is not queued.`);

    const claimed = this.db.prepare("UPDATE task_runs SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'QUEUED'")
      .run(new Date().toISOString(), runId);
    if (claimed.changes !== 1) throw new Error(`Run ${runId} is not queued.`);
    const completion = this.execute(runId, run.task_id, prompt);
    this.activeRuns.set(runId, completion);
    void completion.finally(() => this.activeRuns.delete(runId));
    return completion;
  }

  /** Send an explicit Live View steering message to the running working session. */
  async steer(runId: string, text: string): Promise<TicketComment> {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found.`);
    if (run.status !== "RUNNING") throw new Error(`Run ${runId} is not running.`);
    await this.agents.steer(run.task_id, text);
    // Recorded only once Pi has accepted the message into its steering queue.
    const comment = recordSteeringQueued(this.db, run.task_id, runId, text);
    this.agents.publish(run.task_id, runId, "comment_queued", { commentId: comment.id, content: comment.content });
    return comment;
  }

  async stop(runId: string): Promise<void> {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found.`);
    if (run.status !== "RUNNING") throw new Error(`Run ${runId} is not running.`);
    this.stopRequested.add(runId);
    await this.agents.abort(run.task_id);
    await this.activeRuns.get(runId);
  }

  private async execute(runId: string, taskId: string, prompt: RunPrompt): Promise<void> {
    const watcher = this.watchSteeringDelivery(runId, taskId);
    const unwatch = watcher.unsubscribe;
    try {
      const session = await this.agents.getOrCreateWorkingSession(taskId);
      this.db.prepare("UPDATE task_runs SET session_id = ?, session_file = ? WHERE id = ?")
        .run(session.sessionId, session.sessionFile ?? null, runId);
      if (this.stopRequested.has(runId)) {
        this.markStopped(runId, taskId);
        return;
      }
      markCommentsDelivered(this.db, prompt.commentIds, session.sessionId, runId);
      await this.agents.prompt(taskId, runId, prompt.text);
      if (this.stopRequested.has(runId)) this.markStopped(runId, taskId);
      else await this.finishRun(runId, taskId);
    } catch (error) {
      // The prompt never became a user message, so its comments were not seen by the model.
      if (!watcher.sawUserMessage()) revertCommentsToPending(this.db, prompt.commentIds, runId);
      if (this.stopRequested.has(runId)) this.markStopped(runId, taskId);
      else this.db.prepare("UPDATE task_runs SET status = 'FAILED', completed_at = ?, error_message = ? WHERE id = ?")
        .run(new Date().toISOString(), error instanceof Error ? error.message : String(error), runId);
    } finally {
      unwatch();
      // The run is over, so its live buffer is no longer needed. Finished-run history
      // is rebuilt from Pi JSONL (Phase 12), not from memory.
      this.agents.clearReplay(runId);
      this.stopRequested.delete(runId);
    }
  }

  /**
   * Working runs must end with a valid handover. A run that does not gets one extra
   * request; a second failure is routed to Review / RUN_FAILED.
   */
  private async finishRun(runId: string, taskId: string): Promise<void> {
    const stage = this.getRun(runId)!.stage;
    const tag = COMPLETION_TAG[stage];
    if (!tag) {
      this.markCompleted(runId);
      return;
    }

    if (!readHandover(this.db, runId)) {
      await this.agents.prompt(taskId, runId, HANDOVER_RETRY_PROMPT);
      if (this.stopRequested.has(runId)) {
        this.markStopped(runId, taskId);
        return;
      }
      if (!readHandover(this.db, runId)) {
        this.markHandoverFailed(runId, taskId);
        return;
      }
    }

    const now = new Date().toISOString();
    this.markCompleted(runId);
    this.db.prepare("UPDATE tasks SET workflow_state = 'REVIEW', review_tag = ?, updated_at = ? WHERE id = ?")
      .run(tag, now, taskId);
  }

  private markCompleted(runId: string): void {
    this.db.prepare("UPDATE task_runs SET status = 'COMPLETED', completed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), runId);
  }

  private markHandoverFailed(runId: string, taskId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE task_runs SET status = 'FAILED', reason_code = 'HANDOVER_FAILED', completed_at = ?,
      error_message = 'Run ended without a valid handover after a second request.' WHERE id = ?`).run(now, runId);
    this.db.prepare("UPDATE tasks SET workflow_state = 'REVIEW', review_tag = 'RUN_FAILED', updated_at = ? WHERE id = ?")
      .run(now, taskId);
  }

  /** Flips queued steering comments to delivered when Pi replays them as user messages. */
  private watchSteeringDelivery(runId: string, taskId: string): { unsubscribe: () => void; sawUserMessage: () => boolean } {
    let sawUserMessage = false;
    const unsubscribe = this.agents.subscribe(taskId, runId, (event) => {
      if (event.type !== "message_start" || event.data.role !== "user") return;
      sawUserMessage = true;
      const content = typeof event.data.text === "string" ? event.data.text : "";
      if (!content) return;
      const sessionId = (this.db.prepare("SELECT session_id FROM task_runs WHERE id = ?")
        .get(runId) as { session_id: string | null }).session_id;
      const commentId = markSteeringDelivered(this.db, taskId, content, sessionId, runId);
      // Published after the triggering event finishes fanning out to subscribers.
      if (commentId) queueMicrotask(() => this.agents.publish(taskId, runId, "comment_delivered", { commentId }));
    });
    return { unsubscribe, sawUserMessage: () => sawUserMessage };
  }

  private getRun(runId: string): RunRow | undefined {
    return this.db.prepare("SELECT task_id, stage, status FROM task_runs WHERE id = ?").get(runId) as RunRow | undefined;
  }

  private markStopped(runId: string, taskId: string): void {
    const now = new Date().toISOString();
    const run = this.getRun(runId);
    if (run?.stage === "VALIDATION_REVIEW") {
      this.db.prepare(`UPDATE task_runs SET status = 'FAILED', reason_code = 'USER_STOPPED', interrupted_at = ?,
        completed_at = ?, error_message = 'Validation stopped by user.' WHERE id = ?`).run(now, now, runId);
      this.db.prepare(`UPDATE tasks SET workflow_state = 'REVIEW', review_tag = 'VALIDATION_FAILED', updated_at = ? WHERE id = ?`)
        .run(now, taskId);
    } else {
      this.db.prepare(`UPDATE task_runs SET status = 'INTERRUPTED', reason_code = 'USER_STOPPED', interrupted_at = ?,
        error_message = 'Run stopped by user.' WHERE id = ?`).run(now, runId);
      this.db.prepare(`UPDATE tasks SET workflow_state = 'REVIEW', review_tag = 'INTERRUPTED', updated_at = ? WHERE id = ?`)
        .run(now, taskId);
    }
  }
}
