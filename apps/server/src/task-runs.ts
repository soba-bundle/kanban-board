import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { TaskRunSummarySchema } from "@kanban-board/shared";

interface RunRow {
  id: string;
  stage: string;
  sequence: number;
  status: string;
  reason_code: string | null;
  handover_json: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export function registerTaskRunRoutes(app: FastifyInstance, db: Database.Database) {
  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId/runs", async (request, reply) => {
    const task = db.prepare(`SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.id = ? AND t.is_active = 1 AND p.is_active = 1`).get(request.params.taskId);
    if (!task) return reply.code(404).send({ error: "Task not found." });

    const rows = db.prepare(`SELECT id, stage, sequence, status, reason_code, handover_json, error_message,
      started_at, completed_at FROM task_runs WHERE task_id = ? ORDER BY sequence, id`)
      .all(request.params.taskId) as RunRow[];
    return rows.map(({ handover_json, ...run }) => TaskRunSummarySchema.parse({
      ...run,
      stage: run.stage,
      status: run.status,
      handover: handover_json ? JSON.parse(handover_json) : null,
    }));
  });
}
