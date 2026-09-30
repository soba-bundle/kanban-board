import assert from "node:assert/strict";
import test from "node:test";
import * as ticketApi from "../src/ticket-api.js";

function captureFetch(t, handler = async () => new Response(JSON.stringify({ run_id: "run-1", status: "QUEUED" }), {
  status: 202, headers: { "content-type": "application/json" },
})) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return handler(url, options);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return requests;
}

test("validation API starts an explicit task-scoped run", async (t) => {
  assert.equal(typeof ticketApi.startValidation, "function",
    "Ticket API must expose the explicit Phase 8 validation action");
  const requests = captureFetch(t);
  const result = await ticketApi.startValidation("task/1");
  assert.deepEqual(result, { run_id: "run-1", status: "QUEUED" });
  assert.equal(requests[0].url, "/api/tasks/task%2F1/validation");
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].options.body), {});
});

test("validation API surfaces an ineligible/conflicting task rejection", async (t) => {
  assert.equal(typeof ticketApi.startValidation, "function",
    "Ticket API must expose the explicit Phase 8 validation action");
  captureFetch(t, async () => new Response(JSON.stringify({ error: "Task worktree has uncommitted changes." }), {
    status: 409, headers: { "content-type": "application/json" },
  }));
  await assert.rejects(ticketApi.startValidation("task-1"), /uncommitted changes/i);
});
