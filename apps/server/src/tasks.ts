import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { WorktreeManager } from "./git/worktree-manager.js";
import { TaskOperationCoordinator } from "./task-operation-coordinator.js";
import { randomUUID } from "node:crypto";
import {
  CheckpointConfirmationSchema,
  CreateTaskSchema,
  UpdateTaskSchema,
  WorkflowStateSchema,
  type BoardSnapshot,
  type Task,
} from "@kanban-board/shared";

const taskFields = `t.id, t.project_id, t.title, t.description, t.workflow_state, t.review_tag,
  t.latest_task_commit_sha, t.created_at, t.updated_at`;

export function hasAgentWorkStarted(db: Database.Database, taskId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM task_runs WHERE task_id = ? AND
    (started_at IS NOT NULL OR status NOT IN ('QUEUED', 'CANCELLED')) LIMIT 1`).get(taskId));
}

function listTasks(db: Database.Database, projectId?: string): Task[] {
  const scope = `FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.is_active = 1 AND p.is_active = 1${projectId ? " AND t.project_id = ?" : ""}
    ORDER BY t.created_at, t.id`;
  return (projectId
    ? db.prepare(`SELECT ${taskFields} ${scope}`).all(projectId)
    : db.prepare(`SELECT ${taskFields} ${scope}`).all()) as Task[];
}

export function registerTaskRoutes(
  app: FastifyInstance,
  db: Database.Database,
  worktrees?: WorktreeManager,
  operations = new TaskOperationCoordinator(),
) {
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
      latest_task_commit_sha: null,
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

    if (hasAgentWorkStarted(db, request.params.id)) {
      return reply.code(409).send({ error: "Task details cannot be edited after agent work has started." });
    }

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
    const release = operations.tryAcquire(request.params.id);
    if (!release) return reply.code(409).send({ error: "Another operation is in progress for this task." });
    try {
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
    } finally {
      release();
    }
  });

  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId/checkpoint-preview", async (request, reply) => {
    const task = db.prepare("SELECT workflow_state, review_tag FROM tasks WHERE id = ? AND is_active = 1")
      .get(request.params.taskId) as { workflow_state: string; review_tag: string | null } | undefined;
    if (!task) return reply.code(404).send({ error: "Task not found." });
    if (task.workflow_state !== "REVIEW" || !["INVESTIGATION_COMPLETE", "IMPLEMENTATION_COMPLETE"].includes(task.review_tag ?? "")) {
      return reply.code(409).send({ error: "Only completed work in Review can be checkpointed." });
    }
    if (!worktrees) return reply.code(503).send({ error: "Checkpointing is unavailable." });
    try {
      const preview = await worktrees.previewCheckpoint(request.params.taskId);
      return {
        tracked_changes: preview.trackedChanges,
        untracked_files: preview.untrackedFiles,
        branch: preview.branch,
        commit_sha: preview.commitSha,
        state_token: preview.stateToken,
      };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/checkpoint", async (request, reply) => {
    const parsed = CheckpointConfirmationSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const release = operations.tryAcquire(request.params.taskId);
    if (!release) return reply.code(409).send({ error: "Another operation is in progress for this task." });
    try {
      const task = db.prepare("SELECT workflow_state, review_tag FROM tasks WHERE id = ? AND is_active = 1")
        .get(request.params.taskId) as { workflow_state: string; review_tag: string | null } | undefined;
      if (!task) return reply.code(404).send({ error: "Task not found." });
      if (task.workflow_state !== "REVIEW" || !["INVESTIGATION_COMPLETE", "IMPLEMENTATION_COMPLETE"].includes(task.review_tag ?? "")) {
        return reply.code(409).send({ error: "Only completed work in Review can be checkpointed." });
      }
      if (!worktrees) return reply.code(503).send({ error: "Checkpointing is unavailable." });

      const expected = {
        trackedChanges: parsed.data.tracked_changes,
        untrackedFiles: parsed.data.include_untracked_files,
        branch: parsed.data.branch,
        commitSha: parsed.data.commit_sha,
        stateToken: parsed.data.state_token,
      };
      const preview = await worktrees.previewCheckpoint(request.params.taskId);
      if (JSON.stringify(preview.trackedChanges) !== JSON.stringify(expected.trackedChanges) ||
          JSON.stringify(preview.untrackedFiles) !== JSON.stringify(expected.untrackedFiles) ||
          preview.branch !== expected.branch || preview.commitSha !== expected.commitSha || preview.stateToken !== expected.stateToken) {
        return reply.code(409).send({
          error: "Task worktree or Git state changed; review the checkpoint contents again.",
          tracked_changes: preview.trackedChanges,
          untracked_files: preview.untrackedFiles,
        });
      }

      let sha: string;
      try {
        sha = await worktrees.createCheckpoint(request.params.taskId, expected);
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
      }
      try {
        const now = new Date().toISOString();
        db.transaction(() => {
          db.prepare("UPDATE tasks SET latest_task_commit_sha = ?, active_validation_snapshot_id = NULL, updated_at = ? WHERE id = ?")
            .run(sha, now, request.params.taskId);
          db.prepare(`UPDATE task_runs SET task_commit_sha = ? WHERE id = (
            SELECT id FROM task_runs WHERE task_id = ? AND status = 'COMPLETED'
            ORDER BY sequence DESC LIMIT 1)`)
            .run(sha, request.params.taskId);
        })();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(500).send({
          error: `Checkpoint commit ${sha} succeeded, but its metadata could not be saved. Do not retry blindly: ${message}`,
          commit_sha: sha,
        });
      }
      return { commit_sha: sha };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      release();
    }
  });

  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId/checkpoint-diff", async (request, reply) => {
    const row = db.prepare(`SELECT base_commit_sha, latest_task_commit_sha FROM tasks
      WHERE id = ? AND is_active = 1`).get(request.params.taskId) as
      { base_commit_sha: string | null; latest_task_commit_sha: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: "Task not found." });
    if (!row.base_commit_sha || !row.latest_task_commit_sha) {
      return reply.code(409).send({ error: "This task has no checkpoint to compare yet." });
    }
    if (!worktrees) return reply.code(503).send({ error: "Diff viewing is unavailable." });
    try {
      const [diff, files] = await Promise.all([
        worktrees.getDiff(request.params.taskId, row.base_commit_sha, row.latest_task_commit_sha),
        worktrees.getChangedFiles(request.params.taskId, row.base_commit_sha, row.latest_task_commit_sha),
      ]);
      return { from_sha: row.base_commit_sha, to_sha: row.latest_task_commit_sha, files, diff };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
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
