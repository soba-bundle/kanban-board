import assert from "node:assert/strict";
import test from "node:test";
import { enqueueTask } from "../src/start-task-api.js";

test("prompt-only start requires a nonblank prompt and stable idempotency key", async () => {
  await assert.rejects(enqueueTask("task-1", "  ", "key"), /nonblank prompt/);
  await assert.rejects(enqueueTask("task-1", "prompt", ""), /idempotency key/);
});

test("prompt-only start request posts no stage and preserves stable request identity", async () => {
  let request;
  const result = await enqueueTask("task/1", "  Fix the retry race  ", "request-key-1", async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ job_id: "job-1", run_id: "run-1", queue_position: 1, created: true }), { status: 201 });
  });

  assert.equal(request.url, "/api/tasks/task%2F1/queue");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), {
    task_id: "task/1", prompt: "Fix the retry race", idempotency_key: "request-key-1",
  });
  assert.equal(result.run_id, "run-1");
});

test("prompt-only start can link explicit reuse of unresolved guidance", async () => {
  let request;
  await enqueueTask("task-1", "same guidance", "reuse-key", async (_url, options) => {
    request = options;
    return new Response(JSON.stringify({ job_id: "job-1", run_id: "run-1", queue_position: 1, created: true }), { status: 201 });
  }, "input-original");
  assert.equal(JSON.parse(request.body).reused_from_input_id, "input-original");
  assert.equal("stage" in JSON.parse(request.body), false);
});
