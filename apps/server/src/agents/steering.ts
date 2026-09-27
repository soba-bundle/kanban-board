import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { TicketComment } from "@kanban-board/shared";

/**
 * Steering comments are recorded QUEUED when Pi accepts them and only become
 * DELIVERED once Pi replays them as a user message. Comments left QUEUED when a
 * run ends are stranded; see plan section 13.1 (Phase 11 recovery).
 */
export function recordSteeringQueued(
  db: Database.Database,
  taskId: string,
  runId: string,
  content: string,
): TicketComment {
  const comment: TicketComment = {
    id: randomUUID(),
    task_id: taskId,
    run_id: runId,
    author_type: "USER",
    content,
    delivery_status: "QUEUED",
    delivery_type: "STEERING",
    delivered_session_id: null,
    delivered_run_id: null,
    delivered_at: null,
    created_at: new Date().toISOString(),
    updated_at: null,
  };
  db.prepare(`INSERT INTO ticket_comments (id, task_id, run_id, author_type, content, delivery_status,
    delivery_type, delivered_session_id, delivered_run_id, delivered_at, created_at, updated_at)
    VALUES (@id, @task_id, @run_id, @author_type, @content, @delivery_status, @delivery_type,
      @delivered_session_id, @delivered_run_id, @delivered_at, @created_at, @updated_at)`).run(comment);
  return comment;
}

/** Marks the oldest queued steering comment matching this text as delivered. */
export function markSteeringDelivered(
  db: Database.Database,
  taskId: string,
  content: string,
  sessionId: string | null,
  runId: string,
): string | undefined {
  const match = db.prepare(`SELECT id FROM ticket_comments WHERE task_id = ? AND content = ?
    AND delivery_status = 'QUEUED' AND delivery_type = 'STEERING'
    ORDER BY created_at, id LIMIT 1`).get(taskId, content) as { id: string } | undefined;
  if (!match) return undefined;
  db.prepare(`UPDATE ticket_comments SET delivery_status = 'DELIVERED', delivered_session_id = ?,
    delivered_run_id = ?, delivered_at = ? WHERE id = ? AND delivery_status = 'QUEUED'`)
    .run(sessionId, runId, new Date().toISOString(), match.id);
  return match.id;
}
