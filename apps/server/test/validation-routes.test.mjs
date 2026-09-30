import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

let registerValidationRoutes;
let importError;
try {
  ({ registerValidationRoutes } = await import("../dist/agents/validation-routes.js"));
} catch (error) {
  importError = error;
}

function register(t, validationService) {
  assert.equal(typeof registerValidationRoutes, "function",
    `Expected validation HTTP routes; ${importError?.message ?? "export is missing"}`);
  const app = Fastify();
  registerValidationRoutes(app, validationService);
  t.after(() => app.close());
  return app;
}

test("validation route explicitly starts the requested task and returns its queued run", async (t) => {
  const calls = [];
  const app = register(t, { async start(taskId) {
    calls.push(taskId);
    return { run_id: "validation-run-1", status: "QUEUED" };
  } });
  const response = await app.inject({ method: "POST", url: "/api/tasks/task%2F1/validation", payload: {} });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { run_id: "validation-run-1", status: "QUEUED" });
  assert.deepEqual(calls, ["task/1"]);
});

test("validation route reports eligibility and concurrency conflicts without accepting a run", async (t) => {
  const app = register(t, { async start() {
    throw Object.assign(new Error("Task has conflicting active work."), { statusCode: 409 });
  } });
  const response = await app.inject({ method: "POST", url: "/api/tasks/task-1/validation", payload: {} });
  assert.equal(response.statusCode, 409);
  assert.match(response.json().error, /conflicting active work/i);
});
