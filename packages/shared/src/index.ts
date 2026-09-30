import { z } from "zod";
import { LiveEventSchema } from "./live-events.js";
import { ValidationFindingSchema, ValidationResultSchema } from "./validation.js";
export {
  ValidationAttributionSchema,
  ValidationFindingLocationSchema,
  ValidationFindingSchema,
  ValidationReportSchema,
  ValidationResultSchema,
} from "./validation.js";
export type { ValidationAttribution, ValidationFinding, ValidationReport, ValidationResult } from "./validation.js";
export { LiveEventSchema } from "./live-events.js";
export type { LiveEvent } from "./live-events.js";
export {
  HandoverConfidenceSchema,
  HandoverSchema,
  ImplementationHandoverSchema,
  InvestigationHandoverSchema,
  RecommendedNextStepSchema,
  handoverSchemaForStage,
} from "./handover.js";
export type {
  Handover,
  ImplementationHandover,
  InvestigationHandover,
  RecommendedNextStep,
} from "./handover.js";

export const WorkflowStateSchema = z.enum([
  "TODO",
  "IN_PROGRESS",
  "REQUIRES_HUMAN",
  "REVIEW",
  "DONE",
]);
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export const WorkingPhaseSchema = z.enum([
  "INVESTIGATION",
  "IMPLEMENTATION",
  "VALIDATION_REVIEW",
]);
export type WorkingPhase = z.infer<typeof WorkingPhaseSchema>;

export const RunStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "WAITING_FOR_HUMAN",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "CANCELLED",
  "WAITING_FOR_INFERENCE",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const HumanRequestStatusSchema = z.enum(["PENDING", "ANSWERED", "CANCELLED"]);
export type HumanRequestStatus = z.infer<typeof HumanRequestStatusSchema>;
export const HumanRequestQuestionOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});
export const HumanRequestQuestionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  prompt: z.string().min(1),
  options: z.array(HumanRequestQuestionOptionSchema),
  allowOther: z.boolean(),
}).refine((question) => question.options.length > 0 || question.allowOther, {
  message: "A question must provide an option or allow a custom answer.",
});
export const HumanRequestQuestionsSchema = z.array(HumanRequestQuestionSchema).min(1)
  .superRefine((questions, context) => {
    const ids = new Set<string>();
    questions.forEach((question, index) => {
      if (ids.has(question.id)) {
        context.addIssue({ code: "custom", path: [index, "id"], message: "Question IDs must be unique." });
      }
      ids.add(question.id);
    });
  });
export const HumanRequestAnswerInputSchema = z.object({
  id: z.string().min(1),
  value: z.string().min(1),
});
export const HumanRequestAnswerBatchSchema = z.object({
  answers: z.array(HumanRequestAnswerInputSchema).min(1),
});
export const HumanRequestAnswerSchema = z.object({
  id: z.string().min(1),
  value: z.string().min(1),
  label: z.string().min(1),
  wasCustom: z.boolean(),
  index: z.number().int().positive().optional(),
});
export const HumanRequestSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().min(1),
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  tool_call_id: z.string().min(1),
  status: HumanRequestStatusSchema,
  created_at: z.string().datetime(),
  answered_at: z.string().datetime().nullable(),
  questions: HumanRequestQuestionsSchema,
  answers: z.array(HumanRequestAnswerSchema).nullable(),
});
export type HumanRequestQuestionOption = z.infer<typeof HumanRequestQuestionOptionSchema>;
export type HumanRequestQuestion = z.infer<typeof HumanRequestQuestionSchema>;
export type HumanRequestAnswerInput = z.infer<typeof HumanRequestAnswerInputSchema>;
export type HumanRequestAnswerBatch = z.infer<typeof HumanRequestAnswerBatchSchema>;
export type HumanRequestAnswer = z.infer<typeof HumanRequestAnswerSchema>;
export type HumanRequest = z.infer<typeof HumanRequestSchema>;

export const AgentJobStatusSchema = z.enum(["QUEUED", "CLAIMED", "WAITING_FOR_HUMAN", "FINISHED", "CANCELLED"]);
export type AgentJobStatus = z.infer<typeof AgentJobStatusSchema>;

export const RunReasonCodeSchema = z.enum([
  "USER_STOPPED",
  "BACKEND_INTERRUPTED",
  "HANDOVER_FAILED",
  "INPUT_DELIVERY_FAILED",
]);
export type RunReasonCode = z.infer<typeof RunReasonCodeSchema>;

export const ReviewTagSchema = z.enum([
  "INVESTIGATION_COMPLETE",
  "IMPLEMENTATION_COMPLETE",
  "VALIDATION_ISSUES",
  "VALIDATION_FAILED",
  "RUN_FAILED",
  "INTERRUPTED",
  "READY_TO_MERGE",
  "MERGE_CONFLICT",
]);
export type ReviewTag = z.infer<typeof ReviewTagSchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  root_path: z.string().min(1),
  ide_command: z.string().nullable(),
  worktree_root: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export const CreateProjectSchema = z.object({
  name: z.string().trim().min(1),
  root_path: z.string().trim().min(1),
  ide_command: z.string().trim().min(1).optional(),
  worktree_root: z.string().trim().min(1).optional(),
});
export const UpdateProjectSchema = CreateProjectSchema;
export const ValidateGitRootSchema = z.object({ root_path: z.string().trim().min(1) });
export type Project = z.infer<typeof ProjectSchema>;

export const TaskSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  workflow_state: WorkflowStateSchema,
  review_tag: ReviewTagSchema.nullable(),
  latest_task_commit_sha: z.string().nullable(),
  base_commit_sha: z.string().nullable().optional(),
  base_branch: z.string().nullable().optional(),
  worktree_path: z.string().nullable().optional(),
  active_validation_snapshot_id: z.string().nullable().optional(),
  validation_snapshot_current: z.boolean().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Task = z.infer<typeof TaskSchema>;

export const CreateTaskSchema = z.object({
  project_id: z.string().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
});
export const UpdateTaskSchema = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().optional(),
}).refine((task) => task.title !== undefined || task.description !== undefined, {
  message: "At least one task field must be provided.",
});
export const BoardSnapshotSchema = z.object({
  columns: z.object({
    TODO: z.array(TaskSchema),
    IN_PROGRESS: z.array(TaskSchema),
    REQUIRES_HUMAN: z.array(TaskSchema),
    REVIEW: z.array(TaskSchema),
    DONE: z.array(TaskSchema),
  }),
});
export type BoardSnapshot = z.infer<typeof BoardSnapshotSchema>;

export const TaskRunSummarySchema = z.object({
  id: z.string().min(1),
  stage: WorkingPhaseSchema,
  sequence: z.number().int().positive(),
  status: RunStatusSchema,
  reason_code: RunReasonCodeSchema.nullable(),
  error_message: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  handover: z.unknown().nullable(),
  validation_result: z.object({
    result: ValidationResultSchema,
    findings: z.array(ValidationFindingSchema),
    active: z.boolean().optional(),
  }).nullable().optional(),
});
export type TaskRunSummary = z.infer<typeof TaskRunSummarySchema>;

export const QueueItemSchema = z.object({
  job_id: z.string().min(1),
  run_id: z.string().min(1),
  task_id: z.string().min(1),
  title: z.string().min(1),
  stage: WorkingPhaseSchema,
  queue_position: z.number().int().positive().nullable(),
  job_status: AgentJobStatusSchema,
  run_status: RunStatusSchema,
});
export const QueueSnapshotSchema = z.object({
  max_concurrent_agents: z.number().int().positive(),
  active_count: z.number().int().nonnegative(),
  jobs: z.array(QueueItemSchema),
});
export type QueueItem = z.infer<typeof QueueItemSchema>;
export type QueueSnapshot = z.infer<typeof QueueSnapshotSchema>;
export const EnqueueTaskSchema = z.object({ stage: z.enum(["INVESTIGATION", "IMPLEMENTATION"]) });
export const StartRunSchema = z.object({
  task_id: z.string().trim().min(1),
  stage: z.enum(["INVESTIGATION", "IMPLEMENTATION"]),
  prompt: z.string().trim().min(1),
  idempotency_key: z.string().trim().min(1),
  reused_from_input_id: z.string().trim().min(1).optional(),
});
export const RunMessageSchema = z.object({
  input_id: z.string().trim().min(1),
  text: z.string().trim().min(1),
  reused_from_input_id: z.string().trim().min(1).optional(),
});
export const RunInputDeliveryTypeSchema = z.enum(["INITIAL_PROMPT", "QUEUED_INPUT", "STEERING"]);
export const RunInputDeliveryStatusSchema = z.enum([
  "PENDING",
  "ACCEPTED",
  "DELIVERED",
  "UNDELIVERED",
  "DELIVERY_UNKNOWN",
  "CANCELLED",
]);
export const RunInputSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().min(1),
  run_id: z.string().min(1),
  sequence: z.number().int().positive(),
  idempotency_key: z.string().min(1),
  content: z.string().min(1),
  delivery_type: RunInputDeliveryTypeSchema,
  delivery_status: RunInputDeliveryStatusSchema,
  accepted_at: z.string().datetime(),
  delivered_at: z.string().datetime().nullable(),
  session_id: z.string().min(1).nullable(),
  session_sequence: z.number().int().positive().nullable(),
  transcript_boundary_entry_id: z.string().min(1).nullable(),
  transcript_entry_id: z.string().min(1).nullable(),
  failure_reason: z.string().nullable(),
  reused_from_input_id: z.string().min(1).nullable(),
});
export type StartRun = z.infer<typeof StartRunSchema>;
export type RunMessage = z.infer<typeof RunMessageSchema>;
export type RunInput = z.infer<typeof RunInputSchema>;

export const LiveHistoryEntrySchema = z.object({
  id: z.string().min(1),
  entry_id: z.string().min(1),
  session_id: z.string().min(1),
  run_id: z.string().min(1).nullable(),
  timestamp: z.string().datetime(),
  role: z.string().min(1),
  message: z.record(z.unknown()),
});
export const LiveHistorySnapshotSchema = z.object({
  task_id: z.string().min(1),
  session_id: z.string().min(1).nullable(),
  active_run_id: z.string().min(1).nullable(),
  cursor: z.number().int().nonnegative(),
  provisional_truncated: z.boolean(),
  entries: z.array(LiveHistoryEntrySchema),
  inputs: z.array(RunInputSchema),
  provisional_events: z.array(LiveEventSchema),
});
export type LiveHistoryEntry = z.infer<typeof LiveHistoryEntrySchema>;
export type LiveHistorySnapshot = z.infer<typeof LiveHistorySnapshotSchema>;

export const CheckpointConfirmationSchema = z.object({
  tracked_changes: z.array(z.string()),
  include_untracked_files: z.array(z.string()),
  branch: z.string().min(1),
  commit_sha: z.string().min(1),
  state_token: z.string().min(1),
});
export type CheckpointConfirmation = z.infer<typeof CheckpointConfirmationSchema>;
export const CheckpointPreviewSchema = z.object({
  tracked_changes: z.array(z.string()),
  untracked_files: z.array(z.string()),
  branch: z.string().min(1),
  commit_sha: z.string().min(1),
  state_token: z.string().min(1),
});
export type CheckpointPreview = z.infer<typeof CheckpointPreviewSchema>;
export const CheckpointDiffSchema = z.object({
  from_sha: z.string(),
  to_sha: z.string(),
  files: z.array(z.string()),
  diff: z.string(),
});
export type CheckpointDiff = z.infer<typeof CheckpointDiffSchema>;
export const ReorderQueueJobSchema = z.object({ position: z.number().int().positive() });
