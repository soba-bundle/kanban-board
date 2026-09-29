import type { CheckpointConfirmation, CheckpointDiff, CheckpointPreview, HumanRequest, HumanRequestAnswerInput, LiveEvent, TaskRunSummary } from "@kanban-board/shared";

export function loadRuns(taskId: string): Promise<TaskRunSummary[]>;
export function loadLiveHistory(taskId: string): Promise<import("@kanban-board/shared").LiveHistorySnapshot>;
export function loadHumanRequests(taskId: string): Promise<HumanRequest[]>;
export function answerHumanRequest(requestId: string, answers: HumanRequestAnswerInput[]): Promise<HumanRequest>;
export function stopHumanRequest(requestId: string): Promise<{ status: string }>;
export function steerRun(runId: string, inputId: string, text: string, reusedFromInputId?: string): Promise<import("@kanban-board/shared").RunInput>;
export function loadCheckpointPreview(taskId: string): Promise<CheckpointPreview>;
export function loadCheckpointDiff(taskId: string): Promise<CheckpointDiff>;
export function createCheckpoint(taskId: string, confirmation: CheckpointConfirmation): Promise<{ commit_sha: string }>;
export function openRunEvents(taskId: string, runId: string, onEvent: (event: LiveEvent) => void, after?: number): WebSocket;
