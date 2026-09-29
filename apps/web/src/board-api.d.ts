import type { BoardSnapshot, Project, QueueSnapshot, Task } from "@kanban-board/shared";

export function loadBoard(): Promise<BoardSnapshot>;
export function loadQueue(): Promise<QueueSnapshot>;
export function loadProjects(): Promise<Project[]>;
export function createProject(name: string, rootPath: string, worktreeRoot: string): Promise<Project>;
export function deleteProject(projectId: string): Promise<void>;
export function createTask(projectId: string, title: string, description: string): Promise<Task>;
export function deleteTask(taskId: string): Promise<void>;
export function loadTaskCompletionStatus(taskId: string): Promise<{
  ready: boolean;
  reason: "WORKTREE_CHANGES" | "BRANCH_CHANGES" | "GIT_STATE_UNAVAILABLE" | null;
}>;
export function completeTask(taskId: string): Promise<{ status: string }>;
export function reorderQueueJob(jobId: string, position: number): Promise<QueueSnapshot>;
export function removeQueueJob(jobId: string): Promise<void>;
export function stopRun(runId: string): Promise<{ status: string }>;
