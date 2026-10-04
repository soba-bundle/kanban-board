import { createAgentSession, SessionManager, type AgentSessionEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type Database from "better-sqlite3";
import {
  HumanRequestQuestionsSchema,
  type HumanRequestAnswer,
  type HumanRequestQuestion,
  type LiveCompactionSummary,
  type LiveEvent,
  type LiveHistorySnapshot,
} from "@kanban-board/shared";
import { normalizePiEvent } from "./pi-events.js";
import type { HumanRequestService } from "./human-requests.js";
import { createKanbanQuestionnaireTool } from "../pi/questionnaire-tool.js";
import { createKanbanResourceLoader } from "../pi/resource-loader.js";
import { applyKanbanSettings, loadKanbanConfig } from "../kanban-config.js";

type LiveEventHandler = (event: LiveEvent) => void;
export interface WorkingSession {
  sessionId: string;
  sessionFile?: string;
  sessionManager?: Pick<SessionManager, "getLeafId" | "getLeafEntry" | "getBranch" | "getSessionId">;
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
   * In-memory only: it does not survive restart; completed messages are rebuilt
   * from the task's Pi JSONL session branch.
   */
  private readonly replayBuffers = new Map<string, LiveEvent[]>();
  private readonly runSequences = new Map<string, number>();
  private readonly durableSequences = new Map<string, number>();

  constructor(
    private readonly db: Database.Database,
    private readonly sessionDir = process.env.KANBAN_SESSION_DIR ?? "data/sessions",
    private readonly sessionFactory: SessionFactory = async (cwd, manager, customTools) => {
      const { agentDir, settingsManager, resourceLoader } = createKanbanResourceLoader(cwd);
      await resourceLoader.reload();
      applyKanbanSettings(settingsManager, loadKanbanConfig());
      const { session } = await createAgentSession({
        cwd, agentDir, settingsManager, resourceLoader, sessionManager: manager, customTools,
      });
      return session;
    },
    private readonly replayLimit = Number(process.env.KANBAN_LIVE_REPLAY_LIMIT ?? 2000),
    private readonly humanRequests?: HumanRequestService,
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

  streamSnapshot(runId: string): { cursor: number; durableCursor: number; events: LiveEvent[]; oldestSequence: number | null } {
    const events = this.replay(runId);
    return {
      cursor: this.runSequences.get(runId) ?? 0,
      durableCursor: this.durableSequences.get(runId) ?? 0,
      events,
      oldestSequence: events[0]?.sequence ?? null,
    };
  }

  /** Drops a run's buffer once its output is no longer needed live. */
  clearReplay(runId: string): void {
    this.replayBuffers.delete(runId);
    this.runSequences.delete(runId);
    this.durableSequences.delete(runId);
  }

  private emit(event: Omit<LiveEvent, "eventId" | "sequence">): void {
    const sequence = (this.runSequences.get(event.runId) ?? 0) + 1;
    const sequenced: LiveEvent = { ...event, sequence, eventId: `${event.runId}:${sequence}` };
    this.runSequences.set(event.runId, sequence);
    if (event.type === "entry_appended") this.durableSequences.set(event.runId, sequence);
    const buffer = this.replayBuffers.get(event.runId) ?? [];
    buffer.push(sequenced);
    if (buffer.length > this.replayLimit) buffer.splice(0, buffer.length - this.replayLimit);
    this.replayBuffers.set(event.runId, buffer);
    for (const subscription of this.listeners.get(event.taskId) ?? []) {
      if (subscription.runId === event.runId) subscription.handler(sequenced);
    }
  }

  activeRunId(taskId: string): string | undefined {
    return this.activeRuns.get(taskId);
  }

  transcriptLeafId(taskId: string): string | null {
    return this.sessions.get(taskId)?.sessionManager?.getLeafId() ?? null;
  }

  questionnaireCallState(taskId: string, sessionId: string, toolCallId: string): "RESULT" | "DANGLING" | "MISSING" {
    const session = this.sessions.get(taskId);
    if (!session?.sessionManager || session.sessionId !== sessionId) return "MISSING";
    const callIndexes: number[] = [];
    const resultIndexes: Array<{ index: number; valid: boolean }> = [];
    const branch = session.sessionManager.getBranch();
    for (const [index, entry] of branch.entries()) {
      if (entry.type !== "message") continue;
      const message = entry.message as { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
      if (message.role === "toolResult" && message.toolCallId === toolCallId) {
        resultIndexes.push({ index, valid: message.toolName === "kanban_questionnaire" && !message.isError });
      }
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content as Array<{ type?: string; id?: string; name?: string }>) {
        if (part.type === "toolCall" && part.id === toolCallId && part.name === "kanban_questionnaire") callIndexes.push(index);
      }
    }
    if (callIndexes.length !== 1 || resultIndexes.length > 1 ||
      resultIndexes.some((result) => !result.valid || result.index <= callIndexes[0]!)) return "MISSING";
    return resultIndexes.length === 1 ? "RESULT" : "DANGLING";
  }

  historySnapshot(taskId: string): LiveHistorySnapshot {
    const task = this.db.prepare(`SELECT t.working_session_id, t.working_session_file, t.worktree_path, p.root_path
      FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`).get(taskId) as
      (TaskSessionRow & { working_session_id: string | null }) | undefined;
    if (!task) throw new Error(`Task ${taskId} not found.`);

    const runs = this.db.prepare(`SELECT id, sequence, status, session_id, session_file,
        transcript_start_entry_id, transcript_end_entry_id FROM task_runs WHERE task_id = ? ORDER BY sequence`)
      .all(taskId) as Array<{
        id: string; sequence: number; status: string; session_id: string | null; session_file: string | null;
        transcript_start_entry_id: string | null; transcript_end_entry_id: string | null;
      }>;
    const activeRun = runs.find((run) => run.status === "RUNNING");
    const inputRows = this.db.prepare(`SELECT i.id, i.task_id, i.run_id, i.sequence, i.idempotency_key, i.content, i.delivery_type,
        i.delivery_status, i.accepted_at, i.delivered_at, i.session_id, i.session_sequence, i.transcript_boundary_entry_id,
        i.transcript_entry_id, i.failure_reason, i.reused_from_input_id FROM run_inputs i
        JOIN task_runs r ON r.id = i.run_id WHERE i.task_id = ? ORDER BY r.sequence, i.sequence`).all(taskId);

    const files = new Map<string, typeof runs>();
    for (const run of runs) {
      if (!run.session_file) continue;
      const group = files.get(run.session_file) ?? [];
      group.push(run);
      files.set(run.session_file, group);
    }
    if (task.working_session_file && !files.has(task.working_session_file)) files.set(task.working_session_file, []);

    const history: LiveHistorySnapshot["entries"] = [];
    const compactionSummaries: LiveCompactionSummary[] = [];
    const seen = new Set<string>();
    const seenCompactions = new Set<string>();
    const orderedGroups = [...files.entries()].sort(([, left], [, right]) =>
      (left[0]?.sequence ?? Number.MAX_SAFE_INTEGER) - (right[0]?.sequence ?? Number.MAX_SAFE_INTEGER));
    for (const [sessionFile, sessionRuns] of orderedGroups) {
      const liveSession = this.sessions.get(taskId);
      const manager = liveSession?.sessionFile === sessionFile && liveSession.sessionManager
        ? liveSession.sessionManager
        : SessionManager.open(sessionFile, undefined, this.cwd(task));
      const sessionId = manager.getSessionId();
      const branch = manager.getBranch();
      const indices = new Map(branch.map((entry, index) => [entry.id, index]));
      const runByEntry = new Map<string, string>();
      for (const run of sessionRuns) {
        const recorded = this.db.prepare(`SELECT entry_id FROM run_transcript_entries
          WHERE run_id = ? AND session_id = ? ORDER BY sequence`).all(run.id, sessionId) as Array<{ entry_id: string }>;
        for (const item of recorded) if (indices.has(item.entry_id)) runByEntry.set(item.entry_id, run.id);
        const start = run.transcript_start_entry_id === null ? -1 : indices.get(run.transcript_start_entry_id);
        if (start === undefined) continue;
        const end = run.transcript_end_entry_id === null
          ? (run.status === "RUNNING" ? branch.length - 1 : start)
          : indices.get(run.transcript_end_entry_id);
        if (end === undefined || end <= start) continue;
        for (let index = start + 1; index <= end; index++) {
          const entryId = branch[index]!.id;
          if (!runByEntry.has(entryId)) runByEntry.set(entryId, run.id);
        }
      }
      let previousMessageId: string | null = null;
      for (const entry of branch) {
        if (entry.type === "compaction") {
          const id = `${sessionId}:${entry.id}`;
          if (entry.summary && !seenCompactions.has(id)) {
            seenCompactions.add(id);
            compactionSummaries.push({
              id,
              timestamp: entry.timestamp,
              summary: entry.summary,
              tokens_before: entry.tokensBefore,
              after_entry_id: previousMessageId ? `${sessionId}:${previousMessageId}` : null,
            });
          }
          continue;
        }
        if (entry.type !== "message" || !entry.message || typeof entry.message.role !== "string") continue;
        previousMessageId = entry.id;
        const id = `${sessionId}:${entry.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        history.push({
          id,
          entry_id: entry.id,
          session_id: sessionId,
          run_id: runByEntry.get(entry.id) ?? null,
          timestamp: entry.timestamp,
          role: entry.message.role === "toolResult" ? "tool" : entry.message.role,
          message: entry.message as unknown as Record<string, unknown>,
        });
      }
    }
    compactionSummaries.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    const stream = activeRun ? this.streamSnapshot(activeRun.id) : undefined;
    const provisionalEvents = stream
      ? stream.events.filter((event) => event.sequence > stream.durableCursor)
      : [];
    const truncated = !!(stream && stream.oldestSequence !== null &&
      stream.durableCursor + 1 < stream.oldestSequence);
    return {
      task_id: taskId,
      session_id: task.working_session_id,
      active_run_id: activeRun?.id ?? null,
      cursor: stream?.cursor ?? 0,
      provisional_truncated: truncated,
      entries: history,
      compaction_summaries: compactionSummaries,
      inputs: inputRows as LiveHistorySnapshot["inputs"],
      provisional_events: provisionalEvents,
    };
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
    this.repairAnsweredQuestionnaireCalls(taskId, manager);
    this.sessions.get(taskId)?.dispose();
    const session = await this.sessionFactory(this.cwd(row), manager, [
      createKanbanQuestionnaireTool({
        humanRequests: this.humanRequests,
        taskId,
        runId: () => this.activeRuns.get(taskId),
        sessionId: manager.getSessionId(),
      }),
    ]);
    session.sessionManager ??= manager;
    const workingSession = session;
    this.sessions.set(taskId, workingSession);
    this.db.prepare(`UPDATE tasks SET working_session_id = ?, working_session_file = ?, updated_at = ? WHERE id = ?`)
      .run(workingSession.sessionId, workingSession.sessionFile ?? null, new Date().toISOString(), taskId);
    workingSession.subscribe((event) => {
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
      if (event.type === "message_end") {
        queueMicrotask(() => {
          const entry = workingSession.sessionManager?.getLeafEntry();
          if (!entry || entry.type !== "message" || JSON.stringify(entry.message) !== JSON.stringify(event.message)) return;
          const appended = normalizePiEvent({ type: "entry_appended", entry });
          this.emit({
            taskId,
            runId,
            type: appended.type,
            timestamp: new Date().toISOString(),
            data: appended.data,
          });
        });
      }
    });
    return workingSession;
  }

  private repairAnsweredQuestionnaireCalls(taskId: string, manager: SessionManager): void {
    const branch = manager.getBranch();
    const calls = new Map<string, Array<{ name: string; entryId: string; index: number }>>();
    const results = new Map<string, Array<{ entryId: string; valid: boolean; index: number }>>();
    for (const [index, entry] of branch.entries()) {
      if (entry.type !== "message") continue;
      const message = entry.message as { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
      if (message.role === "toolResult" && message.toolCallId) {
        const matching = results.get(message.toolCallId) ?? [];
        matching.push({ entryId: entry.id, valid: message.toolName === "kanban_questionnaire" && !message.isError, index });
        results.set(message.toolCallId, matching);
      }
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content as Array<{ type?: string; id?: string; name?: string }>) {
        if (part.type !== "toolCall" || !part.id) continue;
        const matching = calls.get(part.id) ?? [];
        matching.push({ name: part.name ?? "", entryId: entry.id, index });
        calls.set(part.id, matching);
      }
    }

    const requests = this.db.prepare(`SELECT run_id, tool_call_id, question, options_json, answer, questions_json, answers_json
      FROM human_requests WHERE task_id = ? AND session_id = ? AND status = 'ANSWERED'
      ORDER BY created_at, id`).all(taskId, manager.getSessionId()) as Array<{
        run_id: string; tool_call_id: string; question: string; options_json: string | null; answer: string | null;
        questions_json: string | null; answers_json: string | null;
      }>;
    const requestByCallId = new Map(requests.map((request) => [request.tool_call_id, request]));

    for (const [toolCallId, matchingCalls] of calls) {
      if (matchingCalls.length !== 1 || matchingCalls[0]!.name !== "kanban_questionnaire") continue;
      const request = requestByCallId.get(toolCallId);
      if (!request) continue;
      const existingResults = results.get(toolCallId) ?? [];
      if (existingResults.length > 1 || (existingResults[0] &&
        (!existingResults[0].valid || existingResults[0].index <= matchingCalls[0]!.index))) continue;
      let resultEntryId = existingResults[0]?.entryId;
      if (!resultEntryId) {
        const normalized = this.recoveryAnswers(request);
        if (!normalized) continue;
        const summary = normalized.questions.map((question) => {
          const answer = normalized.answers.find((item) => item.id === question.id)!;
          return answer.wasCustom
            ? `${question.label}: user wrote: ${answer.value}`
            : `${question.label}: user selected: ${answer.index ?? ""}. ${answer.label}`;
        }).join("\n");
        resultEntryId = manager.appendMessage({
          role: "toolResult",
          toolCallId,
          toolName: "kanban_questionnaire",
          content: [{ type: "text", text: summary }],
          isError: false,
          timestamp: Date.now(),
        });
        results.set(toolCallId, [{ entryId: resultEntryId, valid: true, index: manager.getBranch().length - 1 }]);
      }
      this.recordRecoveredToolEntry(manager.getSessionId(), request.run_id, matchingCalls[0]!.entryId);
      this.recordRecoveredToolEntry(manager.getSessionId(), request.run_id, resultEntryId);
    }
  }

  private recordRecoveredToolEntry(sessionId: string, runId: string, entryId: string): void {
    this.db.transaction(() => {
      const sequence = (this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS next
        FROM run_transcript_entries WHERE run_id = ?`).get(runId) as { next: number }).next;
      this.db.prepare(`INSERT OR IGNORE INTO run_transcript_entries (session_id, entry_id, run_id, sequence)
        VALUES (?, ?, ?, ?)`).run(sessionId, entryId, runId, sequence);
    })();
  }

  private recoveryAnswers(request: {
    question: string; options_json: string | null; answer: string | null;
    questions_json: string | null; answers_json: string | null;
  }): { questions: HumanRequestQuestion[]; answers: HumanRequestAnswer[] } | undefined {
    try {
      let questions: HumanRequestQuestion[];
      if (request.questions_json) {
        const stored = JSON.parse(request.questions_json) as Array<Record<string, unknown>>;
        questions = HumanRequestQuestionsSchema.parse(stored.map((question) => ({
          ...question,
          label: question.label ?? question.prompt,
          allowOther: question.allowOther ?? false,
          options: Array.isArray(question.options) ? question.options.map((option) => typeof option === "string"
            ? { value: option, label: option }
            : { ...(option as Record<string, unknown>), label: (option as Record<string, unknown>).label ?? (option as Record<string, unknown>).value }) : [],
        })));
      } else {
        const legacyOptions = JSON.parse(request.options_json ?? "[]") as Array<string | { value: string; label?: string; description?: string }>;
        questions = HumanRequestQuestionsSchema.parse([{
          id: "legacy-question",
          label: request.question,
          prompt: request.question,
          options: legacyOptions.map((option) => typeof option === "string"
            ? { value: option, label: option }
            : { ...option, label: option.label ?? option.value }),
          allowOther: legacyOptions.length === 0 || (request.answer !== null && !legacyOptions.some((option) =>
            (typeof option === "string" ? option : option.value) === request.answer)),
        }]);
      }
      const submitted = request.answers_json
        ? JSON.parse(request.answers_json) as Array<{ id?: string; value?: string }>
        : request.answer === null ? [] : [{ id: questions[0]!.id, value: request.answer }];
      if (submitted.length !== questions.length) return undefined;
      const byId = new Map(submitted.map((answer) => [answer.id, answer.value]));
      if (byId.size !== submitted.length || questions.some((question) => !byId.has(question.id))) return undefined;

      const answers: HumanRequestAnswer[] = [];
      for (const question of questions) {
        const value = byId.get(question.id);
        if (typeof value !== "string" || !value.trim()) return undefined;
        const optionIndex = question.options.findIndex((option) => option.value === value);
        if (optionIndex >= 0) {
          const option = question.options[optionIndex]!;
          answers.push({ id: question.id, value, label: option.label, wasCustom: false, index: optionIndex + 1 });
        } else if (question.allowOther) {
          answers.push({ id: question.id, value, label: value, wasCustom: true });
        } else {
          return undefined;
        }
      }
      return { questions, answers };
    } catch {
      return undefined;
    }
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
