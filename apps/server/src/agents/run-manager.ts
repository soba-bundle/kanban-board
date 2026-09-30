import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { RunInput, ReviewTag } from "@kanban-board/shared";
import { AgentManager } from "./agent-manager.js";
import type { RunPrompt } from "./prompt-builder.js";
import { readHandover } from "./handover-tool.js";
import type { HumanRequestService } from "./human-requests.js";

const HANDOVER_RETRY_PROMPT = [
  "You ended the run without calling submit_handover.",
  "Call submit_handover now with the structured result of this run. Do not do any further work.",
].join(" ");
const HANDOVER_UPDATE_PROMPT = [
  "Additional user guidance was processed after your current handover.",
  "Update and resubmit the authoritative handover to account for all accepted guidance.",
].join(" ");
const HUMAN_REQUEST_RESTART_PROMPT = [
  "A human has answered the pending questionnaire in this session.",
  "Continue from the current transcript, incorporate that answer, and do not repeat earlier work or ask the same question again.",
].join(" ");

const COMPLETION_TAG: Record<string, ReviewTag> = {
  INVESTIGATION: "INVESTIGATION_COMPLETE",
  IMPLEMENTATION: "IMPLEMENTATION_COMPLETE",
};

interface RunRow {
  task_id: string;
  stage: string;
  status: string;
  session_id: string | null;
  input_mode: string;
}

interface InputResult {
  input: RunInput;
  created: boolean;
}

export class RunManager {
  private readonly stopRequested = new Set<string>();
  private readonly closingRuns = new Set<string>();
  private readonly activeRuns = new Map<string, Promise<void>>();
  private readonly steeringQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Database.Database,
    private readonly agents: AgentManager,
    private readonly humanRequests?: HumanRequestService,
  ) {}

  start(runId: string, prompt?: RunPrompt, humanRequestId?: string): Promise<void> {
    if (humanRequestId) return this.resume(runId, humanRequestId);
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found.`);
    if (run.status !== "QUEUED" || !prompt) throw new Error(`Run ${runId} is not queued.`);
    const claimed = this.db.prepare("UPDATE task_runs SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'QUEUED'")
      .run(new Date().toISOString(), runId);
    if (claimed.changes !== 1) throw new Error(`Run ${runId} is not queued.`);
    const completion = this.execute(runId, run.task_id, prompt);
    this.activeRuns.set(runId, completion);
    void completion.finally(() => this.activeRuns.delete(runId));
    return completion;
  }

  resume(runId: string, humanRequestId: string): Promise<void> {
    const run = this.getRun(runId);
    const active = this.activeRuns.get(runId);
    if (!run) throw new Error(`Run ${runId} not found.`);
    if (this.stopRequested.has(runId)) throw new Error(`Run ${runId} is stopping.`);
    if (!active || run.status !== "QUEUED") throw new Error(`Run ${runId} has no suspended Human Request execution.`);
    if (!this.humanRequests) throw new Error("Human Request continuation is not configured.");
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE task_runs SET status = 'RUNNING'
        WHERE id = ? AND status = 'QUEUED' AND EXISTS (
          SELECT 1 FROM agent_jobs WHERE task_run_id = ? AND status = 'CLAIMED')`).run(runId, runId);
      if (changed.changes !== 1) throw new Error(`Run ${runId} is not queued for continuation.`);
      this.db.prepare(`UPDATE tasks SET workflow_state = 'IN_PROGRESS', review_tag = NULL, updated_at = ?
        WHERE id = ? AND workflow_state = 'REQUIRES_HUMAN'`).run(now, run.task_id);
    })();
    this.humanRequests.resume(humanRequestId);
    return active;
  }

  async reconcileHumanRequests(): Promise<void> {
    const runs = this.db.prepare(`SELECT r.id AS run_id, r.task_id, r.status, j.id AS job_id, j.status AS job_status
      FROM task_runs r LEFT JOIN agent_jobs j ON j.id = (
        SELECT candidate.id FROM agent_jobs candidate WHERE candidate.task_run_id = r.id
        ORDER BY candidate.created_at, candidate.id LIMIT 1)
      WHERE r.status IN ('RUNNING', 'WAITING_FOR_HUMAN', 'QUEUED')
        AND EXISTS (SELECT 1 FROM human_requests h WHERE h.run_id = r.id AND h.status IN ('PENDING', 'ANSWERED'))
      ORDER BY COALESCE(j.created_at, r.id), r.id`).all() as Array<{
        run_id: string; task_id: string; status: string; job_id: string | null; job_status: string | null;
      }>;

    for (const run of runs) {
      if (run.job_status === "CANCELLED") {
        this.humanRequests?.cancelForRun(run.run_id);
        this.markStopped(run.run_id, run.task_id);
        continue;
      }
      const requests = this.db.prepare(`SELECT session_id, tool_call_id, status FROM human_requests
        WHERE run_id = ? AND status IN ('PENDING', 'ANSWERED') ORDER BY created_at, id`).all(run.run_id) as Array<{
          session_id: string; tool_call_id: string; status: string;
        }>;
      const hasPendingRequest = requests.some((request) => request.status === "PENDING");
      const session = await this.agents.getOrCreateWorkingSession(run.task_id).catch(() => undefined);
      if (!session) {
        if (hasPendingRequest) this.parkRecoveredRun(run.run_id, run.task_id, run.job_id);
        continue;
      }
      const states = requests.map((request) => request.session_id === session.sessionId
        ? this.agents.questionnaireCallState(run.task_id, request.session_id, request.tool_call_id)
        : "MISSING");
      const allAnsweredCallsHaveResults = requests.length > 0 && requests.every((request, index) =>
        request.status === "ANSWERED" && states[index] === "RESULT");

      if (hasPendingRequest) {
        this.parkRecoveredRun(run.run_id, run.task_id, run.job_id);
      } else if (allAnsweredCallsHaveResults) {
        this.queueRecoveredRun(run.run_id, run.job_id);
      }
    }
  }

  async resumeAfterRestart(runId: string, humanRequestId: string): Promise<void> {
    const run = this.getRun(runId);
    const request = this.db.prepare(`SELECT status FROM human_requests
      WHERE id = ? AND run_id = ?`).get(humanRequestId, runId) as { status: string } | undefined;
    if (!run || run.status !== "QUEUED" || this.activeRuns.has(runId)) {
      throw new Error(`Run ${runId} is not queued for restart continuation.`);
    }
    if (!request || request.status !== "ANSWERED") throw new Error("Restart continuation requires an answered Human Request.");
    const session = await this.agents.getOrCreateWorkingSession(run.task_id);
    const requests = this.db.prepare(`SELECT session_id, tool_call_id, status FROM human_requests
      WHERE run_id = ? AND status IN ('PENDING', 'ANSWERED')`).all(runId) as Array<{
        session_id: string; tool_call_id: string; status: string;
      }>;
    if (requests.some((item) => item.status !== "ANSWERED" || item.session_id !== session.sessionId ||
      this.agents.questionnaireCallState(run.task_id, item.session_id, item.tool_call_id) !== "RESULT")) {
      throw new Error("All Human Requests must be answered and matched to results in the saved session before continuation.");
    }
    const current = this.getRun(runId);
    if (!current || current.status !== "QUEUED" || this.stopRequested.has(runId)) {
      throw new Error(`Run ${runId} stopped before restart continuation.`);
    }
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const updated = this.db.prepare(`UPDATE task_runs SET status = 'RUNNING'
        WHERE id = ? AND status = 'QUEUED' AND EXISTS (
          SELECT 1 FROM agent_jobs WHERE task_run_id = ? AND status = 'CLAIMED')`).run(runId, runId);
      if (updated.changes !== 1) throw new Error(`Run ${runId} is no longer queued for restart continuation.`);
      this.db.prepare(`UPDATE tasks SET workflow_state = 'IN_PROGRESS', review_tag = NULL, updated_at = ?
        WHERE id = ? AND workflow_state = 'REQUIRES_HUMAN'`).run(now, run.task_id);
    })();
    const completion = this.execute(runId, run.task_id, { text: HUMAN_REQUEST_RESTART_PROMPT, inputIds: [] });
    this.activeRuns.set(runId, completion);
    void completion.finally(() => this.activeRuns.delete(runId));
    return completion;
  }

  /** Persist an input before acknowledging it; queued runs fold it into the start prompt. */
  async steer(runId: string, inputId: string, text: string, reusedFromInputId?: string): Promise<InputResult> {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found.`);
    if (run.stage === "VALIDATION_REVIEW") throw new Error("Validation Review does not accept live guidance.");
    if (!["QUEUED", "RUNNING"].includes(run.status)) throw new Error(`Run ${runId} is not accepting messages.`);
    if (this.closingRuns.has(runId)) throw new Error(`Run ${runId} is closing; refresh before sending.`);
    const created = this.db.transaction(() => {
      const prior = this.db.prepare("SELECT run_id, content, reused_from_input_id FROM run_inputs WHERE id = ?").get(inputId) as
        { run_id: string; content: string; reused_from_input_id: string | null } | undefined;
      if (prior) {
        if (prior.run_id !== runId || prior.content !== text || prior.reused_from_input_id !== (reusedFromInputId ?? null)) {
          throw new Error("Input ID was already used for different guidance.");
        }
        return false;
      }
      let reusedFrom: string | null = null;
      if (reusedFromInputId) {
        const source = this.db.prepare(`SELECT task_id, content, delivery_status FROM run_inputs WHERE id = ?`)
          .get(reusedFromInputId) as { task_id: string; content: string; delivery_status: string } | undefined;
        if (!source || source.task_id !== run.task_id || !["UNDELIVERED", "DELIVERY_UNKNOWN"].includes(source.delivery_status)) {
          throw new Error("Only undelivered or delivery-unknown guidance from this task can be reused.");
        }
        if (source.content !== text) throw new Error("Reused guidance must match the original text.");
        reusedFrom = reusedFromInputId;
      }
      const sequence = (this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM run_inputs WHERE run_id = ?")
        .get(runId) as { next: number }).next;
      const sessionId = run.input_mode === "STEERING" ? run.session_id : null;
      const sessionSequence = sessionId
        ? (this.db.prepare("SELECT COALESCE(MAX(session_sequence), 0) + 1 AS next FROM run_inputs WHERE session_id = ?")
          .get(sessionId) as { next: number }).next
        : null;
      const boundary = (this.db.prepare("SELECT transcript_end_entry_id FROM task_runs WHERE id = ?")
        .get(runId) as { transcript_end_entry_id: string | null }).transcript_end_entry_id;
      this.db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content,
        delivery_type, delivery_status, accepted_at, session_id, session_sequence,
        transcript_boundary_entry_id, reused_from_input_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)`)
        .run(inputId, run.task_id, runId, sequence, inputId, text,
          run.input_mode === "QUEUED" ? "QUEUED_INPUT" : "STEERING", new Date().toISOString(),
          sessionId, sessionSequence, boundary, reusedFrom);
      return true;
    })();

    const input = this.getInput(inputId)!;
    if (run.input_mode === "STEERING" && input.delivery_status === "PENDING") {
      this.scheduleSteering(runId, inputId, text);
    }
    return { input, created };
  }

  async stop(runId: string): Promise<void> {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found.`);
    if (!['RUNNING', 'WAITING_FOR_HUMAN', 'QUEUED'].includes(run.status)) {
      throw new Error(`Run ${runId} is not running.`);
    }
    this.stopRequested.add(runId);
    this.humanRequests?.cancelForRun(runId);
    const active = this.activeRuns.get(runId);
    if (active) {
      await this.agents.abort(run.task_id);
      await active;
    } else {
      this.markStopped(runId, run.task_id);
      this.stopRequested.delete(runId);
    }
  }

  private parkRecoveredRun(runId: string, taskId: string, jobId: string | null): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE task_runs SET status = 'WAITING_FOR_HUMAN'
        WHERE id = ? AND status IN ('RUNNING', 'WAITING_FOR_HUMAN', 'QUEUED')`).run(runId);
      if (jobId) {
        this.db.prepare(`UPDATE agent_jobs SET status = 'WAITING_FOR_HUMAN', queue_position = NULL
          WHERE id = ? AND status <> 'CANCELLED'`).run(jobId);
      } else {
        this.db.prepare(`INSERT INTO agent_jobs (id, task_run_id, status, created_at)
          VALUES (?, ?, 'WAITING_FOR_HUMAN', ?)`).run(randomUUID(), runId, now);
      }
      this.db.prepare(`UPDATE tasks SET workflow_state = 'REQUIRES_HUMAN', review_tag = NULL, updated_at = ?
        WHERE id = ?`).run(now, taskId);
    })();
  }

  private queueRecoveredRun(runId: string, jobId: string | null): void {
    this.db.transaction(() => {
      const position = (this.db.prepare(`SELECT COALESCE(MAX(queue_position), 0) + 1 AS next
        FROM agent_jobs WHERE status IN ('QUEUED', 'CLAIMED')`).get() as { next: number }).next;
      this.db.prepare(`UPDATE task_runs SET status = 'QUEUED'
        WHERE id = ? AND status IN ('RUNNING', 'WAITING_FOR_HUMAN', 'QUEUED')`).run(runId);
      if (jobId) {
        this.db.prepare(`UPDATE agent_jobs SET status = 'QUEUED', queue_position = ?, started_at = NULL
          WHERE id = ? AND status <> 'CANCELLED'`).run(position, jobId);
      } else {
        this.db.prepare(`INSERT INTO agent_jobs (id, task_run_id, queue_position, status, created_at)
          VALUES (?, ?, ?, 'QUEUED', ?)`).run(randomUUID(), runId, position, new Date().toISOString());
      }
    })();
  }

  private async execute(runId: string, taskId: string, prompt: RunPrompt): Promise<void> {
    const watcher = this.watchRunEvents(runId, taskId, prompt.inputIds ?? [], prompt.text);
    try {
      const session = await this.agents.getOrCreateWorkingSession(taskId);
      const transcriptStart = session.sessionManager?.getLeafId() ?? null;
      this.db.transaction(() => {
        this.db.prepare(`UPDATE task_runs SET session_id = ?, session_file = ?, transcript_start_entry_id = ?
          WHERE id = ?`).run(session.sessionId, session.sessionFile ?? null, transcriptStart, runId);
        const initialInputs = prompt.inputIds ?? [];
        let sessionSequence = (this.db.prepare("SELECT COALESCE(MAX(session_sequence), 0) AS current FROM run_inputs WHERE session_id = ?")
          .get(session.sessionId) as { current: number }).current;
        for (const inputId of initialInputs) {
          sessionSequence++;
          this.db.prepare(`UPDATE run_inputs SET session_id = ?, session_sequence = ?, transcript_boundary_entry_id = ?
            WHERE id = ? AND run_id = ?`).run(session.sessionId, sessionSequence, transcriptStart, inputId, runId);
        }
        const pending = this.db.prepare(`SELECT id FROM run_inputs WHERE run_id = ? AND delivery_type = 'STEERING'
          AND session_id IS NULL AND delivery_status = 'PENDING' ORDER BY sequence`).all(runId) as Array<{ id: string }>;
        for (const input of pending) {
          sessionSequence++;
          this.db.prepare(`UPDATE run_inputs SET session_id = ?, session_sequence = ?, transcript_boundary_entry_id = ?
            WHERE id = ?`).run(session.sessionId, sessionSequence, transcriptStart, input.id);
        }
      })();
      if (this.stopRequested.has(runId)) {
        this.markStopped(runId, taskId);
        return;
      }
      const promptPromise = this.agents.prompt(taskId, runId, prompt.text);
      this.flushPendingSteering(runId);
      await promptPromise;
      this.closingRuns.add(runId);
      await this.steeringQueues.get(runId);
      if (this.stopRequested.has(runId)) this.markStopped(runId, taskId);
      else await this.finishRun(runId, taskId);
    } catch (error) {
      if (this.stopRequested.has(runId)) this.markStopped(runId, taskId);
      else {
        this.humanRequests?.cancelForRun(runId);
        const now = new Date().toISOString();
        this.db.prepare(`UPDATE task_runs SET status = 'FAILED', completed_at = ?, error_message = ? WHERE id = ?`)
          .run(now, error instanceof Error ? error.message : String(error), runId);
        this.markInputsUnresolved(runId);
      }
    } finally {
      watcher.unsubscribe();
      this.agents.clearReplay(runId);
      this.stopRequested.delete(runId);
      this.closingRuns.delete(runId);
      this.steeringQueues.delete(runId);
    }
  }

  private scheduleSteering(runId: string, inputId: string, text: string): void {
    const previous = this.steeringQueues.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.deliverSteering(runId, inputId, text));
    this.steeringQueues.set(runId, next);
    void next.catch(() => {});
  }

  private async deliverSteering(runId: string, inputId: string, text: string): Promise<void> {
    const input = this.getInput(inputId);
    if (!input || input.delivery_status !== "PENDING") return;
    let run = this.getRun(runId);
    if (!run || !["QUEUED", "RUNNING"].includes(run.status) || this.stopRequested.has(runId) || this.closingRuns.has(runId)) {
      this.setInputStatus(inputId, "UNDELIVERED", "Run stopped or closed before Pi accepted the guidance.");
      return;
    }
    while (this.agents.activeRunId(run.task_id) !== runId) {
      run = this.getRun(runId);
      if (!run || !["QUEUED", "RUNNING"].includes(run.status) || this.stopRequested.has(runId) || this.closingRuns.has(runId)) {
        this.setInputStatus(inputId, "UNDELIVERED", "Run stopped or closed before Pi accepted the guidance.");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.db.prepare(`UPDATE run_inputs SET session_id = ?, session_sequence = (
      SELECT COALESCE(MAX(session_sequence), 0) + 1 FROM run_inputs WHERE session_id = ?
    ), transcript_boundary_entry_id = (SELECT transcript_end_entry_id FROM task_runs WHERE id = ?)
      WHERE id = ? AND session_id IS NULL`).run(run.session_id, run.session_id, runId, inputId);
    try {
      await this.agents.steer(run.task_id, text);
      this.db.prepare(`UPDATE run_inputs SET delivery_status = 'ACCEPTED'
        WHERE id = ? AND delivery_status = 'PENDING'`).run(inputId);
      this.publishInputStatus(inputId);
    } catch (error) {
      this.setInputStatus(inputId, "UNDELIVERED", error instanceof Error ? error.message : String(error));
    }
  }

  private flushPendingSteering(runId: string): void {
    const inputs = this.db.prepare(`SELECT id, content FROM run_inputs WHERE run_id = ? AND delivery_type = 'STEERING'
      AND delivery_status = 'PENDING' ORDER BY sequence`).all(runId) as Array<{ id: string; content: string }>;
    for (const input of inputs) this.scheduleSteering(runId, input.id, input.content);
  }

  private async finishRun(runId: string, taskId: string): Promise<void> {
    const stage = this.getRun(runId)!.stage;
    const tag = COMPLETION_TAG[stage];
    if (!tag) {
      this.markCompleted(runId);
      return;
    }

    if (!readHandover(this.db, runId)) {
      await this.agents.prompt(taskId, runId, HANDOVER_RETRY_PROMPT);
      this.closingRuns.add(runId);
      await this.steeringQueues.get(runId);
      if (this.stopRequested.has(runId)) {
        this.markStopped(runId, taskId);
        return;
      }
      this.closingRuns.add(runId);
      if (!readHandover(this.db, runId)) {
        this.markHandoverFailed(runId, taskId);
        return;
      }
    }

    let handoverRevisionUsed = false;
    for (;;) {
      const unresolved = this.db.prepare(`SELECT COUNT(*) AS count FROM run_inputs WHERE run_id = ?
        AND delivery_status IN ('PENDING', 'ACCEPTED', 'UNDELIVERED', 'DELIVERY_UNKNOWN')`).get(runId) as { count: number };
      if (unresolved.count > 0) {
        this.markInputDeliveryFailed(runId, taskId);
        return;
      }
      const watermark = (this.db.prepare("SELECT handover_input_sequence FROM task_runs WHERE id = ?")
        .get(runId) as { handover_input_sequence: number }).handover_input_sequence;
      const latestDelivered = (this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM run_inputs
        WHERE run_id = ? AND delivery_status = 'DELIVERED'`).get(runId) as { sequence: number }).sequence;
      if (watermark >= latestDelivered) break;
      if (handoverRevisionUsed) {
        this.markHandoverFailed(runId, taskId, "Handover did not include all delivered guidance after its update request.");
        return;
      }
      handoverRevisionUsed = true;
      await this.agents.prompt(taskId, runId, HANDOVER_UPDATE_PROMPT);
      this.closingRuns.add(runId);
      await this.steeringQueues.get(runId);
      if (this.stopRequested.has(runId)) {
        this.markStopped(runId, taskId);
        return;
      }
      this.closingRuns.add(runId);
      if (!readHandover(this.db, runId)) {
        this.markHandoverFailed(runId, taskId);
        return;
      }
    }

    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE task_runs SET status = 'COMPLETED', completed_at = ? WHERE id = ?").run(now, runId);
      this.db.prepare("UPDATE tasks SET workflow_state = 'REVIEW', review_tag = ?, updated_at = ? WHERE id = ?")
        .run(tag, now, taskId);
    })();
  }

  private markCompleted(runId: string): void {
    this.db.prepare("UPDATE task_runs SET status = 'COMPLETED', completed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), runId);
  }

  private markInputsUnresolved(runId: string): void {
    this.db.prepare(`UPDATE run_inputs SET delivery_status = CASE
      WHEN delivery_status = 'ACCEPTED' THEN 'DELIVERY_UNKNOWN' ELSE 'UNDELIVERED' END
      WHERE run_id = ? AND delivery_status IN ('PENDING', 'ACCEPTED')`).run(runId);
  }

  private markHandoverFailed(runId: string, taskId: string, message = "Run ended without a valid handover after a second request."): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE task_runs SET status = 'FAILED', reason_code = 'HANDOVER_FAILED', completed_at = ?,
      error_message = ? WHERE id = ?`).run(now, message, runId);
    this.db.prepare("UPDATE tasks SET workflow_state = 'REVIEW', review_tag = 'RUN_FAILED', updated_at = ? WHERE id = ?")
      .run(now, taskId);
  }

  private markInputDeliveryFailed(runId: string, taskId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE run_inputs SET delivery_status = CASE
      WHEN delivery_status = 'ACCEPTED' THEN 'DELIVERY_UNKNOWN' ELSE 'UNDELIVERED' END
      WHERE run_id = ? AND delivery_status IN ('PENDING', 'ACCEPTED')`).run(runId);
    this.db.prepare(`UPDATE task_runs SET status = 'FAILED', reason_code = 'INPUT_DELIVERY_FAILED', completed_at = ?,
      error_message = 'Accepted run guidance was not fully confirmed in the Pi transcript.' WHERE id = ?`).run(now, runId);
    this.db.prepare("UPDATE tasks SET workflow_state = 'REVIEW', review_tag = 'RUN_FAILED', updated_at = ? WHERE id = ?")
      .run(now, taskId);
  }

  private markStopped(runId: string, taskId: string): void {
    const now = new Date().toISOString();
    const run = this.getRun(runId);
    this.db.prepare(`UPDATE run_inputs SET delivery_status = CASE
      WHEN delivery_status = 'ACCEPTED' THEN 'DELIVERY_UNKNOWN' ELSE 'UNDELIVERED' END
      WHERE run_id = ? AND delivery_status IN ('PENDING', 'ACCEPTED')`).run(runId);
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

  private watchRunEvents(runId: string, taskId: string, initialInputIds: string[], initialPromptText: string): { unsubscribe: () => void } {
    let initialDelivered = false;
    const unsubscribe = this.agents.subscribe(taskId, runId, (event) => {
      if (event.type !== "entry_appended") return;
      const entryId = typeof event.data.entryId === "string" ? event.data.entryId : null;
      if (!entryId) return;
      const sessionId = this.getRun(runId)?.session_id ?? null;
      this.db.transaction(() => {
        this.db.prepare("UPDATE task_runs SET transcript_end_entry_id = ? WHERE id = ?").run(entryId, runId);
        if (sessionId) {
          const sequence = (this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS next
            FROM run_transcript_entries WHERE run_id = ?`).get(runId) as { next: number }).next;
          this.db.prepare(`INSERT OR IGNORE INTO run_transcript_entries (session_id, entry_id, run_id, sequence)
            VALUES (?, ?, ?, ?)`).run(sessionId, entryId, runId, sequence);
        }
      })();
      if (event.data.role !== "user") return;
      const text = typeof event.data.text === "string" ? event.data.text : "";
      const alreadyMatched = this.db.prepare(`SELECT 1 FROM run_inputs
        WHERE session_id = ? AND transcript_entry_id = ? LIMIT 1`).get(sessionId, entryId);
      if (alreadyMatched) return;
      if (!initialDelivered && initialInputIds.length > 0) {
        if (text !== initialPromptText) return;
        initialDelivered = true;
        for (const inputId of initialInputIds) this.markInputDelivered(inputId, sessionId, entryId);
        return;
      }
      const next = this.db.prepare(`SELECT id, content, session_id FROM run_inputs WHERE run_id = ? AND delivery_type = 'STEERING'
        AND delivery_status IN ('PENDING', 'ACCEPTED') ORDER BY session_sequence LIMIT 1`).get(runId) as
        { id: string; content: string; session_id: string | null } | undefined;
      if (!next) return;
      if (next.session_id !== sessionId || next.content !== text) {
        const ambiguous = this.db.prepare(`SELECT id FROM run_inputs WHERE run_id = ? AND delivery_type = 'STEERING'
          AND delivery_status IN ('PENDING', 'ACCEPTED') ORDER BY session_sequence`).all(runId) as Array<{ id: string }>;
        for (const input of ambiguous) {
          this.setInputStatus(input.id, "DELIVERY_UNKNOWN", "Transcript steering entries could not be uniquely correlated in session order.");
        }
        return;
      }
      this.markInputDelivered(next.id, sessionId, entryId);
    });
    return { unsubscribe };
  }

  private markInputDelivered(inputId: string, sessionId: string | null, entryId: string): void {
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE run_inputs SET delivery_status = 'DELIVERED', delivered_at = ?,
      session_id = COALESCE(session_id, ?), transcript_entry_id = ?
      WHERE id = ? AND session_id = ? AND transcript_entry_id IS NULL
        AND delivery_status IN ('PENDING', 'ACCEPTED')`)
      .run(now, sessionId, entryId, inputId, sessionId);
    if (result.changes) this.publishInputStatus(inputId);
  }

  private setInputStatus(inputId: string, status: string, reason: string): void {
    this.db.prepare("UPDATE run_inputs SET delivery_status = ?, failure_reason = ? WHERE id = ? AND delivery_status IN ('PENDING', 'ACCEPTED')")
      .run(status, reason, inputId);
    this.publishInputStatus(inputId);
  }

  private publishInputStatus(inputId: string): void {
    const row = this.getInput(inputId);
    if (!row) return;
    this.agents.publish(row.task_id, row.run_id, "run_input_status", {
      inputId: row.id,
      deliveryStatus: row.delivery_status,
      transcriptEntryId: row.transcript_entry_id,
    });
  }

  private getRun(runId: string): RunRow | undefined {
    return this.db.prepare("SELECT task_id, stage, status, session_id, input_mode FROM task_runs WHERE id = ?")
      .get(runId) as RunRow | undefined;
  }

  private getInput(inputId: string): RunInput | undefined {
    return this.db.prepare(`SELECT id, task_id, run_id, sequence, idempotency_key, content, delivery_type,
      delivery_status, accepted_at, delivered_at, session_id, session_sequence, transcript_boundary_entry_id,
      transcript_entry_id, failure_reason, reused_from_input_id FROM run_inputs WHERE id = ?`)
      .get(inputId) as RunInput | undefined;
  }
}
