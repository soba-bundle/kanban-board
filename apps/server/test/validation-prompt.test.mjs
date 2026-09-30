import assert from "node:assert/strict";
import test from "node:test";

let buildValidationPrompt;
let importError;
try {
  ({ buildValidationPrompt } = await import("../dist/agents/validation-prompt.js"));
} catch (error) {
  importError = error;
}

test("Validation prompt requires read-only review, evidence-based attribution, and no Human Requests", () => {
  assert.equal(typeof buildValidationPrompt, "function",
    `Expected a dedicated Validation Review prompt; ${importError?.message ?? "export is missing"}`);
  const prompt = buildValidationPrompt({
    task_description: "Review this described task.",
    base_commit_sha: "a".repeat(40),
    candidate_commit_sha: "b".repeat(40),
    diff: "+change",
    implementation_handovers: [{ summary: "Implemented the change." }],
    confirmed_guidance: [{ content: "Keep the public API stable." }],
  });
  assert.match(prompt, /do not (modify|change|write) source code/i);
  assert.match(prompt, /evidence/i);
  assert.match(prompt, /direct|indirect|uncertain/i);
  assert.match(prompt, /missing information|uncertainty/i);
  assert.doesNotMatch(prompt, /human request|ask the user|questionnaire/i);
});
