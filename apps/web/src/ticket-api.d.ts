import type { CheckpointConfirmation, CheckpointDiff, CheckpointPreview, LiveEvent, TaskRunSummary, TicketComment } from "@kanban-board/shared";

export function loadComments(taskId: string): Promise<TicketComment[]>;
export function loadRuns(taskId: string): Promise<TaskRunSummary[]>;
export function loadLiveHistory(taskId: string): Promise<import("@kanban-board/shared").LiveHistorySnapshot>;
export function addComment(taskId: string, content: string): Promise<TicketComment>;
export function editComment(commentId: string, content: string): Promise<TicketComment>;
export function deleteComment(commentId: string): Promise<void>;
export function steerRun(runId: string, inputId: string, text: string, reusedFromInputId?: string): Promise<import("@kanban-board/shared").RunInput>;
export function loadCheckpointPreview(taskId: string): Promise<CheckpointPreview>;
export function loadCheckpointDiff(taskId: string): Promise<CheckpointDiff>;
export function createCheckpoint(taskId: string, confirmation: CheckpointConfirmation): Promise<{ commit_sha: string }>;
export function openRunEvents(taskId: string, runId: string, onEvent: (event: LiveEvent) => void, after?: number): WebSocket;
