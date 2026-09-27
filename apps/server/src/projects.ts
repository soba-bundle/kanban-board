import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { resolveGitRoot } from "./git/repository.js";
import {
  CreateProjectSchema,
  UpdateProjectSchema,
  ValidateGitRootSchema,
} from "@kanban-board/shared";

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  ide_command: string | null;
  worktree_root: string | null;
  created_at: string;
  updated_at: string;
}

function normalizePath(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isDuplicateRoot(db: Database.Database, rootPath: string, exceptId?: string): boolean {
  const projects = db.prepare("SELECT id, root_path FROM projects WHERE is_active = 1").all() as Array<{ id: string; root_path: string }>;
  return projects.some((project) => project.id !== exceptId && normalizePath(project.root_path) === normalizePath(rootPath));
}

export function registerProjectRoutes(app: FastifyInstance, db: Database.Database) {
  app.get("/api/projects", async () => {
    return db.prepare("SELECT * FROM projects WHERE is_active = 1 ORDER BY name COLLATE NOCASE").all();
  });

  app.post("/api/projects/validate-git-root", async (request, reply) => {
    const parsed = ValidateGitRootSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const rootPath = await resolveGitRoot(parsed.data.root_path);
      return { root_path: rootPath };
    } catch {
      return reply.code(400).send({ error: "Path is not a valid local Git working tree." });
    }
  });

  app.post("/api/projects", async (request, reply) => {
    const parsed = CreateProjectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    let rootPath: string;
    try {
      rootPath = await resolveGitRoot(parsed.data.root_path);
    } catch {
      return reply.code(400).send({ error: "Path is not a valid local Git working tree." });
    }

    if (isDuplicateRoot(db, rootPath)) return reply.code(409).send({ error: "This Git repository is already registered." });

    const timestamp = new Date().toISOString();
    const project: ProjectRow = {
      id: randomUUID(),
      name: parsed.data.name,
      root_path: rootPath,
      ide_command: parsed.data.ide_command ?? null,
      worktree_root: parsed.data.worktree_root ? resolve(parsed.data.worktree_root) : null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    db.prepare(`INSERT INTO projects
      (id, name, root_path, ide_command, worktree_root, created_at, updated_at)
      VALUES (@id, @name, @root_path, @ide_command, @worktree_root, @created_at, @updated_at)`)
      .run(project);
    return reply.code(201).send(project);
  });

  app.put<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const parsed = UpdateProjectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const current = db.prepare("SELECT id FROM projects WHERE id = ? AND is_active = 1").get(request.params.id);
    if (!current) return reply.code(404).send({ error: "Project not found." });

    let rootPath: string;
    try {
      rootPath = await resolveGitRoot(parsed.data.root_path);
    } catch {
      return reply.code(400).send({ error: "Path is not a valid local Git working tree." });
    }
    if (isDuplicateRoot(db, rootPath, request.params.id)) {
      return reply.code(409).send({ error: "This Git repository is already registered." });
    }

    const updated: ProjectRow = {
      id: request.params.id,
      name: parsed.data.name,
      root_path: rootPath,
      ide_command: parsed.data.ide_command ?? null,
      worktree_root: parsed.data.worktree_root ? resolve(parsed.data.worktree_root) : null,
      created_at: "",
      updated_at: new Date().toISOString(),
    };
    db.prepare(`UPDATE projects SET name = @name, root_path = @root_path,
      ide_command = @ide_command, worktree_root = @worktree_root, updated_at = @updated_at
      WHERE id = @id`).run(updated);
    return db.prepare("SELECT * FROM projects WHERE id = ?").get(request.params.id);
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const project = db.prepare("SELECT id FROM projects WHERE id = ? AND is_active = 1").get(request.params.id);
    if (!project) return reply.code(404).send({ error: "Project not found." });
    const activeWork = db.prepare(`SELECT 1 FROM tasks t WHERE t.project_id = ? AND t.is_active = 1 AND (
      EXISTS (SELECT 1 FROM task_runs r WHERE r.task_id = t.id
        AND r.status IN ('QUEUED', 'RUNNING', 'WAITING_FOR_HUMAN', 'WAITING_FOR_INFERENCE')) OR
      EXISTS (SELECT 1 FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id
        WHERE r.task_id = t.id AND j.status IN ('QUEUED', 'CLAIMED'))
      ) LIMIT 1`).get(request.params.id);
    if (activeWork) return reply.code(409).send({ error: "Remove queued work or stop active runs before deleting this project." });

    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare("UPDATE tasks SET is_active = 0, updated_at = ? WHERE project_id = ? AND is_active = 1").run(now, request.params.id);
      db.prepare("UPDATE projects SET is_active = 0, updated_at = ? WHERE id = ? AND is_active = 1").run(now, request.params.id);
    })();
    return reply.code(204).send();
  });
}
