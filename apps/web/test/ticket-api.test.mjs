import assert from "node:assert/strict";
import test from "node:test";
import { createCheckpoint, loadCheckpointDiff, loadCheckpointPreview, loadLiveHistory, loadRuns, openRunEvents, steerRun } from "../src/ticket-api.js";

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
