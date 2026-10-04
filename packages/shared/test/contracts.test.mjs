import assert from "node:assert/strict";
import test from "node:test";
import {
  BoardSnapshotSchema,
  CheckpointPreviewSchema,
  CreateTaskSchema,
  HumanRequestAnswerBatchSchema,
  HumanRequestAnswerInputSchema,
  HumanRequestAnswerSchema,
  HumanRequestQuestionSchema,
  HumanRequestQuestionsSchema,
  HumanRequestSchema,
  HumanRequestStatusSchema,
  ImplementationHandoverSchema,
  InvestigationHandoverSchema,
  LiveEventSchema,
  LiveHistorySnapshotSchema,
  RunReasonCodeSchema,
  RunInputSchema,
  RunMessageSchema,
  StartRunSchema,
  TaskRunSummarySchema,
  handoverSchemaForStage,
  ProjectSchema,
  ReviewTagSchema,
  RunStatusSchema,
  TaskSchema,
  UpdateTaskSchema,
  WorkflowStateSchema,
  ValidationAttributionSchema,
  ValidationFindingSchema,
  ValidationReportSchema,
  ValidationResultSchema,
  WorkingPhaseSchema,
} from "../dist/index.js";

const timestamp = "2025-01-01T00:00:00.000Z";

test("workflow enums accept declared values and reject unknown values", () => {
  assert.equal(WorkflowStateSchema.safeParse("IN_PROGRESS").success, true);
  assert.equal(WorkflowStateSchema.safeParse("ARCHIVED").success, false);
  assert.equal(RunStatusSchema.safeParse("WAITING_FOR_HUMAN").success, true);
  assert.equal(RunStatusSchema.safeParse("PAUSED").success, false);
});

test("checkpoint preview contract includes the unified current diff", () => {
  const preview = {
    tracked_changes: ["src/retry.ts"], untracked_files: ["test/retry.test.ts"], branch: "agent/task-t1",
    commit_sha: "a".repeat(40), state_token: "state", diff: "diff --git a/src/retry.ts b/src/retry.ts",
  };
  assert.deepEqual(CheckpointPreviewSchema.parse(preview), preview);
});

test("Validation contracts require evidence, locations, and unambiguous finding attribution", () => {
  const finding = {
    id: "finding-1", attribution: "DIRECT", summary: "Parser rejects valid input",
    rationale: "The changed parser path introduces the rejection.", evidence: "The supplied reproduction fails.",
    locations: [{ file: "src/parser.ts", line: 12 }],
  };
  assert.equal(ValidationAttributionSchema.safeParse("UNCERTAIN").success, true);
  assert.equal(ValidationAttributionSchema.safeParse("POSSIBLE").success, false);
  assert.equal(ValidationFindingSchema.safeParse(finding).success, true);
  assert.equal(ValidationFindingSchema.safeParse({ ...finding, evidence: "" }).success, false);
  assert.equal(ValidationFindingSchema.safeParse({ ...finding, locations: [] }).success, false);
  assert.equal(ValidationFindingSchema.safeParse({ ...finding, locations: [{ file: "src/parser.ts" }] }).success, false);
  assert.equal(ValidationReportSchema.safeParse({ findings: [finding] }).success, true);
  assert.equal(ValidationReportSchema.safeParse({ findings: [finding, finding] }).success, false);
  assert.equal(ValidationReportSchema.safeParse({ findings: [{ attribution: "DIRECT" }] }).success, false);
  assert.deepEqual(ValidationResultSchema.options, ["PASSED", "ISSUES_FOUND", "VALIDATION_FAILED", "STALE"]);
});

test("Human Request contracts validate multi-question prompts and normalized answer batches", () => {
  const questions = [
    {
      id: "scope", label: "Scope", prompt: "Which scope?",
      options: [{ value: "small", label: "Small" }, { value: "large", label: "Large" }], allowOther: true,
    },
    { id: "risk", label: "Risk", prompt: "What risk is acceptable?", options: [], allowOther: true },
  ];
  assert.equal(HumanRequestQuestionsSchema.safeParse(questions).success, true);
  assert.equal(HumanRequestQuestionsSchema.safeParse([questions[0], questions[0]]).success, false);
  assert.equal(HumanRequestQuestionSchema.safeParse({ ...questions[1], allowOther: false }).success, false);
  assert.equal(HumanRequestAnswerInputSchema.safeParse({ id: "scope", value: "large" }).success, true);
  assert.equal(HumanRequestAnswerBatchSchema.safeParse({ answers: [
    { id: "scope", value: "large" }, { id: "risk", value: "A controlled rollout" },
  ] }).success, true);
  assert.equal(HumanRequestAnswerSchema.safeParse({
    id: "scope", value: "large", label: "Large", wasCustom: false, index: 2,
  }).success, true);
  assert.equal(HumanRequestAnswerSchema.safeParse({
    id: "risk", value: "A controlled rollout", label: "A controlled rollout", wasCustom: true,
  }).success, true);
  assert.equal(HumanRequestStatusSchema.safeParse("CANCELLED").success, true);
  assert.equal(HumanRequestStatusSchema.safeParse("WAITING").success, false);
  assert.equal(HumanRequestSchema.safeParse({
    id: "request-1", task_id: "t1", run_id: "r1", session_id: "s1", tool_call_id: "call-1",
    status: "PENDING", created_at: timestamp, answered_at: null, questions, answers: null,
  }).success, true);
});

test("project schema validates required project fields", () => {
  const project = {
    id: "p1",
    name: "Demo",
    root_path: "C:/repos/demo",
    ide_command: null,
    worktree_root: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  assert.equal(ProjectSchema.safeParse(project).success, true);
  assert.equal(ProjectSchema.safeParse({ ...project, root_path: "" }).success, false);
});

test("task create and update schemas validate task fields", () => {
  assert.equal(CreateTaskSchema.safeParse({ project_id: "p1", title: " New task ", description: " Useful context " }).success, true);
  assert.equal(CreateTaskSchema.safeParse({ project_id: "p1", title: "  ", description: "Details" }).success, false);
  assert.equal(CreateTaskSchema.safeParse({ project_id: "p1", title: "Task", description: "  " }).success, false);
  assert.equal(UpdateTaskSchema.safeParse({ title: "Renamed" }).success, true);
  assert.equal(UpdateTaskSchema.safeParse({}).success, false);
});

test("task schema validates workflow state and required fields", () => {
  const task = {
    id: "t1",
    project_id: "p1",
    title: "Example task",
    description: "Details",
    workflow_state: "TODO",
    review_tag: null,
    latest_task_commit_sha: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  assert.equal(TaskSchema.safeParse(task).success, true);
  const currentTask = TaskSchema.parse({ ...task, active_validation_snapshot_id: "legacy", validation_snapshot_current: true });
  assert.equal("active_validation_snapshot_id" in currentTask, false);
  assert.equal("validation_snapshot_current" in currentTask, false);
  assert.equal(TaskSchema.safeParse({ ...task, workflow_state: "ARCHIVED" }).success, false);
  assert.equal(BoardSnapshotSchema.safeParse({ columns: {
    TODO: [task], IN_PROGRESS: [], REQUIRES_HUMAN: [], REVIEW: [], DONE: [],
  } }).success, true);
});

test("unified work values are additive to legacy run stages and review tags", () => {
  assert.equal(WorkingPhaseSchema.safeParse("WORK").success, true);
  for (const stage of ["INVESTIGATION", "IMPLEMENTATION", "VALIDATION_REVIEW"]) {
    assert.equal(WorkingPhaseSchema.safeParse(stage).success, true, `legacy stage ${stage} remains readable`);
  }
  assert.equal(ReviewTagSchema.safeParse("WORK_COMPLETE").success, true);
  for (const tag of ["INVESTIGATION_COMPLETE", "IMPLEMENTATION_COMPLETE", "VALIDATION_ISSUES",
    "VALIDATION_FAILED", "READY_TO_MERGE"]) {
    assert.equal(ReviewTagSchema.safeParse(tag).success, true, `legacy review tag ${tag} remains readable`);
  }
});

test("run summary rejects unknown reason codes", () => {
  const run = {
    id: "r1",
    stage: "INVESTIGATION",
    sequence: 1,
    status: "FAILED",
    reason_code: "HANDOVER_FAILED",
    error_message: "Missing handover",
    started_at: timestamp,
    completed_at: timestamp,
    handover: null,
  };
  assert.equal(TaskRunSummarySchema.safeParse(run).success, true);
  assert.equal(TaskRunSummarySchema.safeParse({ ...run, reason_code: "TYPO" }).success, false);
  assert.equal(TaskRunSummarySchema.safeParse({ ...run, reason_code: null }).success, true);
});

test("run reason codes reject unknown values", () => {
  assert.equal(RunReasonCodeSchema.safeParse("HANDOVER_FAILED").success, true);
  assert.equal(RunReasonCodeSchema.safeParse("GAVE_UP").success, false);
});

test("Phase 6A run contracts require explicit prompts and stable input identities", () => {
  const start = {
    task_id: "t1",
    prompt: "  Inspect the retry behavior  ",
    idempotency_key: "start-1",
  };
  assert.equal(StartRunSchema.safeParse(start).success, true);
  assert.equal(StartRunSchema.safeParse({ ...start, reused_from_input_id: "prior-input" }).success, true);
  assert.equal(StartRunSchema.safeParse({ ...start, reused_from_input_id: "  " }).success, false);
  assert.equal(StartRunSchema.safeParse({ ...start, prompt: "  " }).success, false);
  assert.equal(StartRunSchema.safeParse({ ...start, stage: "IMPLEMENTATION" }).success, false);
  assert.equal(StartRunSchema.safeParse({ ...start, idempotency_key: "" }).success, false);

  assert.equal(RunMessageSchema.safeParse({ input_id: "input-1", text: " Check edge cases " }).success, true);
  assert.equal(RunMessageSchema.safeParse({ input_id: "input-1", text: "  " }).success, false);
  assert.equal(RunMessageSchema.safeParse({ input_id: "", text: "valid" }).success, false);
  assert.equal(RunMessageSchema.safeParse({
    input_id: "input-2", text: "Reuse guidance", reused_from_input_id: "input-1",
  }).success, true);

  const input = {
    id: "input-1", task_id: "t1", run_id: "r1", sequence: 1, idempotency_key: "start-1",
    content: "Inspect the retry behavior", delivery_type: "INITIAL_PROMPT", delivery_status: "PENDING",
    accepted_at: timestamp, delivered_at: null, session_id: null, session_sequence: null,
    transcript_boundary_entry_id: null, transcript_entry_id: null,
    failure_reason: null, reused_from_input_id: null,
  };
  assert.equal(RunInputSchema.safeParse(input).success, true);
  assert.equal(RunInputSchema.safeParse({ ...input, delivery_status: "SENT" }).success, false);
  assert.equal(RunInputSchema.safeParse({ ...input, delivery_type: "COMMENT" }).success, false);
});

test("Live history contracts carry stable transcript identities and sequenced cursors", () => {
  const event = {
    eventId: "run-1:4", sequence: 4, taskId: "t1", runId: "r1", type: "message_update",
    timestamp, data: { delta: "text" },
  };
  assert.equal(LiveEventSchema.safeParse(event).success, true);
  assert.equal(LiveEventSchema.safeParse({ ...event, sequence: 0 }).success, false);
  const snapshot = {
    task_id: "t1", session_id: "s1", active_run_id: "r1", cursor: 4, provisional_truncated: false,
    entries: [{
      id: "s1:e1", entry_id: "e1", session_id: "s1", run_id: "r1", timestamp, role: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    }],
    inputs: [], provisional_events: [event],
    compaction_summaries: [{ id: "s1:c1", timestamp, summary: "Keep the native reserve setting.", tokens_before: 4704, after_entry_id: "s1:e1" }],
  };
  assert.equal(LiveHistorySnapshotSchema.safeParse(snapshot).success, true);
  assert.equal(LiveHistorySnapshotSchema.safeParse({ ...snapshot, cursor: -1 }).success, false);
  assert.equal(LiveHistorySnapshotSchema.safeParse({ ...snapshot, compaction_summaries: [{ ...snapshot.compaction_summaries[0], tokens_before: -1 }] }).success, false);
});

test("handover schemas enforce stage-specific contracts and default lists", () => {
  const investigation = InvestigationHandoverSchema.safeParse({
    stage: "INVESTIGATION",
    summary: "Root cause found",
    confidence: "HIGH",
    outcome: "Retry loop drops the abort signal",
    recommended_next_step: "IMPLEMENT",
  });
  assert.equal(investigation.success, true);
  assert.deepEqual(investigation.data.evidence, []);
  assert.equal(investigation.data.root_cause, null);
  assert.equal(investigation.data.human_verification_required, false);

  assert.equal(InvestigationHandoverSchema.safeParse({
    stage: "INVESTIGATION",
    summary: "No confidence field",
    outcome: "x",
    recommended_next_step: "IMPLEMENT",
  }).success, false);

  const implementation = ImplementationHandoverSchema.safeParse({
    stage: "IMPLEMENTATION",
    summary: "Fixed the abort propagation",
    files_changed: ["src/run.ts"],
    recommended_next_step: "CLOSE",
  });
  assert.equal(implementation.success, true);
  assert.deepEqual(implementation.data.key_decisions, []);

  // An implementation payload must not satisfy the investigation contract.
  assert.equal(InvestigationHandoverSchema.safeParse({
    stage: "IMPLEMENTATION",
    summary: "Wrong stage",
    recommended_next_step: "CLOSE",
  }).success, false);
  assert.equal(handoverSchemaForStage.INVESTIGATION, InvestigationHandoverSchema);
  assert.equal(handoverSchemaForStage.IMPLEMENTATION, ImplementationHandoverSchema);
});
