import type { CheckpointDiff, CheckpointPreview, LiveEvent, TaskRunSummary, TicketComment } from "@kanban-board/shared";

export function loadComments(taskId: string): Promise<TicketComment[]>;
export function loadRuns(taskId: string): Promise<TaskRunSummary[]>;
export function addComment(taskId: string, content: string): Promise<TicketComment>;
export function editComment(commentId: string, content: string): Promise<TicketComment>;
export function deleteComment(commentId: string): Promise<void>;
export function steerRun(runId: string, text: string): Promise<TicketComment>;
export function enqueueReviewTask(taskId: string, stage: "INVESTIGATION" | "IMPLEMENTATION"): Promise<unknown>;
export function loadCheckpointPreview(taskId: string): Promise<CheckpointPreview>;
export function loadCheckpointDiff(taskId: string): Promise<CheckpointDiff>;
export function createCheckpoint(taskId: string, includeUntrackedFiles?: string[]): Promise<{ commit_sha: string }>;
export function openRunEvents(runId: string, onEvent: (event: LiveEvent) => void): WebSocket;
