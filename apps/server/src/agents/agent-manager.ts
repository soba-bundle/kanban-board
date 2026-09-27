import { createAgentSession, SessionManager, type AgentSessionEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type Database from "better-sqlite3";
import type { LiveEvent } from "@kanban-board/shared";
import { normalizePiEvent } from "./pi-events.js";
import { createHandoverTool } from "./handover-tool.js";

type LiveEventHandler = (event: LiveEvent) => void;
export interface WorkingSession {
  sessionId: string;
  sessionFile?: string;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(handler: (event: AgentSessionEvent) => void): () => void;
  dispose(): void;
}
type SessionFactory = (
  cwd: string,
  manager: SessionManager,
  customTools: ToolDefinition[],
) => Promise<WorkingSession>;

interface TaskSessionRow {
  working_session_id: string | null;
  working_session_file: string | null;
  worktree_path: string | null;
  root_path: string;
}

export class AgentManager {
  private readonly sessions = new Map<string, WorkingSession>();
  private readonly activeRuns = new Map<string, string>();
  private readonly listeners = new Map<string, Set<{ runId: string; handler: LiveEventHandler }>>();
  /**
   * Recent events per run so a client joining Live mid-run sees prior output.
   * In-memory only: it does not survive restart, and finished-run history comes
   * from Pi JSONL reconstruction (Phase 12).
   */
  private readonly replayBuffers = new Map<string, LiveEvent[]>();

  constructor(
    private readonly db: Database.Database,
    private readonly sessionDir = process.env.KANBAN_SESSION_DIR ?? "data/sessions",
    private readonly sessionFactory: SessionFactory = async (cwd, manager, customTools) => {
      const { session } = await createAgentSession({ cwd, sessionManager: manager, customTools });
      return session;
    },
    private readonly replayLimit = Number(process.env.KANBAN_LIVE_REPLAY_LIMIT ?? 2000),
  ) {}

  async createWorkingSession(taskId: string): Promise<WorkingSession> {
    const row = this.getTask(taskId);
    if (row.working_session_file) return this.restoreWorkingSession(taskId);
    if (this.sessions.has(taskId)) return this.sessions.get(taskId)!;
    return this.openSession(taskId, row, SessionManager.create(this.cwd(row), this.sessionDir));
  }

  async getOrCreateWorkingSession(taskId: string): Promise<WorkingSession> {
    const existing = this.sessions.get(taskId);
    if (existing) return existing;
    const row = this.getTask(taskId);
    return row.working_session_file
      ? this.restoreWorkingSession(taskId)
      : this.createWorkingSession(taskId);
  }

  async restoreWorkingSession(taskId: string): Promise<WorkingSession> {
    const row = this.getTask(taskId);
    if (!row.working_session_file) throw new Error(`Task ${taskId} has no saved working session.`);
    const session = await this.openSession(taskId, row, SessionManager.open(row.working_session_file, undefined, this.cwd(row)));
    return session;
  }

  async prompt(taskId: string, runId: string, prompt: string): Promise<void> {
    const session = this.requireSession(taskId);
    this.activeRuns.set(taskId, runId);
    try {
      await session.prompt(prompt);
    } finally {
      if (this.activeRuns.get(taskId) === runId) this.activeRuns.delete(taskId);
    }
  }

  async steer(taskId: string, text: string): Promise<void> {
    await this.requireSession(taskId).steer(text);
  }

  /** Publish a backend-originated event to a run's live subscribers. */
  publish(taskId: string, runId: string, type: string, data: Record<string, unknown>): void {
    this.emit({ taskId, runId, type, timestamp: new Date().toISOString(), data });
  }

  /** Events already seen for this run, oldest first. */
  replay(runId: string): LiveEvent[] {
    return [...(this.replayBuffers.get(runId) ?? [])];
  }

  /** Drops a run's buffer once its output is no longer needed live. */
  clearReplay(runId: string): void {
    this.replayBuffers.delete(runId);
  }

  private emit(event: LiveEvent): void {
    const buffer = this.replayBuffers.get(event.runId) ?? [];
    buffer.push(event);
    if (buffer.length > this.replayLimit) buffer.splice(0, buffer.length - this.replayLimit);
    this.replayBuffers.set(event.runId, buffer);
    for (const subscription of this.listeners.get(event.taskId) ?? []) {
      if (subscription.runId === event.runId) subscription.handler(event);
    }
  }

  activeRunId(taskId: string): string | undefined {
    return this.activeRuns.get(taskId);
  }

  subscribe(taskId: string, runId: string, handler: LiveEventHandler): () => void {
    const subscriptions = this.listeners.get(taskId) ?? new Set();
    const subscription = { runId, handler };
    subscriptions.add(subscription);
    this.listeners.set(taskId, subscriptions);
    return () => {
      subscriptions.delete(subscription);
      if (subscriptions.size === 0) this.listeners.delete(taskId);
    };
  }

  async abort(taskId: string): Promise<boolean> {
    const session = this.sessions.get(taskId);
    if (!session) return false;
    await session.abort();
    return true;
  }

  dispose(taskId: string): void {
    this.sessions.get(taskId)?.dispose();
    this.sessions.delete(taskId);
    this.activeRuns.delete(taskId);
    this.listeners.delete(taskId);
  }

  private async openSession(taskId: string, row: TaskSessionRow, manager: SessionManager): Promise<WorkingSession> {
    this.sessions.get(taskId)?.dispose();
    const session = await this.sessionFactory(this.cwd(row), manager, [
      createHandoverTool(this.db, { activeRunId: () => this.activeRuns.get(taskId) }),
    ]);
    this.sessions.set(taskId, session);
    this.db.prepare(`UPDATE tasks SET working_session_id = ?, working_session_file = ?, updated_at = ? WHERE id = ?`)
      .run(session.sessionId, session.sessionFile ?? null, new Date().toISOString(), taskId);
    session.subscribe((event) => {
      const runId = this.activeRuns.get(taskId);
      if (!runId) return;
      const normalized = normalizePiEvent(event);
      this.emit({
        taskId,
        runId,
        type: normalized.type,
        timestamp: new Date().toISOString(),
        data: normalized.data,
      });
    });
    return session;
  }

  private getTask(taskId: string): TaskSessionRow {
    const row = this.db.prepare(`SELECT t.working_session_id, t.working_session_file, t.worktree_path, p.root_path
      FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`).get(taskId) as TaskSessionRow | undefined;
    if (!row) throw new Error(`Task ${taskId} not found.`);
    return row;
  }


  private cwd(row: TaskSessionRow): string {
    return row.worktree_path ?? row.root_path;
  }

  private requireSession(taskId: string): WorkingSession {
    const session = this.sessions.get(taskId);
    if (!session) throw new Error(`Working session for task ${taskId} is not open.`);
    return session;
  }
}
