import type Database from "better-sqlite3";
import { AgentManager } from "./agent-manager.js";

interface RunRow {
  task_id: string;
  stage: string;
  status: string;
}

export class RunManager {
  private readonly stopRequested = new Set<string>();
  private readonly activeRuns = new Map<string, Promise<void>>();

  constructor(private readonly db: Database.Database, private readonly agents: AgentManager) {}

  start(runId: string, prompt: string): Promise<void> {
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

  async stop(runId: string): Promise<void> {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found.`);
    if (run.status !== "RUNNING") throw new Error(`Run ${runId} is not running.`);
    this.stopRequested.add(runId);
    await this.agents.abort(run.task_id);
    await this.activeRuns.get(runId);
  }

  private async execute(runId: string, taskId: string, prompt: string): Promise<void> {
    try {
      const session = await this.agents.getOrCreateWorkingSession(taskId);
      this.db.prepare("UPDATE task_runs SET session_id = ?, session_file = ? WHERE id = ?")
        .run(session.sessionId, session.sessionFile ?? null, runId);
      if (this.stopRequested.has(runId)) {
        this.markStopped(runId, taskId);
        return;
      }
      await this.agents.prompt(taskId, runId, prompt);
      if (this.stopRequested.has(runId)) this.markStopped(runId, taskId);
      else this.db.prepare("UPDATE task_runs SET status = 'COMPLETED', completed_at = ? WHERE id = ?")
        .run(new Date().toISOString(), runId);
    } catch (error) {
      if (this.stopRequested.has(runId)) this.markStopped(runId, taskId);
      else this.db.prepare("UPDATE task_runs SET status = 'FAILED', completed_at = ?, error_message = ? WHERE id = ?")
        .run(new Date().toISOString(), error instanceof Error ? error.message : String(error), runId);
    } finally {
      this.stopRequested.delete(runId);
    }
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
