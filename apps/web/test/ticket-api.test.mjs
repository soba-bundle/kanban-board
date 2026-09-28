import assert from "node:assert/strict";
import test from "node:test";
import { addComment, createCheckpoint, deleteComment, editComment, loadCheckpointDiff, loadCheckpointPreview, loadComments, loadLiveHistory, loadRuns, openRunEvents, steerRun } from "../src/ticket-api.js";

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

test("ticket API uses the comment, run, and steering contracts", async (t) => {
  const requests = captureFetch(t, async (_url, options) =>
    options.method === "DELETE"
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ id: "c1" }), { status: 200 }));

  await loadComments("task/1");
  await loadRuns("task/1");
  await loadLiveHistory("task/1");
  await addComment("task/1", "hello");
  await editComment("c/1", "edited");
  await deleteComment("c/1");
  await steerRun("run/1", "input-1", "focus here");

  assert.deepEqual(requests.map((entry) => `${entry.options.method ?? "GET"} ${entry.url}`), [
    "GET /api/tasks/task%2F1/comments",
    "GET /api/tasks/task%2F1/runs",
    "GET /api/tasks/task%2F1/live/history",
    "POST /api/tasks/task%2F1/comments",
    "PATCH /api/comments/c%2F1",
    "DELETE /api/comments/c%2F1",
    "POST /api/runs/run%2F1/inputs",
  ]);
  assert.deepEqual(JSON.parse(requests[3].options.body), { content: "hello" });
  assert.deepEqual(JSON.parse(requests[4].options.body), { content: "edited" });
  assert.deepEqual(JSON.parse(requests[6].options.body), { input_id: "input-1", text: "focus here" });
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
    error: "Comments already sent to the agent are immutable.",
  }), { status: 409 }));
  await assert.rejects(editComment("c1", "nope"), /already sent to the agent are immutable/);
});

test("unreachable backend explains how to start it", async (t) => {
  captureFetch(t, async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(loadComments("task-1"), /Cannot reach the backend.*npm run dev:server/s);
});
