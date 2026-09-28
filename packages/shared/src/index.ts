import { z } from "zod";
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

export const AgentJobStatusSchema = z.enum(["QUEUED", "CLAIMED", "FINISHED", "CANCELLED"]);
export type AgentJobStatus = z.infer<typeof AgentJobStatusSchema>;

export const RunReasonCodeSchema = z.enum([
  "USER_STOPPED",
  "BACKEND_INTERRUPTED",
  "HANDOVER_FAILED",
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

export const CommentAuthorTypeSchema = z.enum(["USER", "AGENT", "SYSTEM"]);
export type CommentAuthorType = z.infer<typeof CommentAuthorTypeSchema>;

export const CommentDeliveryStatusSchema = z.enum(["PENDING", "QUEUED", "DELIVERED"]);
export type CommentDeliveryStatus = z.infer<typeof CommentDeliveryStatusSchema>;

export const CommentDeliveryTypeSchema = z.enum(["NEXT_PROMPT", "STEERING"]);
export type CommentDeliveryType = z.infer<typeof CommentDeliveryTypeSchema>;

export const TicketCommentSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().min(1),
  run_id: z.string().min(1).nullable(),
  author_type: CommentAuthorTypeSchema,
  content: z.string().min(1),
  delivery_status: CommentDeliveryStatusSchema,
  delivery_type: CommentDeliveryTypeSchema.nullable(),
  delivered_session_id: z.string().min(1).nullable(),
  delivered_run_id: z.string().min(1).nullable(),
  delivered_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().nullable(),
});
export type TicketComment = z.infer<typeof TicketCommentSchema>;

export const CreateTicketCommentSchema = z.object({ content: z.string().trim().min(1) });
export const UpdateTicketCommentSchema = CreateTicketCommentSchema;
export const SteerRunSchema = z.object({ text: z.string().trim().min(1) });

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
export const CheckpointConfirmationSchema = z.object({ include_untracked_files: z.array(z.string()).optional() });
export const CheckpointPreviewSchema = z.object({
  tracked_changes: z.array(z.string()),
  untracked_files: z.array(z.string()),
  commit_sha: z.string().nullable(),
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
