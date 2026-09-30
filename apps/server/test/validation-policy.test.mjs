import assert from "node:assert/strict";
import test from "node:test";

let evaluateValidationEligibility;
let importError;
try {
  ({ evaluateValidationEligibility } = await import("../dist/agents/validation-policy.js"));
} catch (error) {
  importError = error;
}

const candidateSha = "c".repeat(40);
const baseSha = "b".repeat(40);

function evaluate(overrides = {}) {
  assert.equal(typeof evaluateValidationEligibility, "function",
    `Expected a validation eligibility policy; ${importError?.message ?? "export is missing"}`);
  return evaluateValidationEligibility({
    task: {
      workflow_state: "REVIEW", review_tag: "IMPLEMENTATION_COMPLETE",
      latest_task_commit_sha: candidateSha, base_commit_sha: baseSha,
    },
    worktree: { head_sha: candidateSha, dirty: false },
    queue: { has_active_work: false },
    operation_locked: false,
    previous_validation: null,
    ...overrides,
  });
}

test("validation is eligible only for a clean Implementation Complete checkpoint in Review", () => {
  assert.equal(evaluate().eligible, true);
  for (const task of [
    { workflow_state: "TODO", review_tag: null, latest_task_commit_sha: candidateSha, base_commit_sha: baseSha },
    { workflow_state: "REVIEW", review_tag: "INVESTIGATION_COMPLETE", latest_task_commit_sha: candidateSha, base_commit_sha: baseSha },
    { workflow_state: "IN_PROGRESS", review_tag: "IMPLEMENTATION_COMPLETE", latest_task_commit_sha: candidateSha, base_commit_sha: baseSha },
  ]) assert.equal(evaluate({ task }).eligible, false);
  assert.equal(evaluate({ task: { ...evaluateTask(), latest_task_commit_sha: null } }).eligible, false);
});

function evaluateTask() {
  return { workflow_state: "REVIEW", review_tag: "IMPLEMENTATION_COMPLETE",
    latest_task_commit_sha: candidateSha, base_commit_sha: baseSha };
}

test("validation requires a clean task worktree exactly at the saved checkpoint", () => {
  assert.equal(evaluate({ worktree: { head_sha: candidateSha, dirty: true } }).eligible, false);
  assert.equal(evaluate({ worktree: { head_sha: "d".repeat(40), dirty: false } }).eligible, false);
});

test("active queue work, duplicate validation, and conflicting task operations block start", () => {
  assert.equal(evaluate({ queue: { has_active_work: true } }).eligible, false);
  assert.equal(evaluate({ operation_locked: true }).eligible, false);
  assert.equal(evaluate({ queue: { has_active_work: false, validation_already_queued_or_running: true } }).eligible, false);
});

test("Validation Failed can retry the same candidate; Validation Issues requires a new checkpoint", () => {
  assert.equal(evaluate({
    task: { ...evaluateTask(), review_tag: "VALIDATION_FAILED" },
    previous_validation: { result: "VALIDATION_FAILED", candidate_sha: candidateSha },
  }).eligible, true);
  assert.equal(evaluate({
    task: { ...evaluateTask(), review_tag: "VALIDATION_ISSUES" },
    previous_validation: { result: "ISSUES_FOUND", candidate_sha: candidateSha, had_direct_findings: true },
  }).eligible, false);
  assert.equal(evaluate({
    task: { ...evaluateTask(), review_tag: "VALIDATION_ISSUES", latest_task_commit_sha: "e".repeat(40) },
    worktree: { head_sha: "e".repeat(40), dirty: false },
    previous_validation: { result: "ISSUES_FOUND", candidate_sha: candidateSha, had_direct_findings: true },
  }).eligible, true);
  assert.equal(evaluate({
    task: { ...evaluateTask(), review_tag: "VALIDATION_FAILED" },
    previous_validation: { result: "VALIDATION_FAILED", candidate_sha: "d".repeat(40) },
  }).eligible, false);
});
