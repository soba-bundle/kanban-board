import type { CheckpointConfirmation, CheckpointDiff, CheckpointPreview, HumanRequest, HumanRequestAnswerInput, LiveEvent, TaskRunSummary } from "@kanban-board/shared";

export function loadRuns(taskId: string): Promise<TaskRunSummary[]>;
export function loadLiveHistory(taskId: string): Promise<import("@kanban-board/shared").LiveHistorySnapshot>;
export function loadHumanRequests(taskId: string): Promise<HumanRequest[]>;
export function answerHumanRequest(requestId: string, answers: HumanRequestAnswerInput[]): Promise<HumanRequest>;
export function stopHumanRequest(requestId: string): Promise<{ status: string }>;
export function steerRun(runId: string, inputId: string, text: string, reusedFromInputId?: string): Promise<import("@kanban-board/shared").RunInput>;
export function loadCheckpointPreview(taskId: string): Promise<CheckpointPreview>;
export interface TaskSyncCheck {
  task_id: string;
  status: "IN_SYNC" | "STALE" | "BLOCKED";
  in_sync: boolean;
  base_sha: string | null;
  recorded_base_sha: string | null;
  task_sha: string | null;
  branch: string | null;
  base_moved: boolean;
  checked_at: string;
  reasons: string[];
}
export function checkTaskSync(taskId: string): Promise<TaskSyncCheck>;
export function syncTaskWithBase(taskId: string): Promise<
  | { status: "SYNCED"; synced_base_sha: string; candidate_sha: string; attempt_id: string }
  | { status: "CONFLICT"; synced_base_sha: string; candidate_sha: string; attempt_id: string }
>;
export interface TaskSyncRecovery {
  attempt_id: string;
  state: "CONFLICT" | "RESOLUTION_COMMITTED" | "SAFE_TO_RETRY" | "INTERRUPTED";
  base_sha: string;
  prior_task_sha: string;
  current_candidate_sha: string | null;
  can_abort: boolean;
  error_message: string | null;
}
export function loadTaskSyncRecovery(taskId: string): Promise<{ recovery: TaskSyncRecovery | null }>;
export function viewTaskSyncConflicts(taskId: string): Promise<{ status: "OPENED" }>;
export function retryTaskSync(taskId: string): Promise<
  | { status: "SYNCED"; synced_base_sha: string; candidate_sha: string }
  | { status: "CONFLICT"; synced_base_sha: string; candidate_sha: string; attempt_id: string }
>;
export function abortTaskSync(taskId: string, confirmed: boolean): Promise<{ status: "ABORTED" }>;
export function loadCheckpointDiff(taskId: string): Promise<CheckpointDiff>;
export function loadMergePreview(taskId: string): Promise<{
  eligible: boolean; preview_id?: string; reasons?: string[]; reason?: string | null; base_moved?: boolean; base_branch?: string;
  checked_base_sha?: string; recorded_base_sha?: string; current_base_sha?: string; task_sha?: string; candidate_sha?: string;
  checked_at?: string; sync_status?: "IN_SYNC" | "STALE" | "BLOCKED"; status?: string; merge_attempt_id?: string;
}>;
export function startMerge(taskId: string, previewId: string): Promise<{ status: string; merge_attempt_id?: string }>;
export function mergeAction(taskId: string, action: "abort" | "retry" | "view-conflicts"): Promise<{ status: string }>;
export function createCheckpoint(taskId: string, confirmation: CheckpointConfirmation): Promise<{ commit_sha: string }>;
export function openRunEvents(taskId: string, runId: string, onEvent: (event: LiveEvent) => void, after?: number): WebSocket;
