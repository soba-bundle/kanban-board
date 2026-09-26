import type Database from "better-sqlite3";
import { AgentManager } from "./agent-manager.js";

interface RunRow {
  task_id: string;
  status: string;
}

export class RunManager {
  constructor(private readonly db: Database.Database, private readonly agents: AgentManager) {}

  async start(runId: string, prompt: string): Promise<void> {
    const run = this.db.prepare("SELECT task_id, status FROM task_runs WHERE id = ?").get(runId) as RunRow | undefined;
    if (!run) throw new Error(`Run ${runId} not found.`);
    if (run.status !== "QUEUED") throw new Error(`Run ${runId} is not queued.`);

    this.db.prepare("UPDATE task_runs SET status = 'RUNNING', started_at = ? WHERE id = ?")
      .run(new Date().toISOString(), runId);
    void this.execute(runId, run.task_id, prompt);
  }

  private async execute(runId: string, taskId: string, prompt: string): Promise<void> {
    try {
      const session = await this.agents.getOrCreateWorkingSession(taskId);
      this.db.prepare("UPDATE task_runs SET session_id = ?, session_file = ? WHERE id = ?")
        .run(session.sessionId, session.sessionFile ?? null, runId);
      await this.agents.prompt(taskId, runId, prompt);
      this.db.prepare("UPDATE task_runs SET status = 'COMPLETED', completed_at = ? WHERE id = ?")
        .run(new Date().toISOString(), runId);
    } catch (error) {
      this.db.prepare("UPDATE task_runs SET status = 'FAILED', completed_at = ?, error_message = ? WHERE id = ?")
        .run(new Date().toISOString(), error instanceof Error ? error.message : String(error), runId);
    }
  }
}
