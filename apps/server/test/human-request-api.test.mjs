import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { installLocalRequestGuards } from "../dist/security.js";
import { openDatabase } from "../dist/db.js";

let HumanRequestService;
let serviceLoadError;
try {
  ({ HumanRequestService } = await import("../dist/agents/human-requests.js"));
} catch (error) {
  serviceLoadError = error;
}
let registerHumanRequestRoutes;
let routeLoadError;
try {
  ({ registerHumanRequestRoutes } = await import("../dist/agents/human-request-routes.js"));
} catch (error) {
  routeLoadError = error;
}

function makeDb() {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', '', 'REQUIRES_HUMAN', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('run-1', 'task-1', 'INVESTIGATION', 1, 'WAITING_FOR_HUMAN')`).run();
  return db;
}

test("Human Request API persists structured answers through the real service and exposes them after reload", async (t) => {
  assert.equal(typeof registerHumanRequestRoutes, "function",
    `Expected registerHumanRequestRoutes export; ${routeLoadError?.message ?? "export is missing"}`);
  assert.equal(typeof HumanRequestService, "function",
    `Expected HumanRequestService export; ${serviceLoadError?.message ?? "export is missing"}`);
  const db = makeDb();
  const columns = db.prepare("PRAGMA table_info(human_requests)").all().map((column) => column.name);
  assert.ok(columns.includes("questions_json") && columns.includes("answers_json"),
    "migration 8 must persist the complete multi-question request and answer batch");
  const questions = [
    {
      id: "scope", label: "Scope", prompt: "Which scope?",
      options: [{ value: "small", label: "Small" }, { value: "large", label: "Large" }], allowOther: true,
    },
    {
      id: "risk", label: "Risk", prompt: "Accept the migration risk?",
      options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }], allowOther: false,
    },
  ];
  const service = new HumanRequestService(db, {
    onWaiting: async () => {},
    onAnswered: async () => {},
  });
  const waiting = service.ask({ taskId: "task-1", runId: "run-1", sessionId: "session-1",
    toolCallId: "call-1", questions });
  void waiting.catch(() => {});
  const [request] = service.listForTask("task-1");
  assert.equal(request.status, "PENDING");
  assert.deepEqual(request.questions, questions);

  const app = Fastify();
  installLocalRequestGuards(app, 3000);
  let stoppedRunId;
  registerHumanRequestRoutes(app, db, service, async (runId) => { stoppedRunId = runId; });
  await app.ready();
  t.after(async () => { await app.close(); await service.cancelForRun("run-1"); db.close(); });
  const inject = (options) => app.inject({ ...options,
    headers: { host: "localhost:3000", ...(options.headers ?? {}) } });
  const rejectedHost = await app.inject({ method: "GET", url: "/api/tasks/task-1/human-requests",
    headers: { host: "untrusted.example" } });
  assert.equal(rejectedHost.statusCode, 403, "the request routes inherit the server's local-request guard");

  const listed = await inject({ method: "GET", url: "/api/tasks/task-1/human-requests" });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json()[0].status, "PENDING");
  assert.deepEqual(listed.json()[0].questions.map((question) => question.id), ["scope", "risk"]);

  const partial = await inject({ method: "POST", url: `/api/human-requests/${request.id}/answer`, payload: {
    answers: [{ id: "scope", value: "small" }],
  } });
  assert.equal(partial.statusCode, 400);
  assert.equal(service.listForTask("task-1")[0].status, "PENDING");

  const payload = { answers: [
    { id: "scope", value: "A narrow custom scope" }, { id: "risk", value: "no" },
  ] };
  const answered = await inject({ method: "POST", url: `/api/human-requests/${request.id}/answer`, payload });
  assert.equal(answered.statusCode, 200);
  assert.deepEqual(answered.json().answers, [
    { id: "scope", value: "A narrow custom scope", label: "A narrow custom scope", wasCustom: true },
    { id: "risk", value: "no", label: "No", wasCustom: false, index: 2 },
  ]);
  const persisted = db.prepare("SELECT status, answers_json FROM human_requests WHERE id = ?").get(request.id);
  assert.equal(persisted.status, "ANSWERED");
  assert.deepEqual(JSON.parse(persisted.answers_json), answered.json().answers);

  const reloaded = await inject({ method: "GET", url: "/api/tasks/task-1/human-requests" });
  assert.equal(reloaded.statusCode, 200);
  assert.equal(reloaded.json()[0].status, "ANSWERED");
  assert.deepEqual(reloaded.json()[0].answers, answered.json().answers);
  await service.resume(request.id);

  const duplicate = await inject({ method: "POST", url: `/api/human-requests/${request.id}/answer`, payload });
  assert.equal(duplicate.statusCode, 200);
  assert.deepEqual(duplicate.json().answers, answered.json().answers);
  const conflict = await inject({ method: "POST", url: `/api/human-requests/${request.id}/answer`, payload: {
    answers: [{ id: "scope", value: "small" }, { id: "risk", value: "no" }],
  } });
  assert.equal(conflict.statusCode, 409);

  const stopped = await inject({ method: "POST", url: `/api/human-requests/${request.id}/stop` });
  assert.equal(stopped.statusCode, 200);
  assert.deepEqual(stopped.json(), { status: "stopped" });
  assert.equal(stoppedRunId, "run-1", "Stop delegates to the owning run's scheduler path");
});
