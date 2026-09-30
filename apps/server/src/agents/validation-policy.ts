interface TaskEligibilityState {
  workflow_state: string;
  review_tag: string | null;
  latest_task_commit_sha: string | null;
  base_commit_sha: string | null;
}

interface WorktreeEligibilityState {
  head_sha: string | null;
  dirty: boolean;
}

interface QueueEligibilityState {
  has_active_work: boolean;
  validation_already_queued_or_running?: boolean;
}

interface PreviousValidationState {
  result: string;
  candidate_sha: string | null;
  had_direct_findings: boolean;
}

export interface ValidationEligibilityInput {
  task: TaskEligibilityState;
  worktree: WorktreeEligibilityState;
  queue: QueueEligibilityState;
  operation_locked: boolean;
  previous_validation: PreviousValidationState | null;
}

export function evaluateValidationEligibility(input: ValidationEligibilityInput): { eligible: boolean; reason?: string } {
  const { task, worktree, queue, previous_validation: previous } = input;
  if (task.workflow_state !== "REVIEW") return { eligible: false, reason: "Task must be in Review." };
  if (!task.latest_task_commit_sha || !task.base_commit_sha) {
    return { eligible: false, reason: "Create a checkpoint before validation." };
  }
  if (worktree.dirty || worktree.head_sha !== task.latest_task_commit_sha) {
    return { eligible: false, reason: "Task worktree must be clean and match the latest checkpoint." };
  }
  if (queue.has_active_work || queue.validation_already_queued_or_running) {
    return { eligible: false, reason: "Task already has active or queued work." };
  }
  if (input.operation_locked) return { eligible: false, reason: "Another task operation is in progress." };

  if (task.review_tag === "IMPLEMENTATION_COMPLETE") return { eligible: true };
  if (task.review_tag === "VALIDATION_FAILED" && (!previous ||
    (previous.result === "VALIDATION_FAILED" && previous.candidate_sha === task.latest_task_commit_sha))) {
    return { eligible: true };
  }
  if (task.review_tag === "VALIDATION_ISSUES" && previous?.result === "ISSUES_FOUND" &&
    previous.had_direct_findings && previous.candidate_sha !== task.latest_task_commit_sha) return { eligible: true };
  return { eligible: false, reason: "Task must have a current Implementation Complete checkpoint." };
}
