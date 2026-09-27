import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { QueueItem, QueueSnapshot, WorkingPhase } from "@kanban-board/shared";
import { RunManager } from "../agents/run-manager.js";
import { WorktreeManager } from "../git/worktree-manager.js";

type WorkingRunPhase = Exclude<WorkingPhase, "VALIDATION_REVIEW">;

interface ClaimedJob {
  job_id: string;
  run_id: string;
  task_id: string;
}

interface NewQueueJob {
  job_id: string;
  run_id: string;
  queue_position: number;
}

export class QueueManager {
  private pumping = false;

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
          this.db.prepare(`UPDATE task_runs SET status = 'INTERRUPTED', reason_code = 'BACKEND_INTERRUPTED',
            interrupted_at = ?, error_message = 'Backend restarted while run was active.' WHERE id = ?`).run(now, job.run_id);
          this.db.prepare(`UPDATE tasks SET workflow_state = 'REVIEW', review_tag = 'INTERRUPTED', updated_at = ? WHERE id = ?`)
            .run(now, job.task_id);
          this.db.prepare("UPDATE agent_jobs SET status = 'FINISHED', completed_at = ? WHERE id = ?").run(now, job.job_id);
        } else {
          this.db.prepare("UPDATE agent_jobs SET status = 'FINISHED', completed_at = ? WHERE id = ?").run(now, job.job_id);
        }
      }
      this.normalizeQueuePositions();
    })();
    this.dispatch();
  }

  enqueueTask(taskId: string, stage: WorkingRunPhase): NewQueueJob {
    const now = new Date().toISOString();
    const job: NewQueueJob = { job_id: randomUUID(), run_id: randomUUID(), queue_position: 0 };
    this.db.transaction(() => {
      const task = this.db.prepare(`SELECT t.workflow_state, t.review_tag FROM tasks t
        JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND t.is_active = 1 AND p.is_active = 1`).get(taskId) as
        { workflow_state: string; review_tag: string | null } | undefined;
      if (!task) throw new Error(`Task ${taskId} not found.`);
      if (task.workflow_state !== "TODO") throw new Error("Only Todo tasks can be queued in this phase.");
      const active = this.db.prepare(`SELECT 1 FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id
        WHERE r.task_id = ? AND j.status IN ('QUEUED', 'CLAIMED') LIMIT 1`).get(taskId);
      if (active) throw new Error("Task already has queued or running work.");

      const sequence = (this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM task_runs WHERE task_id = ?")
        .get(taskId) as { next: number }).next;
      const maxPosition = (this.db.prepare("SELECT COALESCE(MAX(queue_position), 0) AS max FROM agent_jobs WHERE status = 'QUEUED'")
        .get() as { max: number }).max;
      job.queue_position = maxPosition + 1;
      this.db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, return_workflow_state, return_review_tag)
        VALUES (?, ?, ?, ?, 'QUEUED', ?, ?)`)
        .run(job.run_id, taskId, stage, sequence, task.workflow_state, task.review_tag);
      this.db.prepare(`INSERT INTO agent_jobs (id, task_run_id, queue_position, priority, status, created_at)
        VALUES (?, ?, ?, 0, 'QUEUED', ?)`)
        .run(job.job_id, job.run_id, job.queue_position, now);
      this.db.prepare("UPDATE tasks SET workflow_state = 'IN_PROGRESS', updated_at = ? WHERE id = ?")
        .run(now, taskId);
    })();
    this.dispatch();
    return job;
  }

  getSnapshot(): QueueSnapshot {
    const jobs = this.db.prepare(`SELECT j.id AS job_id, r.id AS run_id, r.task_id, t.title, r.stage,
        CASE WHEN j.status = 'QUEUED' THEN j.queue_position ELSE NULL END AS queue_position,
        j.status AS job_status, r.status AS run_status
      FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id JOIN tasks t ON t.id = r.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE j.status IN ('QUEUED', 'CLAIMED') AND t.is_active = 1 AND p.is_active = 1
      ORDER BY CASE j.status WHEN 'CLAIMED' THEN 0 ELSE 1 END, j.priority DESC, j.queue_position, j.created_at`)
      .all() as QueueItem[];
    const activeCount = jobs.filter((job) => job.job_status === "CLAIMED").length;
    return { max_concurrent_agents: this.maxConcurrentAgents, active_count: activeCount, jobs };
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

  async stopRun(runId: string): Promise<void> {
    const active = this.db.prepare(`SELECT j.id AS job_id, j.status AS job_status, r.task_id, r.status AS run_status, r.stage
      FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id WHERE r.id = ?`).get(runId) as {
        job_id: string; job_status: string; task_id: string; run_status: string; stage: string;
      } | undefined;
    if (!active) throw new Error(`Run ${runId} not found.`);
    if (active.job_status === "QUEUED") throw new Error("Run is queued; remove it from the queue instead.");
    if (active.job_status !== "CLAIMED") throw new Error(`Run ${runId} is not active.`);
    if (active.run_status === "RUNNING") {
      await this.runs.stop(runId);
      return;
    }
    if (active.run_status !== "QUEUED") throw new Error(`Run ${runId} is not active.`);

    const now = new Date().toISOString();
    const status = active.stage === "VALIDATION_REVIEW" ? "FAILED" : "INTERRUPTED";
    const tag = active.stage === "VALIDATION_REVIEW" ? "VALIDATION_FAILED" : "INTERRUPTED";
    this.db.prepare(`UPDATE task_runs SET status = ?, reason_code = 'USER_STOPPED', interrupted_at = ?,
      completed_at = ?, error_message = 'Run stopped by user before agent start.' WHERE id = ? AND status = 'QUEUED'`)
      .run(status, now, active.stage === "VALIDATION_REVIEW" ? now : null, runId);
    this.db.prepare("UPDATE tasks SET workflow_state = 'REVIEW', review_tag = ?, updated_at = ? WHERE id = ?")
      .run(tag, now, active.task_id);
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
      this.db.prepare("UPDATE tasks SET workflow_state = ?, review_tag = ?, updated_at = ? WHERE id = ?")
        .run(job.return_workflow_state ?? "TODO", job.return_review_tag, now, job.task_id);
      this.normalizeQueuePositions();
    })();
  }

  private dispatch(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      let job: ClaimedJob | undefined;
      while ((job = this.claimNext())) void this.execute(job);
    } finally {
      this.pumping = false;
    }
  }

  private claimNext(): ClaimedJob | undefined {
    return this.db.transaction(() => {
      const activeCount = (this.db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE status = 'CLAIMED'")
        .get() as { count: number }).count;
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
      let task = this.db.prepare("SELECT title, description, worktree_path FROM tasks WHERE id = ?").get(job.task_id) as
        { title: string; description: string; worktree_path: string | null };
      if (!task.worktree_path && this.worktrees) {
        await this.worktrees.createTaskWorktree(job.task_id);
        task = this.db.prepare("SELECT title, description, worktree_path FROM tasks WHERE id = ?").get(job.task_id) as
          { title: string; description: string; worktree_path: string | null };
      }
      const run = this.db.prepare("SELECT stage FROM task_runs WHERE id = ?").get(job.run_id) as { stage: WorkingPhase };
      const prompt = `${run.stage === "INVESTIGATION" ? "Investigate" : "Implement"} this task.\n\nTitle: ${task.title}\n\nDescription:\n${task.description}`;
      await this.runs.start(job.run_id, prompt);
    } catch (error) {
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE task_runs SET status = 'FAILED', completed_at = ?, error_message = ?
        WHERE id = ? AND status = 'QUEUED'`)
        .run(now, error instanceof Error ? error.message : String(error), job.run_id);
    } finally {
      const now = new Date().toISOString();
      this.db.prepare("UPDATE agent_jobs SET status = 'FINISHED', completed_at = ? WHERE id = ? AND status = 'CLAIMED'")
        .run(now, job.job_id);
      this.normalizeQueuePositions();
      this.dispatch();
    }
  }

  private normalizeQueuePositions(): void {
    const queued = this.db.prepare("SELECT id FROM agent_jobs WHERE status = 'QUEUED' ORDER BY priority DESC, queue_position, created_at")
      .all() as Array<{ id: string }>;
    queued.forEach((job, index) => this.db.prepare("UPDATE agent_jobs SET queue_position = ? WHERE id = ?")
      .run(index + 1, job.id));
  }
}
