import assert from "node:assert/strict";
import test from "node:test";
import { chooseStartAction, DIRECT_IMPLEMENTATION_WARNING, enqueueTask } from "../src/start-task-api.js";

test("Investigation queues immediately but direct Implementation requires explicit confirmation", () => {
  assert.deepEqual(chooseStartAction("INVESTIGATION"), { type: "enqueue", stage: "INVESTIGATION" });
  assert.deepEqual(chooseStartAction("IMPLEMENTATION"), {
    type: "confirm",
    title: "Skip investigation?",
    warning: DIRECT_IMPLEMENTATION_WARNING,
  });
  assert.deepEqual(chooseStartAction("IMPLEMENTATION", true), { type: "enqueue", stage: "IMPLEMENTATION" });
});

test("queue request posts the selected stage and returns queue identifiers", async () => {
  let request;
  const result = await enqueueTask("task/1", "IMPLEMENTATION", async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ job_id: "job-1", run_id: "run-1", queue_position: 1 }), { status: 201 });
  });

  assert.equal(request.url, "/api/tasks/task%2F1/queue");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), { stage: "IMPLEMENTATION" });
  assert.equal(result.run_id, "run-1");
});
