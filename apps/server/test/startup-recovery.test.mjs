import assert from "node:assert/strict";
import test from "node:test";
import { recoverBeforeDispatch } from "../dist/startup-recovery.js";

function deferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

test("startup recovery completes every persisted reconciliation before queue dispatch", async () => {
  const events = [];
  const inputGate = deferred();
  const recovery = recoverBeforeDispatch({
    async reconcileMerge() { events.push("merge"); },
    async reconcileRunInputs() { events.push("inputs:start"); await inputGate.promise; events.push("inputs:end"); },
    async reconcileHumanRequests() { events.push("human"); },
    initializeQueue() { events.push("queue"); },
  });

  await Promise.resolve();
  assert.deepEqual(events, ["merge", "inputs:start"], "queue dispatch must wait for run-input reconciliation");
  inputGate.release();
  await recovery;
  assert.deepEqual(events, ["merge", "inputs:start", "inputs:end", "human", "queue"]);
});

test("startup recovery does not dispatch the queue after a reconciliation failure", async () => {
  const events = [];
  await assert.rejects(() => recoverBeforeDispatch({
    async reconcileMerge() { events.push("merge"); },
    async reconcileRunInputs() { events.push("inputs"); throw new Error("recovery failed"); },
    async reconcileHumanRequests() { events.push("human"); },
    initializeQueue() { events.push("queue"); },
  }), /recovery failed/);
  assert.deepEqual(events, ["merge", "inputs"]);
});
