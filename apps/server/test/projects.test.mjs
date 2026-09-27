import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { openDatabase } from "../dist/db.js";
import { registerProjectRoutes } from "../dist/projects.js";

function makeGitRepo(path) {
  execFileSync("git", ["init", "-b", "main", path], { stdio: "ignore" });
  execFileSync("git", ["-C", path, "config", "user.name", "Project Test"]);
  execFileSync("git", ["-C", path, "config", "user.email", "project-test@example.invalid"]);
  execFileSync("git", ["-C", path, "commit", "--allow-empty", "-m", "initial"], { stdio: "ignore" });
}

test("project API validates, rejects duplicate roots, and soft-deletes projects with their tasks", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "kanban-project-test-"));
  const repo = join(temp, "repo");
  makeGitRepo(repo);

  const db = openDatabase(join(temp, "app.sqlite"));
  const app = Fastify();
  registerProjectRoutes(app, db);
  t.after(async () => {
    await app.close();
    db.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const invalidRoot = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Invalid", root_path: temp } });
  assert.equal(invalidRoot.statusCode, 400);
  const invalidValidation = await app.inject({
    method: "POST",
    url: "/api/projects/validate-git-root",
    payload: { root_path: temp },
  });
  assert.equal(invalidValidation.statusCode, 400);
  const validValidation = await app.inject({
    method: "POST",
    url: "/api/projects/validate-git-root",
    payload: { root_path: repo },
  });
  assert.equal(validValidation.statusCode, 200);

  const created = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "Fixture", root_path: repo, worktree_root: join(temp, "worktrees") },
  });
  assert.equal(created.statusCode, 201);
  const project = created.json();
  assert.equal(project.root_path, resolve(execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()));
  assert.equal(project.worktree_root, join(temp, "worktrees"));

  const duplicate = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Again", root_path: repo } });
  assert.equal(duplicate.statusCode, 409);
  assert.equal((await app.inject({ method: "GET", url: "/api/projects" })).json().length, 1);

  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', ?, 'Task', '', 'TODO', ?, ?)`)
    .run(project.id, new Date().toISOString(), new Date().toISOString());
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, started_at)
    VALUES ('run-1', 'task-1', 'INVESTIGATION', 1, 'RUNNING', ?)`).run(new Date().toISOString());
  const blockedDelete = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
  assert.equal(blockedDelete.statusCode, 409);

  const invalidUpdate = await app.inject({
    method: "PUT",
    url: `/api/projects/${project.id}`,
    payload: { name: "Fixture", root_path: temp },
  });
  assert.equal(invalidUpdate.statusCode, 400);

  const updated = await app.inject({
    method: "PUT",
    url: `/api/projects/${project.id}`,
    payload: { name: "Renamed", root_path: repo, ide_command: "code" },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().name, "Renamed");
  assert.equal(updated.json().ide_command, "code");
  assert.equal(db.prepare("SELECT name FROM projects WHERE id = ?").get(project.id).name, "Renamed");

  db.prepare("UPDATE task_runs SET status = 'COMPLETED' WHERE id = 'run-1'").run();
  const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
  assert.equal(deleted.statusCode, 204);
  assert.equal((await app.inject({ method: "GET", url: "/api/projects" })).json().length, 0);
  assert.equal(db.prepare("SELECT is_active FROM projects WHERE id = ?").get(project.id).is_active, 0);
  assert.equal(db.prepare("SELECT is_active FROM tasks WHERE id = 'task-1'").get().is_active, 0);

  const secondRepo = join(temp, "second-repo");
  makeGitRepo(secondRepo);
  const second = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "Removable", root_path: secondRepo },
  });
  assert.equal(second.statusCode, 201);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/projects/${second.json().id}` })).statusCode, 204);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/projects/${second.json().id}` })).statusCode, 404);
});
