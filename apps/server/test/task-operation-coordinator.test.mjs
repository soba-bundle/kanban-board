import assert from "node:assert/strict";
import test from "node:test";
import { TaskOperationCoordinator } from "../dist/task-operation-coordinator.js";

test("task operation leases reject same-task conflicts but allow independent tasks", () => {
  const coordinator = new TaskOperationCoordinator();
  const releaseCheckpoint = coordinator.tryAcquire("task-1");
  assert.equal(typeof releaseCheckpoint, "function");
  assert.equal(coordinator.tryAcquire("task-1"), null);
  const releaseOtherTask = coordinator.tryAcquire("task-2");
  assert.equal(typeof releaseOtherTask, "function");

  releaseCheckpoint();
  const releaseStart = coordinator.tryAcquire("task-1");
  assert.equal(typeof releaseStart, "function");
  releaseStart();
  releaseOtherTask();
});
