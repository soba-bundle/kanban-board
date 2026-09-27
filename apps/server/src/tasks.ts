import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { WorktreeManager } from "./git/worktree-manager.js";
import { randomUUID } from "node:crypto";
import {
  CreateTaskSchema,
  UpdateTaskSchema,
  WorkflowStateSchema,
  type BoardSnapshot,
  type Task,
} from "@kanban-board/shared";

const taskFields = `t.id, t.project_id, t.title, t.description, t.workflow_state, t.review_tag, t.created_at, t.updated_at`;

function listTasks(db: Database.Database, projectId?: string): Task[] {
  const scope = `FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.is_active = 1 AND p.is_active = 1${projectId ? " AND t.project_id = ?" : ""}
    ORDER BY t.created_at, t.id`;
  return (projectId
    ? db.prepare(`SELECT ${taskFields} ${scope}`).all(projectId)
    : db.prepare(`SELECT ${taskFields} ${scope}`).all()) as Task[];
}

export function registerTaskRoutes(app: FastifyInstance, db: Database.Database, worktrees?: WorktreeManager) {
  app.get<{ Querystring: { project_id?: string } }>("/api/tasks", async (request) => {
    return listTasks(db, request.query.project_id);
  });

  app.post("/api/tasks", async (request, reply) => {
    const parsed = CreateTaskSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const project = db.prepare("SELECT 1 FROM projects WHERE id = ? AND is_active = 1").get(parsed.data.project_id);
    if (!project) return reply.code(404).send({ error: "Project not found." });

    const timestamp = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      ...parsed.data,
      workflow_state: "TODO",
      review_tag: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, review_tag, created_at, updated_at)
      VALUES (@id, @project_id, @title, @description, @workflow_state, @review_tag, @created_at, @updated_at)`)
      .run(task);
    return reply.code(201).send(task);
  });

  app.patch<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const parsed = UpdateTaskSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const current = db.prepare(`SELECT ${taskFields} FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.id = ? AND t.is_active = 1 AND p.is_active = 1`).get(request.params.id) as Task | undefined;
    if (!current) return reply.code(404).send({ error: "Task not found." });

    const agentWorkStarted = db.prepare(`SELECT 1 FROM task_runs WHERE task_id = ? AND
      (started_at IS NOT NULL OR status NOT IN ('QUEUED', 'CANCELLED')) LIMIT 1`).get(request.params.id);
    if (agentWorkStarted) return reply.code(409).send({ error: "Task details cannot be edited after agent work has started." });

    const updated: Task = {
      ...current,
      ...parsed.data,
      updated_at: new Date().toISOString(),
    };
    db.prepare("UPDATE tasks SET title = ?, description = ?, updated_at = ? WHERE id = ? AND is_active = 1")
      .run(updated.title, updated.description, updated.updated_at, request.params.id);
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const task = db.prepare(`SELECT t.id, t.worktree_path FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.id = ? AND t.is_active = 1 AND p.is_active = 1`).get(request.params.id) as
      { id: string; worktree_path: string | null } | undefined;
    if (!task) return reply.code(404).send({ error: "Task not found." });
    const activeRun = db.prepare(`SELECT 1 FROM task_runs r LEFT JOIN agent_jobs j ON j.task_run_id = r.id
      WHERE r.task_id = ? AND (r.status IN ('QUEUED', 'RUNNING', 'WAITING_FOR_HUMAN', 'WAITING_FOR_INFERENCE')
        OR j.status IN ('QUEUED', 'CLAIMED')) LIMIT 1`).get(request.params.id);
    if (activeRun) return reply.code(409).send({ error: "Remove queued work or stop the active run before deleting this task." });
    const now = new Date().toISOString();
    db.prepare("UPDATE tasks SET is_active = 0, updated_at = ? WHERE id = ? AND is_active = 1")
      .run(now, request.params.id);
    if (task.worktree_path) {
      if (!worktrees) {
        db.prepare("UPDATE tasks SET is_active = 1 WHERE id = ?").run(request.params.id);
        return reply.code(503).send({ error: "Worktree cleanup is unavailable; the task was not deleted." });
      }
      try {
        await worktrees.removeTaskWorktree(request.params.id);
      } catch (error) {
        db.prepare("UPDATE tasks SET is_active = 1 WHERE id = ?").run(request.params.id);
        return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    return reply.code(204).send();
  });

  app.get("/api/board", async () => {
    const columns: BoardSnapshot["columns"] = {
      TODO: [],
      IN_PROGRESS: [],
      REQUIRES_HUMAN: [],
      REVIEW: [],
      DONE: [],
    };
    for (const task of listTasks(db)) {
      const state = WorkflowStateSchema.parse(task.workflow_state);
      columns[state].push(task);
    }
    return { columns } satisfies BoardSnapshot;
  });
}
