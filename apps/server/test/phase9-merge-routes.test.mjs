import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

let registerMergeRoutes;
let importError;
try {
  ({ registerMergeRoutes } = await import("../dist/agents/merge-routes.js"));
} catch (error) {
  importError = error;
}

function register(t, mergeService) {
  assert.equal(typeof registerMergeRoutes, "function",
    `Expected Phase 9 merge routes; ${importError?.message ?? "export is missing"}`);
  const app = Fastify();
  registerMergeRoutes(app, mergeService);
  t.after(() => app.close());
  return app;
}

test("merge preview reports the exact validation and target-base state without integrating", async (t) => {
  const calls = [];
  const app = register(t, {
    async preview(taskId) {
      calls.push(taskId);
      return { eligible: true, reason: null, action: "FAST_FORWARD", base_branch: "main",
        validated_base_sha: "b".repeat(40), live_base_sha: "b".repeat(40), candidate_sha: "c".repeat(40),
        validation_snapshot_id: "snapshot-1" };
    },
  });

  const response = await app.inject({ method: "GET", url: "/api/tasks/task-1/merge-preview" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().eligible, true);
  assert.equal(response.json().candidate_sha, "c".repeat(40));
  assert.deepEqual(calls, ["task-1"]);
});

test("merge start requires explicit approval and returns the persisted attempt state", async (t) => {
  const calls = [];
  const app = register(t, {
    async start(taskId, input) {
      calls.push({ taskId, input });
      return { merge_attempt_id: "attempt-1", status: "MERGE_QUEUED" };
    },
  });

  const missingApproval = await app.inject({ method: "POST", url: "/api/tasks/task-1/merge", payload: {} });
  assert.equal(missingApproval.statusCode, 400);
  assert.deepEqual(calls, []);
  const approved = await app.inject({ method: "POST", url: "/api/tasks/task-1/merge", payload: { confirmed: true } });
  assert.equal(approved.statusCode, 202);
  assert.deepEqual(approved.json(), { merge_attempt_id: "attempt-1", status: "MERGE_QUEUED" });
  assert.deepEqual(calls, [{ taskId: "task-1", input: { confirmed: true } }]);
});

test("merge start maps stale/ineligible and operation-lock conflicts without accepting approval", async (t) => {
  const app = register(t, {
    async start() { throw Object.assign(new Error("Validation snapshot is stale."), { statusCode: 409 }); },
  });
  const response = await app.inject({ method: "POST", url: "/api/tasks/task-1/merge", payload: { confirmed: true } });
  assert.equal(response.statusCode, 409);
  assert.match(response.json().error, /stale/i);
});

test("manual conflict actions delegate to the task's merge attempt and report completion state", async (t) => {
  const calls = [];
  const app = register(t, {
    async abort(taskId) { calls.push(["abort", taskId]); return { status: "ABORTED" }; },
    async retry(taskId) { calls.push(["retry", taskId]); return { status: "VALIDATION_REQUIRED" }; },
    async viewConflicts(taskId) { calls.push(["viewConflicts", taskId]); return { status: "OPENED" }; },
  });
  const abort = await app.inject({ method: "POST", url: "/api/tasks/task-1/merge/abort" });
  const retry = await app.inject({ method: "POST", url: "/api/tasks/task-1/merge/retry" });
  const view = await app.inject({ method: "POST", url: "/api/tasks/task-1/merge/view-conflicts" });
  assert.deepEqual([abort.statusCode, retry.statusCode, view.statusCode], [200, 200, 200]);
  assert.deepEqual(calls, [["abort", "task-1"], ["retry", "task-1"], ["viewConflicts", "task-1"]]);
});
