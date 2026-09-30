import assert from "node:assert/strict";
import test from "node:test";

let createStageToolPolicy;
let importError;
try {
  ({ createStageToolPolicy } = await import("../dist/pi/stage-tool-policy.js"));
} catch (error) {
  importError = error;
}

function policyFor(stage) {
  assert.equal(typeof createStageToolPolicy, "function",
    `Expected a Kanban-owned stage tool policy; ${importError?.message ?? "export is missing"}`);
  return createStageToolPolicy(typeof stage === "function" ? stage : () => stage);
}

test("Investigation and Validation filter write/edit and report direct-call policy blocks", () => {
  for (const stage of ["INVESTIGATION", "VALIDATION_REVIEW"]) {
    const policy = policyFor(stage);
    assert.deepEqual(policy.filterActiveTools(["read", "write", "edit", "bash", "grep"]),
      ["read", "bash", "grep"], `${stage} must not advertise source-writing tools`);
    for (const name of ["write", "edit"]) {
      assert.equal(policy.blockToolCall(name)?.blocked, true,
        `${stage} must classify a model-issued ${name} call as blocked`);
    }
  }
});

test("Implementation remains writable and unrelated tools are unaffected", () => {
  const policy = policyFor("IMPLEMENTATION");
  const tools = ["read", "write", "edit", "bash", "grep"];
  assert.deepEqual(policy.filterActiveTools(tools), tools);
  assert.equal(policy.blockToolCall("write"), undefined);
  assert.equal(policy.blockToolCall("edit"), undefined);
  assert.equal(policy.blockToolCall("bash"), undefined);
});

test("Validation cannot issue Human Requests while Investigation keeps its existing questionnaire tool", () => {
  const validation = policyFor("VALIDATION_REVIEW");
  assert.deepEqual(validation.filterActiveTools(["read", "kanban_questionnaire"]), ["read"]);
  assert.equal(validation.blockToolCall("kanban_questionnaire")?.blocked, true);
  const investigation = policyFor("INVESTIGATION");
  assert.deepEqual(investigation.filterActiveTools(["read", "kanban_questionnaire"]), ["read", "kanban_questionnaire"]);
  assert.equal(investigation.blockToolCall("kanban_questionnaire"), undefined);
});

test("stage policy reads the current run stage instead of leaking across reused sessions", () => {
  let stage = "INVESTIGATION";
  const policy = policyFor(() => stage);
  assert.deepEqual(policy.filterActiveTools(["read", "write", "edit"]), ["read"]);
  stage = "IMPLEMENTATION";
  assert.deepEqual(policy.filterActiveTools(["read", "write", "edit"]), ["read", "write", "edit"]);
  stage = "VALIDATION_REVIEW";
  assert.deepEqual(policy.filterActiveTools(["read", "write", "edit"]), ["read"]);
});
