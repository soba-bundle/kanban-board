import assert from "node:assert/strict";
import test from "node:test";

let buildValidationContext;
let importError;
try {
  ({ buildValidationContext } = await import("../dist/agents/validation-context.js"));
} catch (error) {
  importError = error;
}

function build(input) {
  assert.equal(typeof buildValidationContext, "function",
    `Expected a pinned validation-context builder; ${importError?.message ?? "export is missing"}`);
  return buildValidationContext(input);
}

const taskSha = "b".repeat(40);
const baseSha = "a".repeat(40);

function fixture(overrides = {}) {
  return {
    task: { id: "task-1", title: "Do not disclose title", description: "Reviewer task description." },
    checkpoint: { sha: taskSha, producing_run_id: "impl-2" },
    base: { sha: baseSha },
    handovers: [
      { run_id: "impl-1", stage: "IMPLEMENTATION", sequence: 4, status: "COMPLETED",
        handover: { summary: "First implementation handover" } },
      { run_id: "impl-2", stage: "IMPLEMENTATION", sequence: 5, status: "COMPLETED",
        handover: { summary: "Checkpoint-producing handover" } },
      { run_id: "impl-3", stage: "IMPLEMENTATION", sequence: 6, status: "COMPLETED",
        handover: { summary: "Later run handover" } },
      { run_id: "investigation-1", stage: "INVESTIGATION", sequence: 2, status: "COMPLETED",
        handover: { summary: "Investigation handover" } },
    ],
    guidance_watermark: 3,
    guidance: [
      { id: "input-1", sequence: 1, content: "Confirmed delivered guidance", delivery_status: "DELIVERED" },
      { id: "input-2", sequence: 2, content: "Pending guidance", delivery_status: "PENDING" },
      { id: "input-3", sequence: 3, content: "Delivery unknown guidance", delivery_status: "DELIVERY_UNKNOWN" },
      { id: "input-4", sequence: 4, content: "Later delivered guidance", delivery_status: "DELIVERED" },
      { id: "input-5", sequence: 2, content: "Cancelled guidance", delivery_status: "CANCELLED" },
    ],
    changed_files: ["src/change.ts"],
    diff: "diff --git a/src/change.ts b/src/change.ts\n+implementation",
    repository_context: "Project repository summary.",
    assistant_transcript: "PRIVATE FULL ASSISTANT TRANSCRIPT",
    ...overrides,
  };
}

test("validation context uses description, checkpoint-bounded Implementation handovers, and delivered guidance only", () => {
  const context = build(fixture());
  const serialized = JSON.stringify(context);
  assert.equal(context.task_description, "Reviewer task description.");
  assert.equal(context.task_title, undefined);
  assert.deepEqual(context.implementation_handovers.map((item) => item.summary), [
    "First implementation handover", "Checkpoint-producing handover",
  ]);
  assert.deepEqual(context.confirmed_guidance.map((item) => item.content), ["Confirmed delivered guidance"]);
  assert.equal(context.guidance_watermark, 3);
  assert.equal(context.base_commit_sha, baseSha);
  assert.equal(context.candidate_commit_sha, taskSha);
  assert.deepEqual(context.changed_files, ["src/change.ts"]);
  assert.match(context.diff, /implementation/);
  assert.match(serialized, /Project repository summary/);
  assert.doesNotMatch(serialized, /Do not disclose title|PRIVATE FULL ASSISTANT TRANSCRIPT/);
  assert.doesNotMatch(serialized, /Pending guidance|Delivery unknown guidance|Later delivered guidance|Cancelled guidance|Later run handover|Investigation handover/);
});

test("validation context refuses a checkpoint without its completed Implementation handover", () => {
  assert.equal(typeof buildValidationContext, "function",
    `Expected a pinned validation-context builder; ${importError?.message ?? "export is missing"}`);
  assert.throws(() => buildValidationContext(fixture({
    handovers: fixture().handovers.filter((item) => item.run_id !== "impl-2"),
  })), /completed Implementation handover.*checkpoint/i);
});

test("guidance delivered after the captured watermark cannot enter an existing context", () => {
  const input = fixture();
  const context = build(input);
  input.guidance[0].content = "Changed after context capture";
  input.guidance.push({ id: "input-6", sequence: 5, content: "Newly delivered guidance", delivery_status: "DELIVERED" });
  assert.doesNotMatch(JSON.stringify(context), /Changed after context capture|Newly delivered guidance/);
});
