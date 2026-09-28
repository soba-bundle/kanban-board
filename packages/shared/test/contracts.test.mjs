import assert from "node:assert/strict";
import test from "node:test";
import {
  BoardSnapshotSchema,
  CreateTaskSchema,
  CreateTicketCommentSchema,
  ImplementationHandoverSchema,
  InvestigationHandoverSchema,
  LiveEventSchema,
  LiveHistorySnapshotSchema,
  RunReasonCodeSchema,
  RunInputSchema,
  RunMessageSchema,
  StartRunSchema,
  TaskRunSummarySchema,
  TicketCommentSchema,
  handoverSchemaForStage,
  ProjectSchema,
  RunStatusSchema,
  TaskSchema,
  UpdateTaskSchema,
  WorkflowStateSchema,
} from "../dist/index.js";

const timestamp = "2025-01-01T00:00:00.000Z";

test("workflow enums accept declared values and reject unknown values", () => {
  assert.equal(WorkflowStateSchema.safeParse("IN_PROGRESS").success, true);
  assert.equal(WorkflowStateSchema.safeParse("ARCHIVED").success, false);
  assert.equal(RunStatusSchema.safeParse("WAITING_FOR_HUMAN").success, true);
  assert.equal(RunStatusSchema.safeParse("PAUSED").success, false);
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
  assert.equal(TaskSchema.safeParse({ ...task, workflow_state: "ARCHIVED" }).success, false);
  assert.equal(BoardSnapshotSchema.safeParse({ columns: {
    TODO: [task], IN_PROGRESS: [], REQUIRES_HUMAN: [], REVIEW: [], DONE: [],
  } }).success, true);
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

test("ticket comment schema validates delivery metadata", () => {
  const comment = {
    id: "c1",
    task_id: "t1",
    run_id: null,
    author_type: "USER",
    content: "Please check the retry path.",
    delivery_status: "PENDING",
    delivery_type: null,
    delivered_session_id: null,
    delivered_run_id: null,
    delivered_at: null,
    created_at: timestamp,
    updated_at: null,
  };
  assert.equal(TicketCommentSchema.safeParse(comment).success, true);
  assert.equal(TicketCommentSchema.safeParse({
    ...comment,
    delivery_status: "QUEUED",
    delivery_type: "STEERING",
  }).success, true);
  assert.equal(TicketCommentSchema.safeParse({ ...comment, delivery_status: "SENT" }).success, false);
  assert.equal(TicketCommentSchema.safeParse({ ...comment, delivery_type: "EMAIL" }).success, false);
  assert.equal(CreateTicketCommentSchema.safeParse({ content: " note " }).success, true);
  assert.equal(CreateTicketCommentSchema.safeParse({ content: "   " }).success, false);

  assert.equal(RunReasonCodeSchema.safeParse("HANDOVER_FAILED").success, true);
  assert.equal(RunReasonCodeSchema.safeParse("GAVE_UP").success, false);
});

test("Phase 6A run contracts require explicit prompts and stable input identities", () => {
  const start = {
    task_id: "t1",
    stage: "INVESTIGATION",
    prompt: "  Inspect the retry behavior  ",
    idempotency_key: "start-1",
  };
  assert.equal(StartRunSchema.safeParse(start).success, true);
  assert.equal(StartRunSchema.safeParse({ ...start, reused_from_input_id: "prior-input" }).success, true);
  assert.equal(StartRunSchema.safeParse({ ...start, reused_from_input_id: "  " }).success, false);
  assert.equal(StartRunSchema.safeParse({ ...start, prompt: "  " }).success, false);
  assert.equal(StartRunSchema.safeParse({ ...start, stage: "VALIDATION_REVIEW" }).success, false);
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
  };
  assert.equal(LiveHistorySnapshotSchema.safeParse(snapshot).success, true);
  assert.equal(LiveHistorySnapshotSchema.safeParse({ ...snapshot, cursor: -1 }).success, false);
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
