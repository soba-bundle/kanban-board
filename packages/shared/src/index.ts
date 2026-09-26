import { z } from "zod";

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
