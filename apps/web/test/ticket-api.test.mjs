import assert from "node:assert/strict";
import test from "node:test";
import { answerHumanRequest, createCheckpoint, loadCheckpointDiff, loadCheckpointPreview, loadHumanRequests, loadLiveHistory, loadRuns, openRunEvents, steerRun, stopHumanRequest } from "../src/ticket-api.js";

function captureFetch(t, handler = async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    return handler(url, options);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return requests;
}

test("ticket API uses the run, history, and steering contracts", async (t) => {
  const requests = captureFetch(t);

  await loadRuns("task/1");
  await loadLiveHistory("task/1");
  await steerRun("run/1", "input-1", "focus here");

  assert.deepEqual(requests.map((entry) => `${entry.options.method ?? "GET"} ${entry.url}`), [
    "GET /api/tasks/task%2F1/runs",
    "GET /api/tasks/task%2F1/live/history",
    "POST /api/runs/run%2F1/inputs",
  ]);
  assert.deepEqual(JSON.parse(requests[2].options.body), { input_id: "input-1", text: "focus here" });
});

test("Human Request API calls list, submit one answer batch, and stop by request ID", async (t) => {
  const requests = captureFetch(t);
  await loadHumanRequests("task/1");
  await answerHumanRequest("request/1", [{ id: "scope", value: "small" }]);
  await stopHumanRequest("request/1");

  assert.deepEqual(requests.map((entry) => `${entry.options.method ?? "GET"} ${entry.url}`), [
    "GET /api/tasks/task%2F1/human-requests",
    "POST /api/human-requests/request%2F1/answer",
    "POST /api/human-requests/request%2F1/stop",
  ]);
  assert.deepEqual(JSON.parse(requests[1].options.body), { answers: [{ id: "scope", value: "small" }] });
});

test("live event reconnect URL carries its sequence cursor", (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const previousLocation = globalThis.location;
  class FakeWebSocket {
    constructor(url) { this.url = url; }
    addEventListener() {}
  }
  globalThis.WebSocket = FakeWebSocket;
  globalThis.location = { protocol: "https:", host: "localhost:3000" };
  t.after(() => { globalThis.WebSocket = previousWebSocket; globalThis.location = previousLocation; });

  const socket = openRunEvents("task/1", "run/1", () => {}, 17);
  assert.equal(socket.url, "wss://localhost:3000/api/tasks/task%2F1/runs/run%2F1/events?after=17");
});

test("Review actions use checkpoint preview/confirmation contracts", async (t) => {
  const requests = captureFetch(t);
  await loadCheckpointPreview("task-1");
  await createCheckpoint("task-1", {
    tracked_changes: ["tracked.txt"], include_untracked_files: ["new file.txt"], branch: "agent/task-1",
    commit_sha: "a".repeat(40), state_token: "state-token",
  });
  await loadCheckpointDiff("task-1");
  assert.deepEqual(requests.map((entry) => `${entry.options.method ?? "GET"} ${entry.url}`), [
    "GET /api/tasks/task-1/checkpoint-preview",
    "POST /api/tasks/task-1/checkpoint",
    "GET /api/tasks/task-1/checkpoint-diff",
  ]);
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    tracked_changes: ["tracked.txt"], include_untracked_files: ["new file.txt"], branch: "agent/task-1",
    commit_sha: "a".repeat(40), state_token: "state-token",
  });
});

test("Sync with main uses its own explicit task API operation", async (t) => {
  const api = await import("../src/ticket-api.js");
  assert.equal(typeof api.syncTaskWithBase, "function", "Sync with main needs a dedicated API operation");
  const requests = captureFetch(t);
  await api.syncTaskWithBase("task/1");
  assert.deepEqual(requests.map((entry) => `${entry.options.method ?? "GET"} ${entry.url}`), [
    "POST /api/tasks/task%2F1/sync",
  ]);
});

test("merge approval carries the exact Check sync preview ID", async (t) => {
  const api = await import("../src/ticket-api.js");
  const requests = captureFetch(t);
  await api.loadMergePreview("task/1");
  await api.startMerge("task/1", "preview-1");
  assert.deepEqual(requests.map((entry) => `${entry.options.method ?? "GET"} ${entry.url}`), [
    "GET /api/tasks/task%2F1/merge-preview",
    "POST /api/tasks/task%2F1/merge",
  ]);
  assert.deepEqual(JSON.parse(requests[1].options.body), { confirmed: true, preview_id: "preview-1" });
});

test("Check sync is a read-only GET operation", async (t) => {
  const api = await import("../src/ticket-api.js");
  const requests = captureFetch(t);
  await api.checkTaskSync("task/1");
  assert.deepEqual(requests.map((entry) => `${entry.options.method ?? "GET"} ${entry.url}`), [
    "GET /api/tasks/task%2F1/check-sync",
  ]);
});

test("sync conflict recovery API inspects, opens, retries, and explicitly aborts the task sync", async (t) => {
  const api = await import("../src/ticket-api.js");
  const requests = captureFetch(t);
  await api.loadTaskSyncRecovery("task/1");
  await api.viewTaskSyncConflicts("task/1");
  await api.retryTaskSync("task/1");
  await api.abortTaskSync("task/1", true);
  assert.deepEqual(requests.map((entry) => `${entry.options.method ?? "GET"} ${entry.url}`), [
    "GET /api/tasks/task%2F1/sync-recovery",
    "POST /api/tasks/task%2F1/sync/view-conflicts",
    "POST /api/tasks/task%2F1/sync/retry",
    "POST /api/tasks/task%2F1/sync/abort",
  ]);
  assert.deepEqual(JSON.parse(requests[3].options.body), { confirmed: true });
});

test("backend rejections surface their reason to the panel", async (t) => {
  captureFetch(t, async () => new Response(JSON.stringify({
    error: "Run is no longer accepting inputs.",
  }), { status: 409 }));
  await assert.rejects(steerRun("run-1", "input-1", "nope"), /Run is no longer accepting inputs/);
});

test("unreachable backend explains how to start it", async (t) => {
  captureFetch(t, async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(loadRuns("task-1"), /Cannot reach the backend.*npm run dev:server/s);
});
