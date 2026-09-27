import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { openDatabase } from "../dist/db.js";
import { registerCommentRoutes } from "../dist/comments.js";

function seedTask(db) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', 'Details', 'TODO', ?, ?)`).run(now, now);
}

function startApp(t) {
  const db = openDatabase(":memory:");
  seedTask(db);
  const app = Fastify();
  registerCommentRoutes(app, db);
  t.after(async () => { await app.close(); db.close(); });
  return { app, db };
}

function startRun(db) {
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, started_at)
    VALUES ('run-1', 'task-1', 'INVESTIGATION', 1, 'RUNNING', ?)`).run(new Date().toISOString());
  setState(db, "IN_PROGRESS");
}

function setState(db, workflowState) {
  db.prepare("UPDATE tasks SET workflow_state = ? WHERE id = 'task-1'").run(workflowState);
}

test("comments API appends pending user comments and validates input", async (t) => {
  const { app } = startApp(t);

  assert.equal((await app.inject({ method: "POST", url: "/api/tasks/task-1/comments", payload: { content: "  " } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/tasks/missing/comments", payload: { content: "hi" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/tasks/missing/comments" })).statusCode, 404);

  const created = await app.inject({ method: "POST", url: "/api/tasks/task-1/comments", payload: { content: " Check the retry path " } });
  assert.equal(created.statusCode, 201);
  const comment = created.json();
  assert.equal(comment.content, "Check the retry path");
  assert.equal(comment.author_type, "USER");
  assert.equal(comment.delivery_status, "PENDING");
  assert.equal(comment.delivery_type, null);
  assert.equal(comment.updated_at, null);

  const listed = await app.inject({ method: "GET", url: "/api/tasks/task-1/comments" });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().length, 1);
  assert.equal(listed.json()[0].id, comment.id);
});

test("pending comments are editable and deletable before agent work starts", async (t) => {
  const { app } = startApp(t);
  const comment = (await app.inject({ method: "POST", url: "/api/tasks/task-1/comments", payload: { content: "first" } })).json();

  assert.equal((await app.inject({ method: "PATCH", url: `/api/comments/${comment.id}`, payload: { content: " " } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/comments/missing", payload: { content: "x" } })).statusCode, 404);

  const edited = await app.inject({ method: "PATCH", url: `/api/comments/${comment.id}`, payload: { content: "second" } });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json().content, "second");
  assert.notEqual(edited.json().updated_at, null);

  assert.equal((await app.inject({ method: "DELETE", url: `/api/comments/${comment.id}` })).statusCode, 204);
  assert.equal((await app.inject({ method: "GET", url: "/api/tasks/task-1/comments" })).json().length, 0);
});

test("comments are frozen while a run is in progress but remain appendable", async (t) => {
  const { app, db } = startApp(t);
  const comment = (await app.inject({ method: "POST", url: "/api/tasks/task-1/comments", payload: { content: "before run" } })).json();
  startRun(db);

  assert.equal((await app.inject({ method: "PATCH", url: `/api/comments/${comment.id}`, payload: { content: "changed" } })).statusCode, 409);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/comments/${comment.id}` })).statusCode, 409);

  const appended = await app.inject({ method: "POST", url: "/api/tasks/task-1/comments", payload: { content: "during run" } });
  assert.equal(appended.statusCode, 201);
  assert.equal((await app.inject({ method: "GET", url: "/api/tasks/task-1/comments" })).json().length, 2);
});

test("undelivered comments stay editable in Review after earlier runs finished", async (t) => {
  const { app, db } = startApp(t);
  startRun(db);
  const duringRun = (await app.inject({ method: "POST", url: "/api/tasks/task-1/comments", payload: { content: "typo hree" } })).json();
  db.prepare("UPDATE task_runs SET status = 'COMPLETED' WHERE id = 'run-1'").run();
  setState(db, "REVIEW");

  // Never delivered to the agent, so a finished earlier run must not freeze it.
  const edited = await app.inject({ method: "PATCH", url: `/api/comments/${duringRun.id}`, payload: { content: "typo here" } });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json().content, "typo here");

  const queuedNext = (await app.inject({ method: "POST", url: "/api/tasks/task-1/comments", payload: { content: "for next run" } })).json();
  assert.equal((await app.inject({ method: "DELETE", url: `/api/comments/${queuedNext.id}` })).statusCode, 204);
});

test("queued steering and non-editable states are rejected", async (t) => {
  const { app, db } = startApp(t);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ticket_comments (id, task_id, author_type, content, delivery_status, delivery_type, created_at)
    VALUES ('c-queued', 'task-1', 'USER', 'steer me', 'QUEUED', 'STEERING', ?)`).run(now);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/comments/c-queued", payload: { content: "x" } })).statusCode, 409);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/comments/c-queued" })).statusCode, 409);

  const pending = (await app.inject({ method: "POST", url: "/api/tasks/task-1/comments", payload: { content: "pending" } })).json();
  for (const state of ["REQUIRES_HUMAN", "DONE"]) {
    setState(db, state);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/comments/${pending.id}`, payload: { content: "x" } })).statusCode, 409);
  }
  setState(db, "REVIEW");
  assert.equal((await app.inject({ method: "PATCH", url: `/api/comments/${pending.id}`, payload: { content: "ok now" } })).statusCode, 200);
});

test("delivered and non-user comments cannot be modified", async (t) => {
  const { app, db } = startApp(t);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ticket_comments (id, task_id, author_type, content, delivery_status, delivery_type, created_at)
    VALUES ('c-delivered', 'task-1', 'USER', 'steered', 'DELIVERED', 'STEERING', ?)`).run(now);
  db.prepare(`INSERT INTO ticket_comments (id, task_id, author_type, content, delivery_status, created_at)
    VALUES ('c-agent', 'task-1', 'AGENT', 'handover summary', 'PENDING', ?)`).run(now);

  assert.equal((await app.inject({ method: "PATCH", url: "/api/comments/c-delivered", payload: { content: "x" } })).statusCode, 409);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/comments/c-delivered" })).statusCode, 409);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/comments/c-agent" })).statusCode, 409);

  // Delivery is terminal: no workflow state re-opens a delivered comment.
  for (const state of ["TODO", "IN_PROGRESS", "REVIEW", "REQUIRES_HUMAN", "DONE"]) {
    setState(db, state);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/comments/c-delivered", payload: { content: "x" } })).statusCode, 409);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/comments/c-delivered" })).statusCode, 409);
  }
});
