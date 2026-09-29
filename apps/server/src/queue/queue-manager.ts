import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { QueueItem, QueueSnapshot, WorkingPhase } from "@kanban-board/shared";
import { RunManager } from "../agents/run-manager.js";
import { buildRunPrompt } from "../agents/prompt-builder.js";
import { WorktreeManager } from "../git/worktree-manager.js";

type WorkingRunPhase = Exclude<WorkingPhase, "VALIDATION_REVIEW">;

interface ClaimedJob {
  job_id: string;
  run_id: string;
  task_id: string;
}

interface NewQueueJob {
  job_id: string | null;
  run_id: string;
  queue_position: number | null;
  created: boolean;
}

interface SuspendedExecution {
  jobId: string;
  requestId: string | null;
  parked: boolean;
  notifyParked: () => void;
  parkedPromise: Promise<void>;
}

export class QueueManager {
  private dispatching = false;
  private readonly active = new Map<string, Promise<void>>();
  private readonly suspended = new Map<string, SuspendedExecution>();

  constructor(
    private readonly db: Database.Database,
    private readonly runs: RunManager,
    readonly maxConcurrentAgents = Number(process.env.KANBAN_MAX_CONCURRENT_AGENTS ?? 1),
    private readonly worktrees?: WorktreeManager,
  ) {
    if (!Number.isInteger(maxConcurrentAgents) || maxConcurrentAgents < 1) {
      throw new Error("maxConcurrentAgents must be a positive integer.");
    }
  }

  initialize(): void {
    this.db.transaction(() => {
      const claimed = this.db.prepare(`SELECT j.id AS job_id, j.task_run_id AS run_id, r.task_id, r.status AS run_status
        FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id WHERE j.status = 'CLAIMED'`).all() as Array<ClaimedJob & { run_status: string }>;
      const now = new Date().toISOString();
      for (const job of claimed) {
        if (job.run_status === "QUEUED") {
          this.db.prepare("UPDATE agent_jobs SET status = 'QUEUED', started_at = NULL WHERE id = ?").run(job.job_id);
        } else if (job.run_status === "RUNNING") {
          this.markBackendInterrupted(job.run_id, job.task_id, job.job_id, now);
        } else {
          this.db.prepare("UPDATE agent_jobs SET status = 'FINISHED', completed_at = ? WHERE id = ?").run(now, job.job_id);
        }
      }
      const orphanedRuns = this.db.prepare(`SELECT r.id AS run_id, r.task_id, j.id AS job_id
        FROM task_runs r LEFT JOIN agent_jobs j ON j.task_run_id = r.id
        WHERE r.status = 'RUNNING' AND (j.id IS NULL OR j.status <> 'CLAIMED')`).all() as Array<{
          run_id: string; task_id: string; job_id: string | null;
        }>;
      for (const run of orphanedRuns) this.markBackendInterrupted(run.run_id, run.task_id, run.job_id, now);
      this.normalizeQueuePositions();
    })();
    this.dispatch();
  }

  enqueueTask(taskId: string, stage: WorkingRunPhase, prompt: string, idempotencyKey: string, reusedFromInputId?: string): NewQueueJob {
    const now = new Date().toISOString();
    const job: NewQueueJob = { job_id: randomUUID(), run_id: randomUUID(), queue_position: 0, created: true };
    const inputId = randomUUID();
    const result = this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT j.id AS job_id, r.id AS run_id, j.queue_position,
          r.stage, i.content, i.reused_from_input_id
        FROM run_inputs i JOIN task_runs r ON r.id = i.run_id
        LEFT JOIN agent_jobs j ON j.task_run_id = r.id
        WHERE i.task_id = ? AND i.idempotency_key = ? LIMIT 1`).get(taskId, idempotencyKey) as
        { job_id: string | null; run_id: string; queue_position: number | null; stage: string; content: string; reused_from_input_id: string | null } | undefined;
      if (existing) {
        if (existing.stage !== stage || existing.content !== prompt || existing.reused_from_input_id !== (reusedFromInputId ?? null)) {
          throw new Error("Idempotency key was already used for a different run request.");
        }
        return { job_id: existing.job_id, run_id: existing.run_id, queue_position: existing.queue_position, created: false };
      }

      const task = this.db.prepare(`SELECT workflow_state, review_tag FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.id = ? AND t.is_active = 1 AND p.is_active = 1`).get(taskId) as
        { workflow_state: string; review_tag: string | null } | undefined;
      if (!task) throw new Error(`Task ${taskId} not found.`);
      const canStart = task.workflow_state === "TODO" || (task.workflow_state === "REVIEW" &&
        ["INVESTIGATION_COMPLETE", "IMPLEMENTATION_COMPLETE", "RUN_FAILED", "INTERRUPTED"].includes(task.review_tag ?? ""));
      if (!canStart) throw new Error("Only Todo tasks or recoverable runs in Review can be queued.");
      const active = this.db.prepare(`SELECT 1 FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id
        WHERE r.task_id = ? AND j.status IN ('QUEUED', 'CLAIMED') LIMIT 1`).get(taskId);
      if (active) throw new Error("Task already has queued or running work.");

      if (reusedFromInputId) {
        const source = this.db.prepare(`SELECT task_id, content, delivery_status FROM run_inputs WHERE id = ?`)
          .get(reusedFromInputId) as { task_id: string; content: string; delivery_status: string } | undefined;
        if (!source || source.task_id !== taskId || !["UNDELIVERED", "DELIVERY_UNKNOWN"].includes(source.delivery_status)) {
          throw new Error("Only undelivered or delivery-unknown guidance from this task can be reused.");
        }
        if (source.content !== prompt) throw new Error("Reused guidance must match the original text.");
      }

      const sequence = (this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM task_runs WHERE task_id = ?")
        .get(taskId) as { next: number }).next;
      const maxPosition = (this.db.prepare("SELECT COALESCE(MAX(queue_position), 0) AS position FROM agent_jobs WHERE status = 'QUEUED'")
        .get() as { position: number }).position;
      job.queue_position = maxPosition + 1;
      this.db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, return_workflow_state, return_review_tag)
        VALUES (?, ?, ?, ?, 'QUEUED', ?, ?)`)
        .run(job.run_id, taskId, stage, sequence, task.workflow_state, task.review_tag);
      this.db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content,
        delivery_type, delivery_status, accepted_at, reused_from_input_id)
        VALUES (?, ?, ?, 1, ?, ?, 'INITIAL_PROMPT', 'PENDING', ?, ?)`)
        .run(inputId, taskId, job.run_id, idempotencyKey, prompt, now, reusedFromInputId ?? null);
      this.db.prepare(`INSERT INTO agent_jobs (id, task_run_id, queue_position, priority, status, created_at)
        VALUES (?, ?, ?, 0, 'QUEUED', ?)`)
        .run(job.job_id, job.run_id, job.queue_position, now);
      if (task.workflow_state === "TODO" || task.workflow_state === "REVIEW") {
        this.db.prepare("UPDATE tasks SET workflow_state = 'IN_PROGRESS', review_tag = NULL, updated_at = ? WHERE id = ?")
          .run(now, taskId);
      }
      return job;
    })();
    this.dispatch();
    return result;
  }

  getSnapshot(): QueueSnapshot {
    const rows = this.db.prepare(`SELECT j.id AS job_id, j.task_run_id AS run_id, j.queue_position,
        j.status AS job_status, j.created_at, r.task_id, r.stage, r.status AS run_status, i.content AS prompt
      FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id
      JOIN run_inputs i ON i.run_id = r.id AND i.delivery_type = 'INITIAL_PROMPT'
      WHERE j.status IN ('QUEUED', 'CLAIMED') ORDER BY CASE WHEN j.status = 'CLAIMED' THEN 0 ELSE 1 END,
        j.priority DESC, j.queue_position, j.created_at`).all() as QueueItem[];
    return {
      jobs: rows,
      max_concurrent_agents: this.maxConcurrentAgents,
      active_count: rows.filter((row) => row.job_status === "CLAIMED").length,
    };
  }

  async stopRun(runId: string): Promise<void> {
    const result = this.db.transaction(() => {
      const active = this.db.prepare(`SELECT j.id AS job_id, j.status AS job_status, r.task_id,
          r.status AS run_status, r.stage FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id WHERE r.id = ?`)
        .get(runId) as { job_id: string; job_status: string; task_id: string; run_status: string; stage: string } | undefined;
      if (!active) throw new Error(`Run ${runId} not found.`);
      const answeredRequest = this.db.prepare(`SELECT 1 FROM human_requests
        WHERE run_id = ? AND status = 'ANSWERED' LIMIT 1`).get(runId);
      const humanWait = active.run_status === "WAITING_FOR_HUMAN";
      const answeredContinuation = active.run_status === "QUEUED" && !!answeredRequest;

      if ((humanWait || answeredContinuation) &&
        ["WAITING_FOR_HUMAN", "QUEUED", "CLAIMED"].includes(active.job_status)) {
        const now = new Date().toISOString();
        this.db.prepare(`UPDATE agent_jobs SET status = 'CANCELLED', queue_position = NULL, completed_at = ?
          WHERE id = ? AND status IN ('WAITING_FOR_HUMAN', 'QUEUED', 'CLAIMED')`).run(now, active.job_id);
        this.db.prepare(`UPDATE human_requests SET status = 'CANCELLED'
          WHERE run_id = ? AND status = 'PENDING'`).run(runId);
        this.normalizeQueuePositions();
        return "HUMAN_WAIT";
      }
      if (active.job_status === "QUEUED") throw new Error("Run is queued; remove it from the queue instead.");
      if (active.job_status !== "CLAIMED") throw new Error(`Run ${runId} is not active.`);
      if (active.run_status === "RUNNING") return "RUNNING";
      if (active.run_status !== "QUEUED") throw new Error(`Run ${runId} is not active.`);

      const now = new Date().toISOString();
      const status = active.stage === "VALIDATION_REVIEW" ? "FAILED" : "INTERRUPTED";
      const tag = active.stage === "VALIDATION_REVIEW" ? "VALIDATION_FAILED" : "INTERRUPTED";
      const stopped = this.db.prepare(`UPDATE task_runs SET status = ?, reason_code = 'USER_STOPPED', interrupted_at = ?,
        completed_at = ?, error_message = 'Run stopped by user before agent start.' WHERE id = ? AND status = 'QUEUED'`)
        .run(status, now, active.stage === "VALIDATION_REVIEW" ? now : null, runId);
      if (stopped.changes !== 1) throw new Error(`Run ${runId} is no longer queued.`);
      this.db.prepare(`UPDATE run_inputs SET delivery_status = 'UNDELIVERED', failure_reason = 'Run stopped before dispatch.'
        WHERE run_id = ? AND delivery_status IN ('PENDING', 'ACCEPTED')`).run(runId);
      this.db.prepare("UPDATE tasks SET workflow_state = 'REVIEW', review_tag = ?, updated_at = ? WHERE id = ?")
        .run(tag, now, active.task_id);
      return "STOPPED";
    })();
    if (result === "RUNNING") {
      await this.runs.stop(runId);
    } else if (result === "HUMAN_WAIT") {
      if (typeof this.runs.stop === "function") await this.runs.stop(runId);
      else this.markHumanWaitStopped(runId);
      this.suspended.delete(runId);
      this.dispatch();
    }
  }

  parkForHuman(runId: string, requestId: string): void {
    const execution = this.suspended.get(runId);
    if (!execution) throw new Error(`Run ${runId} has no active queue lease to park.`);
    this.db.transaction(() => {
      const state = this.db.prepare(`SELECT j.id AS job_id, j.status AS job_status, r.status AS run_status,
          h.status AS request_status FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id
          JOIN human_requests h ON h.run_id = r.id WHERE r.id = ? AND h.id = ?`)
        .get(runId, requestId) as { job_id: string; job_status: string; run_status: string; request_status: string } | undefined;
      if (!state || state.job_id !== execution.jobId || state.job_status !== "CLAIMED" ||
        state.run_status !== "RUNNING" || state.request_status !== "PENDING") {
        throw new Error("Run cannot enter a Human Request wait in its current state.");
      }
      const now = new Date().toISOString();
      this.db.prepare("UPDATE task_runs SET status = 'WAITING_FOR_HUMAN' WHERE id = ? AND status = 'RUNNING'").run(runId);
      this.db.prepare("UPDATE agent_jobs SET status = 'WAITING_FOR_HUMAN', queue_position = NULL WHERE id = ? AND status = 'CLAIMED'")
        .run(state.job_id);
      this.db.prepare(`UPDATE tasks SET workflow_state = 'REQUIRES_HUMAN', review_tag = NULL, updated_at = ?
        WHERE id = (SELECT task_id FROM task_runs WHERE id = ?)`).run(now, runId);
    })();
    execution.requestId = requestId;
    execution.parked = true;
    execution.notifyParked();
  }

  resumeHumanRun(runId: string, requestId: string): void {
    const result = this.db.transaction(() => {
      const job = this.db.prepare(`SELECT j.id AS job_id, j.status AS job_status, r.status AS run_status,
          h.status AS request_status FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id
          JOIN human_requests h ON h.run_id = r.id WHERE r.id = ? AND h.id = ?`)
        .get(runId, requestId) as { job_id: string; job_status: string; run_status: string; request_status: string } | undefined;
      if (!job) throw new Error(`Human Request ${requestId} is not associated with a queued run.`);
      if (job.request_status !== "ANSWERED") throw new Error("Only an answered Human Request can resume.");
      if (job.job_status === "CANCELLED" || ["INTERRUPTED", "FAILED"].includes(job.run_status)) return false;
      const pendingRequest = this.db.prepare(`SELECT 1 FROM human_requests
        WHERE run_id = ? AND status = 'PENDING' LIMIT 1`).get(runId);
      if (pendingRequest) return false;
      if (job.job_status !== "WAITING_FOR_HUMAN" || job.run_status !== "WAITING_FOR_HUMAN") {
        throw new Error("Run is not parked for a Human Request.");
      }
      const position = (this.db.prepare("SELECT COALESCE(MAX(queue_position), 0) + 1 AS next FROM agent_jobs WHERE status = 'QUEUED'")
        .get() as { next: number }).next;
      this.db.prepare(`UPDATE task_runs SET status = 'QUEUED' WHERE id = ? AND status = 'WAITING_FOR_HUMAN'`).run(runId);
      this.db.prepare(`UPDATE agent_jobs SET status = 'QUEUED', queue_position = ?, started_at = NULL
        WHERE id = ? AND status = 'WAITING_FOR_HUMAN'`).run(position, job.job_id);
      this.normalizeQueuePositions();
      return true;
    })();
    if (result) this.dispatch();
  }

  remove(jobId: string): void {
    this.db.transaction(() => {
      const job = this.db.prepare(`SELECT j.task_run_id AS run_id, r.task_id, r.return_workflow_state, r.return_review_tag
        FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id
        WHERE j.id = ? AND j.status = 'QUEUED'`).get(jobId) as {
          run_id: string; task_id: string; return_workflow_state: string | null; return_review_tag: string | null;
        } | undefined;
      if (!job) throw new Error("Queued job not found.");
      const now = new Date().toISOString();
      this.db.prepare("UPDATE agent_jobs SET status = 'CANCELLED', completed_at = ? WHERE id = ?").run(now, jobId);
      this.db.prepare("UPDATE task_runs SET status = 'CANCELLED', completed_at = ? WHERE id = ?").run(now, job.run_id);
      this.db.prepare("UPDATE run_inputs SET delivery_status = 'UNDELIVERED' WHERE run_id = ? AND delivery_status IN ('PENDING', 'ACCEPTED')")
        .run(job.run_id);
      this.db.prepare("UPDATE tasks SET workflow_state = ?, review_tag = ?, updated_at = ? WHERE id = ?")
        .run(job.return_workflow_state ?? "TODO", job.return_review_tag, now, job.task_id);
      this.normalizeQueuePositions();
    })();
    this.dispatch();
  }

  reorder(jobId: string, position: number): void {
    this.db.transaction(() => {
      const queue = this.db.prepare("SELECT id FROM agent_jobs WHERE status = 'QUEUED' ORDER BY priority DESC, queue_position, created_at")
        .all() as Array<{ id: string }>;
      const currentIndex = queue.findIndex((job) => job.id === jobId);
      if (currentIndex < 0) throw new Error("Queued job not found.");
      if (!Number.isInteger(position) || position < 1 || position > queue.length) throw new Error("Queue position is out of range.");
      const [job] = queue.splice(currentIndex, 1);
      queue.splice(position - 1, 0, job);
      queue.forEach((item, index) => this.db.prepare("UPDATE agent_jobs SET queue_position = ? WHERE id = ?")
        .run(index + 1, item.id));
    })();
  }

  private dispatch(): void {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.active.size < this.maxConcurrentAgents) {
        const job = this.claimNext();
        if (!job) break;
        const promise = this.execute(job);
        this.active.set(job.job_id, promise);
        void promise.finally(() => {
          this.active.delete(job.job_id);
          this.dispatch();
        });
      }
    } finally {
      this.dispatching = false;
    }
  }

  private claimNext(): ClaimedJob | undefined {
    return this.db.transaction(() => {
      const activeCount = (this.db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE status = 'CLAIMED'").get() as { count: number }).count;
      if (activeCount >= this.maxConcurrentAgents) return undefined;
      const job = this.db.prepare(`SELECT j.id AS job_id, j.task_run_id AS run_id, r.task_id
        FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id
        WHERE j.status = 'QUEUED' ORDER BY j.priority DESC, j.queue_position, j.created_at LIMIT 1`).get() as ClaimedJob | undefined;
      if (!job) return undefined;
      const now = new Date().toISOString();
      this.db.prepare("UPDATE agent_jobs SET status = 'CLAIMED', started_at = ? WHERE id = ? AND status = 'QUEUED'")
        .run(now, job.job_id);
      this.normalizeQueuePositions();
      return job;
    })();
  }

  private async execute(job: ClaimedJob): Promise<void> {
    try {
      const suspended = this.suspended.get(job.run_id);
      if (suspended?.parked) {
        const requestId = suspended.requestId;
        if (!requestId) throw new Error(`Run ${job.run_id} has no Human Request to resume.`);
        suspended.parked = false;
        suspended.requestId = null;
        suspended.parkedPromise = new Promise<void>((resolve) => { suspended.notifyParked = resolve; });
        const completion = typeof this.runs.resume === "function"
          ? this.runs.resume(job.run_id, requestId)
          : this.runs.start(job.run_id, undefined, requestId);
        const outcome = await Promise.race([
          completion.then(() => "completed" as const),
          suspended.parkedPromise.then(() => "parked" as const),
        ]);
        if (outcome !== "parked" && !suspended.parked) this.suspended.delete(job.run_id);
        return;
      }

      const restartRequest = this.db.prepare(`SELECT id FROM human_requests
        WHERE run_id = ? AND status = 'ANSWERED' ORDER BY answered_at DESC, id DESC LIMIT 1`).get(job.run_id) as
        { id: string } | undefined;
      const runStatus = (this.db.prepare("SELECT status FROM task_runs WHERE id = ?").get(job.run_id) as
        { status: string }).status;
      if (restartRequest && runStatus === "QUEUED" && typeof this.runs.resumeAfterRestart === "function") {
        await this.runs.resumeAfterRestart(job.run_id, restartRequest.id);
        return;
      }

      const worktreePath = (this.db.prepare("SELECT worktree_path FROM tasks WHERE id = ?").get(job.task_id) as
        { worktree_path: string | null }).worktree_path;
      if (!worktreePath && this.worktrees) await this.worktrees.createTaskWorktree(job.task_id);
      const prompt = this.db.transaction(() => {
        const cutoff = this.db.prepare(`UPDATE task_runs SET input_mode = 'STEERING'
          WHERE id = ? AND status = 'QUEUED' AND input_mode = 'QUEUED'`).run(job.run_id);
        if (cutoff.changes !== 1) throw new Error(`Run ${job.run_id} could not enter dispatch.`);
        return buildRunPrompt(this.db, job.run_id);
      })();
      let notifyParked!: () => void;
      const parkedPromise = new Promise<void>((resolve) => { notifyParked = resolve; });
      const execution: SuspendedExecution = {
        jobId: job.job_id,
        requestId: null,
        parked: false,
        notifyParked,
        parkedPromise,
      };
      this.suspended.set(job.run_id, execution);
      const completion = this.runs.start(job.run_id, prompt);
      const outcome = await Promise.race([
        completion.then(() => "completed" as const),
        parkedPromise.then(() => "parked" as const),
      ]);
      if (outcome !== "parked" && !execution.parked) this.suspended.delete(job.run_id);
    } catch (error) {
      const execution = this.suspended.get(job.run_id);
      if (!execution?.parked) this.suspended.delete(job.run_id);
      const now = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const claimed = this.db.prepare("SELECT status FROM agent_jobs WHERE id = ?").get(job.job_id) as
        { status: string } | undefined;
      if (claimed?.status === "CLAIMED") {
        const failed = this.db.prepare(`UPDATE task_runs SET status = 'FAILED', completed_at = ?, error_message = ?
          WHERE id = ? AND status IN ('QUEUED', 'RUNNING')`).run(now, message, job.run_id);
        if (failed.changes) {
          this.db.prepare(`UPDATE tasks SET workflow_state = 'REVIEW', review_tag = 'RUN_FAILED', updated_at = ?
            WHERE id = ?`).run(now, job.task_id);
          this.db.prepare(`UPDATE run_inputs SET delivery_status = 'UNDELIVERED', failure_reason = ?
            WHERE run_id = ? AND delivery_status IN ('PENDING', 'ACCEPTED')`).run(message, job.run_id);
          this.db.prepare(`UPDATE human_requests SET status = 'CANCELLED'
            WHERE run_id = ? AND status = 'PENDING'`).run(job.run_id);
        }
      }
    } finally {
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE agent_jobs SET status = 'FINISHED', completed_at = ?
        WHERE id = ? AND status = 'CLAIMED'`).run(now, job.job_id);
      this.normalizeQueuePositions();
    }
  }

  private markHumanWaitStopped(runId: string): void {
    const now = new Date().toISOString();
    const run = this.db.prepare("SELECT task_id, stage FROM task_runs WHERE id = ?").get(runId) as
      { task_id: string; stage: string };
    const validation = run.stage === "VALIDATION_REVIEW";
    if (validation) {
      this.db.prepare(`UPDATE task_runs SET status = 'FAILED', reason_code = 'USER_STOPPED', interrupted_at = ?,
        completed_at = ?, error_message = 'Run stopped by user.' WHERE id = ?`).run(now, now, runId);
    } else {
      this.db.prepare(`UPDATE task_runs SET status = 'INTERRUPTED', reason_code = 'USER_STOPPED', interrupted_at = ?,
        error_message = 'Run stopped by user.' WHERE id = ?`).run(now, runId);
    }
    this.db.prepare(`UPDATE tasks SET workflow_state = 'REVIEW', review_tag = ?, updated_at = ? WHERE id = ?`)
      .run(validation ? "VALIDATION_FAILED" : "INTERRUPTED", now, run.task_id);
  }

  private markBackendInterrupted(runId: string, taskId: string, jobId: string | null, now: string): void {
    this.db.prepare(`UPDATE task_runs SET status = 'INTERRUPTED', reason_code = 'BACKEND_INTERRUPTED',
      interrupted_at = ?, error_message = 'Backend restarted while run was active.' WHERE id = ? AND status = 'RUNNING'`)
      .run(now, runId);
    this.db.prepare(`UPDATE run_inputs SET delivery_status = CASE
      WHEN delivery_status = 'ACCEPTED' THEN 'DELIVERY_UNKNOWN' ELSE 'UNDELIVERED' END,
      failure_reason = 'Backend restarted before transcript delivery could be confirmed.'
      WHERE run_id = ? AND delivery_status IN ('PENDING', 'ACCEPTED')`).run(runId);
    this.db.prepare(`UPDATE tasks SET workflow_state = 'REVIEW', review_tag = 'INTERRUPTED', updated_at = ? WHERE id = ?`)
      .run(now, taskId);
    if (jobId) {
      this.db.prepare(`UPDATE agent_jobs SET status = 'FINISHED', completed_at = ?
        WHERE id = ? AND status NOT IN ('CANCELLED', 'FINISHED')`).run(now, jobId);
    }
  }

  private normalizeQueuePositions(): void {
    const queued = this.db.prepare("SELECT id FROM agent_jobs WHERE status = 'QUEUED' ORDER BY priority DESC, queue_position, created_at")
      .all() as Array<{ id: string }>;
    queued.forEach((job, index) => this.db.prepare("UPDATE agent_jobs SET queue_position = ? WHERE id = ?")
      .run(index + 1, job.id));
  }
}
