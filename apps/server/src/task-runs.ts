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
  validation_result: string | null;
  findings_json: string | null;
}

export function registerTaskRunRoutes(app: FastifyInstance, db: Database.Database) {
  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId/runs", async (request, reply) => {
    const task = db.prepare(`SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.id = ? AND t.is_active = 1 AND p.is_active = 1`).get(request.params.taskId);
    if (!task) return reply.code(404).send({ error: "Task not found." });

    const rows = db.prepare(`SELECT r.id, r.stage, r.sequence, r.status, r.reason_code, r.handover_json, r.error_message,
      r.started_at, r.completed_at, v.result AS validation_result, v.findings_json
      FROM task_runs r JOIN tasks t ON t.id = r.task_id
      LEFT JOIN validation_results v ON v.run_id = r.id AND v.id = (
        SELECT candidate.id FROM validation_results candidate WHERE candidate.run_id = r.id
        ORDER BY candidate.created_at DESC LIMIT 1)
      WHERE r.task_id = ? ORDER BY r.sequence, r.id`).all(request.params.taskId) as RunRow[];
    return rows.map(({ handover_json, validation_result, findings_json, ...run }) => TaskRunSummarySchema.parse({
      ...run,
      handover: run.status === "COMPLETED" && handover_json ? JSON.parse(handover_json) : null,
      validation_result: validation_result ? {
        result: validation_result,
        findings: findings_json ? JSON.parse(findings_json) : [],
        active: false,
      } : null,
    }));
  });
}
