import type { LiveEvent, TaskRunSummary, TicketComment } from "@kanban-board/shared";

export function loadComments(taskId: string): Promise<TicketComment[]>;
export function loadRuns(taskId: string): Promise<TaskRunSummary[]>;
export function addComment(taskId: string, content: string): Promise<TicketComment>;
export function editComment(commentId: string, content: string): Promise<TicketComment>;
export function deleteComment(commentId: string): Promise<void>;
export function steerRun(runId: string, text: string): Promise<TicketComment>;
export function openRunEvents(runId: string, onEvent: (event: LiveEvent) => void): WebSocket;
