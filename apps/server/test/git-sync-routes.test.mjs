import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

let registerGitSyncRoutes;
let importError;
try { ({ registerGitSyncRoutes } = await import("../dist/agents/git-sync-routes.js")); }
catch (error) { importError = error; }

function register(t, service) {
  assert.equal(typeof registerGitSyncRoutes, "function",
    `Expected Git sync routes; ${importError?.message ?? "export is missing"}`);
  const app = Fastify();
  registerGitSyncRoutes(app, service);
  t.after(() => app.close());
  return app;
}

test("Sync with main is an explicit POST operation", async (t) => {
  const calls = [];
  const app = register(t, {
    async syncWithBase(taskId) { calls.push(["sync", taskId]); return { status: "SYNCED", synced_base_sha: "a".repeat(40) }; },
  });
  const sync = await app.inject({ method: "POST", url: "/api/tasks/task-1/sync" });
  assert.equal(sync.statusCode, 200);
  assert.equal(sync.json().synced_base_sha, "a".repeat(40));
  assert.deepEqual(calls, [["sync", "task-1"]]);
});

test("sync recovery routes expose persisted state and keep abort explicitly confirmed", async (t) => {
  const calls = [];
  const app = register(t, {
    async getSyncRecovery(taskId) { calls.push(["get", taskId]); return { state: "CONFLICT", can_abort: true }; },
    async viewSyncConflicts(taskId) { calls.push(["view", taskId]); return { status: "OPENED" }; },
    async retrySync(taskId) { calls.push(["retry", taskId]); return { status: "SYNCED" }; },
    async abortSync(taskId, confirmed) { calls.push(["abort", taskId, confirmed]); return { status: "ABORTED" }; },
  });
  const recovery = await app.inject({ method: "GET", url: "/api/tasks/task-1/sync-recovery" });
  assert.equal(recovery.statusCode, 200);
  assert.equal(recovery.json().recovery.state, "CONFLICT");
  const view = await app.inject({ method: "POST", url: "/api/tasks/task-1/sync/view-conflicts" });
  const retry = await app.inject({ method: "POST", url: "/api/tasks/task-1/sync/retry" });
  const abort = await app.inject({ method: "POST", url: "/api/tasks/task-1/sync/abort", payload: { confirmed: true } });
  assert.equal(view.statusCode, 200);
  assert.equal(retry.statusCode, 200);
  assert.equal(abort.statusCode, 200);
  assert.deepEqual(calls, [["get", "task-1"], ["view", "task-1"], ["retry", "task-1"], ["abort", "task-1", true]]);
});

test("sync recovery routes refuse an unconfirmed abort and preserve actionable safety errors", async (t) => {
  const app = register(t, {
    async syncWithBase() { throw Object.assign(new Error("Task worktree is dirty."), { statusCode: 409 }); },
    async abortSync(_taskId, confirmed) {
      if (!confirmed) throw Object.assign(new Error("Explicit abort confirmation is required."), { statusCode: 409 });
      throw Object.assign(new Error("Conflict worktree changed; preserve its edits."), { statusCode: 409 });
    },
  });
  const sync = await app.inject({ method: "POST", url: "/api/tasks/task-1/sync" });
  const abort = await app.inject({ method: "POST", url: "/api/tasks/task-1/sync/abort", payload: { confirmed: false } });
  assert.equal(sync.statusCode, 409);
  assert.match(sync.json().error, /dirty/i);
  assert.equal(abort.statusCode, 409);
  assert.match(abort.json().error, /explicit abort confirmation/i);
});
