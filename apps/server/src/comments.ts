import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  CreateTicketCommentSchema,
  UpdateTicketCommentSchema,
  type TicketComment,
} from "@kanban-board/shared";

// Comments may only be modified while the working session is not active, so a queued
// steering message (which only exists while a run streams) is never editable.
const EDITABLE_WORKFLOW_STATES = new Set(["TODO", "REVIEW"]);

const commentFields = `id, task_id, run_id, author_type, content, delivery_status, delivery_type,
  delivered_session_id, delivered_run_id, delivered_at, created_at, updated_at`;

export function listComments(db: Database.Database, taskId: string): TicketComment[] {
  return db.prepare(`SELECT ${commentFields} FROM ticket_comments WHERE task_id = ?
    ORDER BY created_at, id`).all(taskId) as TicketComment[];
}

function findActiveTask(db: Database.Database, taskId: string): { id: string; workflow_state: string } | undefined {
  return db.prepare(`SELECT t.id, t.workflow_state FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.id = ? AND t.is_active = 1 AND p.is_active = 1`).get(taskId) as
    { id: string; workflow_state: string } | undefined;
}

export function registerCommentRoutes(app: FastifyInstance, db: Database.Database) {
  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId/comments", async (request, reply) => {
    if (!findActiveTask(db, request.params.taskId)) return reply.code(404).send({ error: "Task not found." });
    return listComments(db, request.params.taskId);
  });

  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/comments", async (request, reply) => {
    const parsed = CreateTicketCommentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!findActiveTask(db, request.params.taskId)) return reply.code(404).send({ error: "Task not found." });

    const comment: TicketComment = {
      id: randomUUID(),
      task_id: request.params.taskId,
      run_id: null,
      author_type: "USER",
      content: parsed.data.content,
      delivery_status: "PENDING",
      delivery_type: null,
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
    return reply.code(201).send(comment);
  });

  app.patch<{ Params: { id: string } }>("/api/comments/:id", async (request, reply) => {
    const parsed = UpdateTicketCommentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const comment = requireEditableComment(db, request.params.id);
    if ("error" in comment) return reply.code(comment.status).send({ error: comment.error });

    const updated_at = new Date().toISOString();
    db.prepare("UPDATE ticket_comments SET content = ?, updated_at = ? WHERE id = ?")
      .run(parsed.data.content, updated_at, request.params.id);
    return { ...comment.comment, content: parsed.data.content, updated_at };
  });

  app.delete<{ Params: { id: string } }>("/api/comments/:id", async (request, reply) => {
    const comment = requireEditableComment(db, request.params.id);
    if ("error" in comment) return reply.code(comment.status).send({ error: comment.error });
    db.prepare("DELETE FROM ticket_comments WHERE id = ?").run(request.params.id);
    return reply.code(204).send();
  });
}

type EditableComment = { comment: TicketComment } | { status: number; error: string };

function requireEditableComment(db: Database.Database, commentId: string): EditableComment {
  const comment = db.prepare(`SELECT ${commentFields} FROM ticket_comments WHERE id = ?`)
    .get(commentId) as TicketComment | undefined;
  const task = comment ? findActiveTask(db, comment.task_id) : undefined;
  if (!comment || !task) return { status: 404, error: "Comment not found." };
  if (comment.author_type !== "USER") return { status: 409, error: "Only user comments can be modified." };
  if (comment.delivery_status !== "PENDING") {
    return { status: 409, error: "Comments already sent to the agent are immutable." };
  }
  if (!EDITABLE_WORKFLOW_STATES.has(task.workflow_state)) {
    return { status: 409, error: "Comments can only be edited while the task is in Todo or Review." };
  }
  return { comment };
}
