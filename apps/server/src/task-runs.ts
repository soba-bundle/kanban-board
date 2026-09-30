import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { TaskRunSummarySchema } from "@kanban-board/shared";
import type { WorktreeManager } from "./git/worktree-manager.js";
import { refreshValidationReadiness } from "./agents/validation-readiness.js";

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
  active_validation_snapshot_id: string | null;
  validation_snapshot_id: string | null;
}

export function registerTaskRunRoutes(app: FastifyInstance, db: Database.Database, worktrees?: WorktreeManager) {
  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId/runs", async (request, reply) => {
    const task = db.prepare(`SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.id = ? AND t.is_active = 1 AND p.is_active = 1`).get(request.params.taskId);
    if (!task) return reply.code(404).send({ error: "Task not found." });

    const readinessCurrent = await refreshValidationReadiness(db, request.params.taskId, worktrees);
    const rows = db.prepare(`SELECT r.id, r.stage, r.sequence, r.status, r.reason_code, r.handover_json, r.error_message,
      r.started_at, r.completed_at, v.result AS validation_result, v.findings_json,
      t.active_validation_snapshot_id, s.id AS validation_snapshot_id
      FROM task_runs r JOIN tasks t ON t.id = r.task_id
      LEFT JOIN validation_results v ON v.run_id = r.id AND v.id = (
        SELECT candidate.id FROM validation_results candidate WHERE candidate.run_id = r.id
        ORDER BY candidate.created_at DESC LIMIT 1)
      LEFT JOIN validation_snapshots s ON s.validation_run_id = r.id AND s.id = (
        SELECT candidate.id FROM validation_snapshots candidate WHERE candidate.validation_run_id = r.id
        ORDER BY candidate.created_at DESC LIMIT 1)
      WHERE r.task_id = ? ORDER BY r.sequence, r.id`).all(request.params.taskId) as RunRow[];
    return rows.map(({ handover_json, validation_result, findings_json, active_validation_snapshot_id,
      validation_snapshot_id, ...run }) => TaskRunSummarySchema.parse({
      ...run,
      handover: run.status === "COMPLETED" && handover_json ? JSON.parse(handover_json) : null,
      validation_result: validation_result ? {
        result: validation_result,
        findings: findings_json ? JSON.parse(findings_json) : [],
        active: readinessCurrent && !!validation_snapshot_id && validation_snapshot_id === active_validation_snapshot_id,
      } : null,
    }));
  });
}
