import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { openDatabase } from "../dist/db.js";
import { registerTaskRoutes } from "../dist/tasks.js";

function seedProject(db) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
}

test("task API creates, lists, edits, groups, and soft-deletes only inactive tasks", async (t) => {
  const db = openDatabase(":memory:");
  seedProject(db);
  const app = Fastify();
  registerTaskRoutes(app, db);
  t.after(async () => { await app.close(); db.close(); });

  const invalid = await app.inject({ method: "POST", url: "/api/tasks", payload: { project_id: "project-1", title: "  ", description: "" } });
  assert.equal(invalid.statusCode, 400);
  const missingProject = await app.inject({ method: "POST", url: "/api/tasks", payload: { project_id: "missing", title: "Task", description: "Details" } });
  assert.equal(missingProject.statusCode, 404);
  const missingDescription = await app.inject({ method: "POST", url: "/api/tasks", payload: { project_id: "project-1", title: "Task", description: "  " } });
  assert.equal(missingDescription.statusCode, 400);

  const created = await app.inject({
    method: "POST",
    url: "/api/tasks",
    payload: { project_id: "project-1", title: "First task", description: "Initial details" },
  });
  assert.equal(created.statusCode, 201);
  const task = created.json();
  assert.equal(task.workflow_state, "TODO");
  assert.equal(task.project_id, "project-1");

  const edited = await app.inject({
    method: "PATCH",
    url: `/api/tasks/${task.id}`,
    payload: { title: "Edited task", description: "Updated details" },
  });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json().title, "Edited task");
  assert.equal(edited.json().description, "Updated details");
  assert.equal((await app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: {} })).statusCode, 400);

  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, started_at)
    VALUES ('run-1', ?, 'INVESTIGATION', 1, 'RUNNING', ?)`).run(task.id, new Date().toISOString());
  const lockedEdit = await app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: { description: "No longer editable" } });
  assert.equal(lockedEdit.statusCode, 409);

  const listed = await app.inject({ method: "GET", url: "/api/tasks?project_id=project-1" });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().length, 1);
  assert.equal(listed.json()[0].id, task.id);

  const board = await app.inject({ method: "GET", url: "/api/board" });
  assert.equal(board.statusCode, 200);
  assert.deepEqual(Object.keys(board.json().columns), ["TODO", "IN_PROGRESS", "REQUIRES_HUMAN", "REVIEW", "DONE"]);
  assert.equal(board.json().columns.TODO[0].id, task.id);
  assert.equal(board.json().columns.IN_PROGRESS.length, 0);

  const blockedDelete = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}` });
  assert.equal(blockedDelete.statusCode, 409);
  db.prepare("UPDATE task_runs SET status = 'COMPLETED' WHERE id = 'run-1'").run();
  const deleted = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}` });
  assert.equal(deleted.statusCode, 204);
  assert.equal((await app.inject({ method: "GET", url: "/api/tasks" })).json().length, 0);
  assert.equal(db.prepare("SELECT is_active FROM tasks WHERE id = ?").get(task.id).is_active, 0);
  assert.equal((await app.inject({ method: "GET", url: "/api/board" })).json().columns.TODO.length, 0);
});

test("Mark as done moves a satisfied Review task to Done and removes only a clean worktree", async (t) => {
  const db = openDatabase(":memory:");
  seedProject(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, worktree_path, created_at, updated_at)
    VALUES ('clean-task', 'project-1', 'Clean', '', 'REVIEW', '/tmp/clean-worktree', ?, ?),
      ('dirty-task', 'project-1', 'Dirty', '', 'REVIEW', '/tmp/dirty-worktree', ?, ?),
      ('todo-task', 'project-1', 'Todo', '', 'TODO', NULL, ?, ?),
      ('active-task', 'project-1', 'Active', '', 'REVIEW', NULL, ?, ?),
      ('no-worktree-task', 'project-1', 'No worktree', '', 'REVIEW', NULL, ?, ?),
      ('branch-task', 'project-1', 'Branch changes', '', 'REVIEW', '/tmp/branch-worktree', ?, ?)`)
    .run(now, now, now, now, now, now, now, now, now, now, now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, started_at)
    VALUES ('active-run', 'active-task', 'INVESTIGATION', 1, 'RUNNING', ?)`).run(now);
  const removed = [];
  const worktrees = {
    async getTaskCompletionStatus(taskId) {
      if (taskId === "dirty-task") return { ready: false, reason: "WORKTREE_CHANGES" };
      if (taskId === "branch-task") return { ready: false, reason: "BRANCH_CHANGES" };
      return { ready: true, reason: null };
    },
    async removeTaskWorktree(taskId) {
      removed.push(taskId);
      db.prepare("UPDATE tasks SET worktree_path = NULL WHERE id = ?").run(taskId);
    },
  };
  const app = Fastify();
  registerTaskRoutes(app, db, worktrees);
  t.after(async () => { await app.close(); db.close(); });

  const preview = await app.inject({ method: "GET", url: "/api/tasks/clean-task/complete-preview" });
  assert.equal(preview.statusCode, 200);
  assert.deepEqual(preview.json(), { ready: true, reason: null });
  const done = await app.inject({ method: "POST", url: "/api/tasks/clean-task/complete" });
  assert.equal(done.statusCode, 200);
  assert.deepEqual(db.prepare("SELECT workflow_state, resolution FROM tasks WHERE id = 'clean-task'").get(),
    { workflow_state: "DONE", resolution: "CLOSED" });
  assert.equal(db.prepare("SELECT worktree_path FROM tasks WHERE id = 'clean-task'").get().worktree_path, null);
  assert.deepEqual(removed, ["clean-task"]);
  assert.equal((await app.inject({ method: "GET", url: "/api/board" })).json().columns.DONE[0].id, "clean-task");

  const dirty = await app.inject({ method: "POST", url: "/api/tasks/dirty-task/complete" });
  assert.equal(dirty.statusCode, 409);
  assert.match(dirty.json().error, /uncommitted Git changes/);
  assert.equal(db.prepare("SELECT workflow_state FROM tasks WHERE id = 'dirty-task'").get().workflow_state, "REVIEW");
  assert.equal(db.prepare("SELECT resolution FROM tasks WHERE id = 'dirty-task'").get().resolution, null);
  assert.equal(db.prepare("SELECT worktree_path FROM tasks WHERE id = 'dirty-task'").get().worktree_path, "/tmp/dirty-worktree");
  assert.equal((await app.inject({ method: "POST", url: "/api/tasks/branch-task/complete" })).statusCode, 409);
  assert.equal(db.prepare("SELECT workflow_state FROM tasks WHERE id = 'branch-task'").get().workflow_state, "REVIEW");

  assert.equal((await app.inject({ method: "POST", url: "/api/tasks/todo-task/complete" })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: "/api/tasks/active-task/complete" })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: "/api/tasks/no-worktree-task/complete" })).statusCode, 200);
  assert.deepEqual(removed, ["clean-task"]);
});

test("deleting a ticket removes its clean worktree and keeps it visible when cleanup fails", async (t) => {
  const db = openDatabase(":memory:");
  seedProject(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, worktree_path, created_at, updated_at)
    VALUES ('clean-task', 'project-1', 'Clean', '', 'REVIEW', '/tmp/clean-worktree', ?, ?),
      ('dirty-task', 'project-1', 'Dirty', '', 'REVIEW', '/tmp/dirty-worktree', ?, ?)`)
    .run(now, now, now, now);
  const removed = [];
  const worktrees = {
    async removeTaskWorktree(taskId) {
      if (taskId === "dirty-task") throw new Error("Task worktree has uncommitted changes; preserved it and marked cleanup pending.");
      removed.push(taskId);
      db.prepare("UPDATE tasks SET worktree_path = NULL WHERE id = ?").run(taskId);
    },
  };
  const app = Fastify();
  registerTaskRoutes(app, db, worktrees);
  t.after(async () => { await app.close(); db.close(); });

  const cleanDelete = await app.inject({ method: "DELETE", url: "/api/tasks/clean-task" });
  assert.equal(cleanDelete.statusCode, 204);
  assert.deepEqual(removed, ["clean-task"]);
  assert.equal(db.prepare("SELECT is_active FROM tasks WHERE id = 'clean-task'").get().is_active, 0);

  const dirtyDelete = await app.inject({ method: "DELETE", url: "/api/tasks/dirty-task" });
  assert.equal(dirtyDelete.statusCode, 409);
  assert.match(dirtyDelete.json().error, /uncommitted changes/);
  assert.equal(db.prepare("SELECT is_active FROM tasks WHERE id = 'dirty-task'").get().is_active, 1);
});
