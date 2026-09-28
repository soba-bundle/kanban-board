import assert from "node:assert/strict";
import test from "node:test";
import { DIRECT_IMPLEMENTATION_WARNING, enqueueTask } from "../src/start-task-api.js";

test("start request requires a prompt, stage, and idempotency key", async () => {
  assert.match(DIRECT_IMPLEMENTATION_WARNING, /without an investigation run/);
  await assert.rejects(enqueueTask("task-1", "INVESTIGATION", "  ", "key"), /nonblank prompt/);
  await assert.rejects(enqueueTask("task-1", "INVESTIGATION", "prompt", ""), /idempotency key/);
  await assert.rejects(enqueueTask("task-1", "VALIDATION_REVIEW", "prompt", "key"), /Unsupported task start stage/);
});

test("start request can link an explicit reuse of unresolved guidance", async () => {
  let request;
  await enqueueTask("task-1", "INVESTIGATION", "same guidance", "reuse-key", async (_url, options) => {
    request = options;
    return new Response(JSON.stringify({ job_id: "job-1", run_id: "run-1", queue_position: 1, created: true }), { status: 201 });
  }, "input-original");
  assert.equal(JSON.parse(request.body).reused_from_input_id, "input-original");
});

test("start request posts the explicit prompt and stable request identity", async () => {
  let request;
  const result = await enqueueTask("task/1", "IMPLEMENTATION", "  Fix the retry race  ", "request-key-1", async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ job_id: "job-1", run_id: "run-1", queue_position: 1, created: true }), { status: 201 });
  });

  assert.equal(request.url, "/api/tasks/task%2F1/queue");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), {
    task_id: "task/1",
    stage: "IMPLEMENTATION",
    prompt: "Fix the retry race",
    idempotency_key: "request-key-1",
  });
  assert.equal(result.run_id, "run-1");
});
