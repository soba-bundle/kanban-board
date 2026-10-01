import type { CheckpointConfirmation, CheckpointDiff, CheckpointPreview, HumanRequest, HumanRequestAnswerInput, LiveEvent, TaskRunSummary } from "@kanban-board/shared";

export function loadRuns(taskId: string): Promise<TaskRunSummary[]>;
export function startValidation(taskId: string): Promise<{ run_id: string; status: string }>;
export function loadLiveHistory(taskId: string): Promise<import("@kanban-board/shared").LiveHistorySnapshot>;
export function loadHumanRequests(taskId: string): Promise<HumanRequest[]>;
export function answerHumanRequest(requestId: string, answers: HumanRequestAnswerInput[]): Promise<HumanRequest>;
export function stopHumanRequest(requestId: string): Promise<{ status: string }>;
export function steerRun(runId: string, inputId: string, text: string, reusedFromInputId?: string): Promise<import("@kanban-board/shared").RunInput>;
export function loadCheckpointPreview(taskId: string): Promise<CheckpointPreview>;
export function loadCheckpointDiff(taskId: string): Promise<CheckpointDiff>;
export function loadMergePreview(taskId: string): Promise<{
  eligible: boolean; reasons?: string[]; reason?: string | null; base_moved?: boolean; base_branch?: string;
  validated_base_sha?: string; current_base_sha?: string; live_base_sha?: string; candidate_sha?: string;
  status?: string; merge_attempt_id?: string;
}>;
export function startMerge(taskId: string): Promise<{ status: string; merge_attempt_id?: string }>;
export function mergeAction(taskId: string, action: "abort" | "retry" | "view-conflicts"): Promise<{ status: string }>;
export function createCheckpoint(taskId: string, confirmation: CheckpointConfirmation): Promise<{ commit_sha: string }>;
export function openRunEvents(taskId: string, runId: string, onEvent: (event: LiveEvent) => void, after?: number): WebSocket;
