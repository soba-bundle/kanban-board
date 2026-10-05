import { useCallback, useEffect, useRef, useState } from "react";
import type { CheckpointPreview, HumanRequest, HumanRequestAnswerInput, LiveCompactionSummary, LiveEvent, LiveHistoryEntry, LiveHistorySnapshot, QueueSnapshot, RunInput, Task, TaskRunSummary } from "@kanban-board/shared";
import { HandoverCard } from "./HandoverCard.js";
import { HumanRequestPanel } from "./HumanRequestPanel.js";
import { StartTaskDialog } from "./StartTaskDialog.js";
import { useToast } from "./ToastContext.js";
import { completeTask, loadTaskCompletionStatus } from "../board-api.js";
import {
  type TaskSyncCheck,
  type TaskSyncRecovery,
  abortTaskSync,
  checkTaskSync,
  answerHumanRequest,
  loadHumanRequests,
  loadLiveHistory,
  loadRuns,
  openRunEvents,
  steerRun,
  stopHumanRequest,
  loadCheckpointPreview,
  createCheckpoint,
  loadCheckpointDiff,
  loadMergePreview,
  startMerge,
  mergeAction,
  syncTaskWithBase,
  loadTaskSyncRecovery,
  viewTaskSyncConflicts,
  retryTaskSync,
} from "../ticket-api.js";

type Tab = "runs" | "live";

interface TicketPanelProps {
  task: Task;
  queue: QueueSnapshot | null;
  onClose: () => void;
  onChanged: () => void;
}

/** How often the panel re-reads the board while it has queued or active work. */
const ACTIVE_POLL_MS = 3000;
const DEVELOPER_TEST_REMINDER = "Before merging, test the app in the task worktree and review the implemented code and diff. Check sync verifies Git state only; it does not test the app.";

function formatProvisional(snapshot: LiveHistorySnapshot): string {
  let provisional = "";
  for (const event of snapshot.provisional_events) {
    if (event.type === "auto_retry_start") {
      provisional = "";
      continue;
    }
    provisional += describeEvent(event) ?? "";
  }
  return snapshot.provisional_truncated
    ? `${provisional}\n[Some recent live output is unavailable; refresh to load persisted history.]\n`
    : provisional;
}

function compactionSummaryFromEvent(event: LiveEvent, afterEntryId: string | null): LiveCompactionSummary | null {
  if (event.type !== "compaction_end") return null;
  const data = event.data as Record<string, unknown>;
  if (data.aborted || typeof data.summary !== "string" || !data.summary) return null;
  return {
    id: event.eventId,
    timestamp: event.timestamp,
    summary: data.summary,
    tokens_before: typeof data.tokensBefore === "number" ? data.tokensBefore : 0,
    after_entry_id: afterEntryId,
  };
}

function compactionState(snapshot: LiveHistorySnapshot): { active: boolean; error: string | null; summaries: LiveCompactionSummary[] } {
  let active = false;
  let error: string | null = null;
  const summaries = [...(snapshot.compaction_summaries ?? [])];
  const seenSummaries = new Set(summaries.map((summary) => summary.summary));
  for (const event of snapshot.provisional_events) {
    if (event.type === "compaction_start") {
      active = true;
      error = null;
    }
    if (event.type === "compaction_end") {
      active = false;
      const data = event.data as Record<string, unknown>;
      error = typeof data.errorMessage === "string" ? data.errorMessage : null;
      const summary = compactionSummaryFromEvent(event, snapshot.entries.at(-1)?.id ?? null);
      if (summary && !seenSummaries.has(summary.summary)) {
        seenSummaries.add(summary.summary);
        summaries.push(summary);
      }
    }
  }
  summaries.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return { active, error, summaries };
}

type LiveTimelineItem = { type: "entry"; entry: LiveHistoryEntry } | { type: "compaction"; summary: LiveCompactionSummary };

function buildLiveTimeline(entries: LiveHistoryEntry[], summaries: LiveCompactionSummary[]): LiveTimelineItem[] {
  const entryIds = new Set(entries.map((entry) => entry.id));
  const afterEntry = new Map<string, LiveCompactionSummary[]>();
  const unanchored: LiveCompactionSummary[] = [];
  for (const summary of summaries) {
    const anchor = summary.after_entry_id;
    if (!anchor || !entryIds.has(anchor)) {
      unanchored.push(summary);
      continue;
    }
    const matching = afterEntry.get(anchor) ?? [];
    matching.push(summary);
    afterEntry.set(anchor, matching);
  }

  const timeline: LiveTimelineItem[] = [];
  for (const entry of entries) {
    timeline.push({ type: "entry", entry });
    for (const summary of afterEntry.get(entry.id) ?? []) timeline.push({ type: "compaction", summary });
  }
  for (const summary of unanchored) {
    const nextEntry = timeline.findIndex((item) => item.type === "entry" && item.entry.timestamp > summary.timestamp);
    timeline.splice(nextEntry < 0 ? timeline.length : nextEntry, 0, { type: "compaction", summary });
  }
  return timeline;
}

function textContent(entry: LiveHistoryEntry): string {
  const message = entry.message as { content?: unknown };
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((part): part is { type: string; text: string } =>
    !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text).join("");
}

function diffSections(diff: string): string[] {
  return diff.split(/(?=^diff --git )/m).filter((section) => section.startsWith("diff --git "));
}

function sideBySideLines(diff: string): Array<{ left: string; right: string }> {
  return diff.split("\n").map((line) => ({
    left: line.startsWith("+") && !line.startsWith("+++") ? "" : line.startsWith("-") && !line.startsWith("---") ? line : line,
    right: line.startsWith("-") && !line.startsWith("---") ? "" : line.startsWith("+") && !line.startsWith("+++") ? line : line,
  }));
}

function inputStatusLabel(status: string): string {
  return ({ PENDING: "Pending", ACCEPTED: "Accepted by Pi", DELIVERED: "Delivered", UNDELIVERED: "Undelivered",
    DELIVERY_UNKNOWN: "Delivery unknown", CANCELLED: "Cancelled" } as Record<string, string>)[status] ?? status;
}

export function LiveMessageCard({ entry, input }: { entry: LiveHistoryEntry; input?: RunInput }) {
  const message = entry.message as { role?: string; toolName?: string; content?: unknown; provider?: string; model?: string; usage?: Record<string, unknown> };
  const parts = Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : [];
  const reasoning = parts.filter((part) => part.type === "thinking").map((part) => String(part.thinking ?? "")).filter(Boolean);
  const toolCalls = parts.filter((part) => part.type === "toolCall");
  const role = entry.role === "user" ? "You" : entry.role === "assistant" ? "Agent" : `Tool: ${message.toolName ?? entry.role}`;
  const usage = message.usage ?? {};
  const tokens = [
    typeof usage.input === "number" ? `in ${usage.input}` : null,
    typeof usage.output === "number" ? `out ${usage.output}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <article className={`live-message live-message-${entry.role}`}>
      <header className="live-message-header">
        <strong>{role}</strong>
        <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString()}</time>
        {input && <span className={`input-status input-status-${input.delivery_status.toLowerCase()}`} title={input.failure_reason ?? undefined}>{inputStatusLabel(input.delivery_status)}</span>}
      </header>
      {entry.role !== "tool" && textContent(entry) && <p className="live-message-text">{textContent(entry)}</p>}
      {reasoning.length > 0 && <details className="live-details"><summary>Reasoning</summary><p>{reasoning.join("\n")}</p></details>}
      {toolCalls.length > 0 && <details className="live-details"><summary>Tool calls ({toolCalls.length})</summary>
        {toolCalls.map((call, index) => <pre key={index}>{String(call.name ?? "tool")} {JSON.stringify(call.arguments ?? {})}</pre>)}
      </details>}
      {entry.role === "tool" && textContent(entry) && <details className="live-details"><summary>Tool result</summary><pre>{textContent(entry)}</pre></details>}
      {(message.provider || message.model || tokens) && <footer className="live-message-meta">
        {[message.provider, message.model, tokens].filter(Boolean).join(" · ")}{tokens ? " tokens" : ""}
      </footer>}
    </article>
  );
}

function describeEvent(event: LiveEvent): string | null {
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case "message_update":
      return typeof data.delta === "string" ? data.delta : null;
    case "tool_execution_start":
      return `\n[tool] ${String(data.toolName ?? "unknown")}\n`;
    default:
      return null;
  }
}

export function TicketPanel({ task, queue, onClose, onChanged }: TicketPanelProps) {
  const [runs, setRuns] = useState<TaskRunSummary[]>([]);
  const [runsTaskId, setRunsTaskId] = useState<string | null>(null);
  const [humanRequests, setHumanRequests] = useState<HumanRequest[]>([]);
  const [humanRequestError, setHumanRequestError] = useState<string | null>(null);
  const [humanRequestBusy, setHumanRequestBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("live");
  const [draft, setDraft] = useState("");
  const [draftInputId, setDraftInputId] = useState<string | null>(null);
  const [reuseInputId, setReuseInputId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [startingRun, setStartingRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveLog, setLiveLog] = useState("");
  const [liveHistory, setLiveHistory] = useState<LiveHistorySnapshot | null>(null);
  const [compactionActive, setCompactionActive] = useState(false);
  const [compactionError, setCompactionError] = useState<string | null>(null);
  const [compactionSummaries, setCompactionSummaries] = useState<LiveCompactionSummary[]>([]);
  const [streamState, setStreamState] = useState<"idle" | "open" | "closed" | "error">("idle");
  const [historyRecoveryFailed, setHistoryRecoveryFailed] = useState(false);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [checkpointPreview, setCheckpointPreview] = useState<CheckpointPreview | null>(null);
  const [selectedCheckpointFile, setSelectedCheckpointFile] = useState(0);
  const [checkpointStatus, setCheckpointStatus] = useState<CheckpointPreview | null>(null);
  const [checkpointStatusTaskId, setCheckpointStatusTaskId] = useState<string | null>(null);
  const [reviewDiffOpen, setReviewDiffOpen] = useState(false);
  const [selectedReviewFile, setSelectedReviewFile] = useState(0);
  const [checkpointStatusError, setCheckpointStatusError] = useState<string | null>(null);
  const [completionStatus, setCompletionStatus] = useState<{
    ready: boolean; reason: "WORKTREE_CHANGES" | "BRANCH_CHANGES" | "GIT_STATE_UNAVAILABLE" | null;
  } | null>(null);
  const [completionStatusError, setCompletionStatusError] = useState<string | null>(null);
  const [checkpointedSha, setCheckpointedSha] = useState<string | null>(null);
  const [checkpointDiff, setCheckpointDiff] = useState<{ files: string[]; diff: string; to_sha: string; from_sha?: string } | null>(null);
  const [selectedDiffFile, setSelectedDiffFile] = useState(0);
  const [diffView, setDiffView] = useState<"unified" | "side-by-side">("unified");
  const [mergePreview, setMergePreview] = useState<Awaited<ReturnType<typeof loadMergePreview>> | null>(null);
  const [mergeConfirmation, setMergeConfirmation] = useState(false);
  const [mergeStatus, setMergeStatus] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<{
    taskId: string; status: "SYNCED"; synced_base_sha: string; candidate_sha: string;
  } | null>(null);
  const [syncCheck, setSyncCheck] = useState<TaskSyncCheck | null>(null);
  const [syncCheckTaskId, setSyncCheckTaskId] = useState<string | null>(null);
  const [syncCheckError, setSyncCheckError] = useState<string | null>(null);
  const [syncRecovery, setSyncRecovery] = useState<TaskSyncRecovery | null>(null);
  const [syncRecoveryTaskId, setSyncRecoveryTaskId] = useState<string | null>(null);
  const [syncRecoveryError, setSyncRecoveryError] = useState<string | null>(null);
  const [syncAbortConfirmation, setSyncAbortConfirmation] = useState(false);
  const diffRequestIdRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const liveCursorRef = useRef(0);
  const liveTaskIdRef = useRef(task.id);
  liveTaskIdRef.current = task.id;
  const { pushToast } = useToast();

  const activeJob = queue?.jobs.find((job) => job.task_id === task.id);
  const runningRunId = activeJob?.run_status === "RUNNING" ? activeJob.run_id : null;
  const canStartRun = task.workflow_state === "TODO" || (task.workflow_state === "REVIEW" &&
    ["WORK_COMPLETE", "INVESTIGATION_COMPLETE", "IMPLEMENTATION_COMPLETE", "VALIDATION_ISSUES", "VALIDATION_FAILED",
      "READY_TO_MERGE", "RUN_FAILED", "INTERRUPTED"].includes(task.review_tag ?? ""));
  const currentCheckpointStatus = checkpointStatusTaskId === task.id ? checkpointStatus : null;
  const currentRuns = runsTaskId === task.id ? runs : [];
  const canReviewAction = task.workflow_state === "REVIEW" &&
    ["WORK_COMPLETE", "INVESTIGATION_COMPLETE", "IMPLEMENTATION_COMPLETE", "RUN_FAILED", "INTERRUPTED", "VALIDATION_FAILED", "VALIDATION_ISSUES", "READY_TO_MERGE", "MERGE_CONFLICT"].includes(task.review_tag ?? "");
  const canCheckpoint = task.workflow_state === "REVIEW" &&
    ["WORK_COMPLETE", "INVESTIGATION_COMPLETE", "IMPLEMENTATION_COMPLETE", "VALIDATION_FAILED",
      "VALIDATION_ISSUES", "READY_TO_MERGE"].includes(task.review_tag ?? "");
  const needsCheckpointPreview = canCheckpoint;
  const latestCheckpointSha = checkpointedSha ?? task.latest_task_commit_sha;
  const checkpointHasChanges = !!currentCheckpointStatus &&
    (currentCheckpointStatus.tracked_changes.length > 0 || currentCheckpointStatus.untracked_files.length > 0);
  const visibleReviewTag = ["READY_TO_MERGE", "VALIDATION_FAILED", "VALIDATION_ISSUES"].includes(task.review_tag ?? "")
    ? "WORK_COMPLETE" : task.review_tag;
  const showMergeControls = task.workflow_state === "REVIEW";
  const currentSyncResult = syncResult?.taskId === task.id ? syncResult : null;
  const currentSyncCheck = syncCheckTaskId === task.id ? syncCheck : null;
  const currentSyncRecovery = syncRecoveryTaskId === task.id ? syncRecovery : null;
  const latestWorkRun = currentRuns.slice().reverse().find((item) => item.status === "COMPLETED" && item.stage !== "VALIDATION_REVIEW");
  const ordinaryResponse = latestWorkRun && liveHistory?.task_id === task.id
    ? liveHistory.entries.filter((entry) => entry.run_id === latestWorkRun.id && entry.role === "assistant")
      .map(textContent).filter(Boolean).slice(-1)[0] ?? ""
    : "";
  const reviewFiles = currentCheckpointStatus
    ? [...currentCheckpointStatus.tracked_changes, ...currentCheckpointStatus.untracked_files]
    : [];
  const reviewPatches = currentCheckpointStatus ? diffSections(currentCheckpointStatus.diff ?? "") : [];
  const selectedReviewPatch = reviewPatches[selectedReviewFile] ?? "";
  const checkpointPreviewFiles = checkpointPreview
    ? [...checkpointPreview.tracked_changes, ...checkpointPreview.untracked_files]
    : [];
  const checkpointPreviewPatches = checkpointPreview ? diffSections(checkpointPreview.diff ?? "") : [];
  const selectedCheckpointPatch = checkpointPreviewPatches[selectedCheckpointFile] ?? "";
  const diffPatches = checkpointDiff ? diffSections(checkpointDiff.diff) : [];
  const selectedDiffPatch = checkpointDiff?.files.length ? diffPatches[selectedDiffFile] ?? "" : checkpointDiff?.diff ?? "";

  const refresh = useCallback(async () => {
    try {
      const nextRuns = await loadRuns(task.id);
      if (!mountedRef.current || liveTaskIdRef.current !== task.id) return;
      setRuns(nextRuns);
      setRunsTaskId(task.id);
      setError(null);
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [task.id]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refreshHumanRequests = useCallback(async () => {
    try {
      const nextRequests = await loadHumanRequests(task.id);
      if (!mountedRef.current || liveTaskIdRef.current !== task.id) return;
      setHumanRequests(nextRequests);
      setHumanRequestError(null);
    } catch (caught) {
      if (mountedRef.current && liveTaskIdRef.current === task.id) {
        setHumanRequestError(caught instanceof Error ? caught.message : String(caught));
      }
    }
  }, [task.id]);

  useEffect(() => {
    setHumanRequests([]);
    void refreshHumanRequests();
  }, [refreshHumanRequests]);

  useEffect(() => {
    if (!activeJob && task.workflow_state !== "REQUIRES_HUMAN") return;
    const timer = setInterval(() => { void refreshHumanRequests(); }, ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [activeJob, humanRequests, refreshHumanRequests, task.workflow_state]);

  function applyLiveHistorySnapshot(snapshot: LiveHistorySnapshot) {
    setLiveHistory(snapshot);
    setLiveLog(formatProvisional(snapshot));
    const compaction = compactionState(snapshot);
    setCompactionActive(compaction.active);
    setCompactionError(compaction.error);
    setCompactionSummaries(compaction.summaries);
  }

  async function refreshLiveHistory() {
    const snapshot = await loadLiveHistory(task.id);
    if (!mountedRef.current || liveTaskIdRef.current !== task.id) return;
    applyLiveHistorySnapshot(snapshot);
  }

  useEffect(() => {
    setRuns([]);
    setRunsTaskId(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!activeJob && !runs.some((item) => item.status === "QUEUED" || item.status === "RUNNING")) return;
    const timer = setInterval(() => { void refresh(); }, ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [activeJob, refresh, runs]);

  useEffect(() => {
    setCompletionStatus(null);
    setCompletionStatusError(null);
    if (task.workflow_state !== "REVIEW") return;
    let current = true;
    const load = () => {
      void loadTaskCompletionStatus(task.id).then((status) => {
        if (current) {
          setCompletionStatus(status);
          setCompletionStatusError(null);
        }
      }).catch((caught) => {
        if (current) {
          setCompletionStatus(null);
          setCompletionStatusError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { current = false; clearInterval(timer); };
  }, [task.id, task.workflow_state]);

  useEffect(() => {
    setCheckpointedSha(null);
    setCheckpointStatus(null);
    setCheckpointStatusTaskId(null);
    setCheckpointStatusError(null);
    if (!needsCheckpointPreview) return;
    let current = true;
    const load = () => {
      void loadCheckpointPreview(task.id).then((preview) => {
        if (current) {
          setCheckpointStatus(preview);
          setCheckpointStatusTaskId(task.id);
          setCheckpointStatusError(null);
        }
      }).catch((caught) => {
        if (current) {
          setCheckpointStatus(null);
          setCheckpointStatusTaskId(task.id);
          setCheckpointStatusError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { current = false; clearInterval(timer); };
  }, [needsCheckpointPreview, task.id, task.latest_task_commit_sha]);

  useEffect(() => {
    setReviewDiffOpen(false);
    setSelectedReviewFile(0);
  }, [task.id]);

  useEffect(() => {
    let current = true;
    setMergePreview(null);
    setMergeStatus(null);
    setMergeConfirmation(false);
    diffRequestIdRef.current++;
    setCheckpointDiff(null);
    if (task.workflow_state !== "REVIEW") return;
    void loadMergePreview(task.id).then((preview) => { if (current) setMergePreview(preview); })
      .catch((caught) => { if (current) setMergePreview({ eligible: false, reason: caught instanceof Error ? caught.message : String(caught) }); });
    return () => { current = false; };
  }, [task.id, task.workflow_state, task.base_branch, task.base_commit_sha, task.latest_task_commit_sha, task.review_tag]);

  useEffect(() => {
    setSyncCheck(null);
    setSyncCheckTaskId(null);
  }, [task.id, task.base_commit_sha, task.latest_task_commit_sha]);

  useEffect(() => {
    let current = true;
    setSyncRecovery(null);
    setSyncRecoveryTaskId(null);
    setSyncRecoveryError(null);
    setSyncAbortConfirmation(false);
    if (task.workflow_state !== "REVIEW" || !task.worktree_path) return;
    void loadTaskSyncRecovery(task.id).then((result) => {
      if (!current) return;
      setSyncRecovery(result.recovery ?? null);
      setSyncRecoveryTaskId(task.id);
    }).catch((caught) => {
      if (!current) return;
      setSyncRecoveryError(caught instanceof Error ? caught.message : String(caught));
      setSyncRecoveryTaskId(task.id);
    });
    return () => { current = false; };
  }, [task.id, task.workflow_state, task.worktree_path]);

  useEffect(() => {
    let current = true;
    setLiveHistory(null);
    setLiveLog("");
    setCompactionActive(false);
    setCompactionError(null);
    setCompactionSummaries([]);
    setHistoryRecoveryFailed(false);
    void loadLiveHistory(task.id).then((snapshot) => {
      if (!current) return;
      liveCursorRef.current = snapshot.active_run_id === runningRunId ? snapshot.cursor : 0;
      applyLiveHistorySnapshot(snapshot);
      setHistoryRecoveryFailed(false);
      setError(null);
    }).catch((caught) => {
      if (!current) return;
      setHistoryRecoveryFailed(true);
      setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => { current = false; };
  }, [task.id, runningRunId, historyRetry]);

  useEffect(() => {
    if (!runningRunId || !liveHistory || liveHistory.task_id !== task.id) return;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;
    let delay = 250;
    let recovering = false;
    let reconnectSuppressed = false;
    let recoveryAttempts = 0;
    let historyRetryTimer: ReturnType<typeof setTimeout> | undefined;
    const cursor = liveHistory.active_run_id === runningRunId ? liveHistory.cursor : 0;
    liveCursorRef.current = Math.max(liveCursorRef.current, cursor);
    const recoverHistory = () => {
      if (recovering || disposed) return;
      recovering = true;
      reconnectSuppressed = true;
      socket?.close();
      void loadLiveHistory(task.id).then((snapshot) => {
        if (disposed) return;
        recoveryAttempts = 0;
        liveCursorRef.current = snapshot.active_run_id === runningRunId ? snapshot.cursor : 0;
        applyLiveHistorySnapshot(snapshot);
        setHistoryRecoveryFailed(false);
        setError(null);
      }).catch((caught) => {
        if (disposed) return;
        recoveryAttempts++;
        setError(caught instanceof Error ? caught.message : String(caught));
        if (recoveryAttempts >= 3) setHistoryRecoveryFailed(true);
        else historyRetryTimer = setTimeout(recoverHistory, 250 * 2 ** (recoveryAttempts - 1));
      }).finally(() => { recovering = false; });
    };

    const connect = () => {
      if (disposed) return;
      setStreamState("idle");
      socket = openRunEvents(task.id, runningRunId, (event) => {
        if (disposed || recovering || liveTaskIdRef.current !== task.id) return;
        if (event.type === "replay_gap") {
          recoverHistory();
          return;
        }
        if (event.sequence <= liveCursorRef.current) return;
        if (event.sequence > liveCursorRef.current + 1 && liveCursorRef.current > 0) {
          recoverHistory();
          return;
        }
        liveCursorRef.current = event.sequence;
        if (event.type === "compaction_start") {
          setCompactionActive(true);
          setCompactionError(null);
        }
        if (event.type === "compaction_end") {
          setCompactionActive(false);
          const data = event.data as Record<string, unknown>;
          setCompactionError(typeof data.errorMessage === "string" ? data.errorMessage : null);
          const summary = compactionSummaryFromEvent(event, liveHistory.entries.at(-1)?.id ?? null);
          if (summary) setCompactionSummaries((current) => {
            if (current.some((item) => item.summary === summary.summary)) return current;
            return [...current, summary].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
          });
        }
        if (event.type === "auto_retry_start") setLiveLog("");
        const text = describeEvent(event);
        if (text) setLiveLog((value) => value + text);
        if (event.type === "run_input_status") {
          void refresh();
          void refreshLiveHistory().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
        }
      }, liveCursorRef.current);
      socket.addEventListener("open", () => {
        delay = 250;
        setStreamState("open");
      });
      socket.addEventListener("error", () => setStreamState("error"));
      socket.addEventListener("close", () => {
        if (disposed) return;
        setStreamState((value) => value === "error" ? value : "closed");
        if (reconnectSuppressed) return;
        reconnectTimer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 4000);
      });
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (historyRetryTimer) clearTimeout(historyRetryTimer);
      socket?.close();
    };
  }, [runningRunId, liveHistory, task.id, refresh]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [liveLog, liveHistory]);

  // Without this, a run that starts while the panel is open would never stream,
  // because the run id only appears once the queue snapshot is refetched.
  useEffect(() => {
    if (!activeJob) return;
    const timer = setInterval(onChanged, ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [activeJob, onChanged]);

  async function run(action: () => Promise<unknown>, successTitle?: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      onChanged();
      if (successTitle) pushToast({ title: successTitle, variant: "success" });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      pushToast({ title: "Action failed", description: message, variant: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function refreshSyncRecovery() {
    const taskId = task.id;
    const result = await loadTaskSyncRecovery(taskId);
    if (!mountedRef.current || liveTaskIdRef.current !== taskId) return;
    setSyncRecovery(result.recovery ?? null);
    setSyncRecoveryTaskId(taskId);
    setSyncRecoveryError(null);
  }

  async function openCheckpointDiff() {
    const requestId = ++diffRequestIdRef.current;
    const taskId = task.id;
    setSelectedDiffFile(0);
    setDiffView("unified");
    setCheckpointDiff({ files: [], diff: "", to_sha: task.latest_task_commit_sha ?? "", from_sha: task.base_commit_sha ?? "" });
    try {
      const result = await loadCheckpointDiff(taskId);
      if (diffRequestIdRef.current === requestId && liveTaskIdRef.current === taskId) setCheckpointDiff(result);
    } catch (caught) {
      if (diffRequestIdRef.current === requestId && liveTaskIdRef.current === taskId) {
        setCheckpointDiff(null);
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }
  }

  async function prepareMergeConfirmation() {
    const taskId = task.id;
    setBusy(true);
    setMergeStatus(null);
    try {
      const preview = await loadMergePreview(taskId);
      if (liveTaskIdRef.current !== taskId) return;
      setMergePreview(preview);
      if (preview.eligible && preview.preview_id) setMergeConfirmation(true);
      else setMergeStatus(preview.reasons?.join(" ") ?? preview.reason ?? "Check sync before merging.");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setMergeStatus(message);
      pushToast({ title: "Merge preview failed", description: message, variant: "danger" });
    } finally { setBusy(false); }
  }

  async function runMergeAction(action: "start" | "abort" | "retry" | "view-conflicts") {
    setBusy(true);
    setMergeStatus(null);
    try {
      let result;
      if (action === "start") {
        const previewId = mergePreview?.preview_id;
        if (!previewId) throw new Error("Refresh Check sync before confirming merge.");
        result = await startMerge(task.id, previewId);
      } else {
        result = await mergeAction(task.id, action);
      }
      setMergeConfirmation(false);
      setMergeStatus(result.status === "MERGED" ? "Merged successfully." :
        result.status === "CHECK_SYNC_REQUIRED" ? "Conflict resolution was committed. Check sync and confirm merge again." :
          result.status === "ABORTED" ? "Merge aborted; task changes were preserved." :
            result.status === "OPENED" ? "Opened the task worktree in the IDE." : `Merge status: ${result.status}`);
      if (action === "start" || action === "abort") onChanged();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (action === "start") setMergeConfirmation(false);
      setMergeStatus(message);
      pushToast({ title: "Merge action failed", description: message, variant: "danger" });
    } finally { setBusy(false); }
  }

  const activeHumanRequest = humanRequests.find((request) => request.status === "PENDING") ?? humanRequests.slice().reverse()[0];
  const waitingForHuman = activeHumanRequest?.status === "PENDING";

  async function submitHumanAnswers(answers: HumanRequestAnswerInput[]) {
    if (!activeHumanRequest || !waitingForHuman) return;
    setHumanRequestBusy(true);
    setHumanRequestError(null);
    try {
      const updated = await answerHumanRequest(activeHumanRequest.id, answers);
      if (!mountedRef.current) return;
      setHumanRequests((current) => current.map((request) => request.id === updated.id ? updated : request));
      await refreshHumanRequests();
      await refreshLiveHistory();
      onChanged();
    } catch (caught) {
      if (mountedRef.current) setHumanRequestError(caught instanceof Error ? caught.message : String(caught));
      await refreshHumanRequests();
    } finally {
      if (mountedRef.current) setHumanRequestBusy(false);
    }
  }

  async function stopWaitingForHuman() {
    if (!activeHumanRequest || !waitingForHuman) return;
    setHumanRequestBusy(true);
    setHumanRequestError(null);
    try {
      await stopHumanRequest(activeHumanRequest.id);
      if (!mountedRef.current) return;
      setHumanRequests((current) => current.map((request) => request.id === activeHumanRequest.id
        ? { ...request, status: "CANCELLED" } : request));
      onChanged();
    } catch (caught) {
      if (mountedRef.current) setHumanRequestError(caught instanceof Error ? caught.message : String(caught));
      await refreshHumanRequests();
    } finally {
      if (mountedRef.current) setHumanRequestBusy(false);
    }
  }

  const history = liveHistory?.task_id === task.id ? liveHistory : null;
  const latestRun = runsTaskId === task.id
    ? runs.reduce<TaskRunSummary | null>((latest, run) => !latest || run.sequence > latest.sequence ? run : latest, null)
    : null;
  const persistedRunError = latestRun?.status === "FAILED" ? latestRun.error_message : null;
  const transcriptInputByEntry = new Map((history?.inputs ?? [])
    .filter((input) => input.transcript_entry_id && input.session_id)
    .map((input) => [`${input.session_id}:${input.transcript_entry_id}`, input]));
  const representedInputIds = new Set((history?.entries ?? [])
    .map((entry) => transcriptInputByEntry.get(`${entry.session_id}:${entry.entry_id}`)?.id)
    .filter((id): id is string => !!id));
  const unattachedInputs = (history?.inputs ?? []).filter((input) => !representedInputIds.has(input.id));

  function reuseInput(input: RunInput) {
    if (activeJob) {
      void run(async () => {
        await steerRun(activeJob.run_id, crypto.randomUUID(), input.content, input.id);
        await refreshLiveHistory();
      }, "Guidance reused as a new input");
      return;
    }
    setDraft(input.content);
    setDraftInputId(null);
    setReuseInputId(input.id);
    setStartingRun(true);
  }

  function submitDraft() {
    if (waitingForHuman) return;
    const text = draft.trim();
    if (!text) return;
    if (activeJob) {
      const inputId = draftInputId ?? crypto.randomUUID();
      setDraftInputId(inputId);
      setReuseInputId(null);
      void run(async () => {
        await steerRun(activeJob.run_id, inputId, text);
        await refreshLiveHistory();
        setDraft("");
        setDraftInputId(null);
      }, activeJob.run_status === "RUNNING" ? "Guidance accepted" : "Guidance added to queued run");
      return;
    }
    if (!canStartRun) return;
    setStartingRun(true);
  }

  return (
    <div className="panel-backdrop" onClick={onClose}>
      <aside className="ticket-panel" onClick={(event) => event.stopPropagation()} aria-label={`Ticket ${task.title}`}>
        <header className="ticket-panel-header">
          <div className="ticket-panel-heading">
            <span className="ticket-state">{task.workflow_state.replaceAll("_", " ")}</span>
            {visibleReviewTag && <span className="review-tag">{visibleReviewTag.replaceAll("_", " ")}</span>}
            <h2>{task.title}</h2>
          </div>
          <button className="icon-button" aria-label="Close ticket" onClick={onClose}>×</button>
        </header>

        <nav className="ticket-tabs">
          {(["live", "runs"] as Tab[]).map((value) => (
            <button
              key={value}
              className={`ticket-tab${tab === value ? " ticket-tab-active" : ""}`}
              onClick={() => setTab(value)}
            >
              {value === "runs" ? `Runs (${runs.length})` : "Live"}
            </button>
          ))}
        </nav>

        <div className="ticket-panel-body" ref={logRef}>
          {error && <div className="error-banner" role="alert"><span>{error}</span></div>}

          {tab === "live" && (
            <>
              <section className="ticket-section live-task-context">
                <p className="ticket-description">{task.description || "No description."}</p>
              </section>
              {showMergeControls && <aside className="developer-test-reminder" role="note" aria-label="Developer testing reminder">
                {DEVELOPER_TEST_REMINDER}
              </aside>}
              {canCheckpoint && checkpointStatusTaskId === task.id && checkpointHasChanges && (
                <section className="ticket-section changes-review-card" aria-labelledby="changes-review-title">
                  <h3 id="changes-review-title">Changes to review</h3>
                  {ordinaryResponse
                    ? <p className="changes-review-summary">{ordinaryResponse.length > 420 ? `${ordinaryResponse.slice(0, 420).trimEnd()}…` : ordinaryResponse}</p>
                    : <p className="changes-review-summary">Review the changed files before updating the checkpoint.</p>}
                  <p><strong>Changed files</strong></p>
                  <ul>{reviewFiles.map((file) => <li key={file}>{file}</li>)}</ul>
                  <button className="button-primary" onClick={() => { setSelectedReviewFile(0); setReviewDiffOpen(true); }}>Preview changes</button>
                </section>
              )}
              {canReviewAction && (
                <section className="ticket-section review-actions">
                  <p className="ticket-section-title">Next step</p>
                  {checkpointStatusError && <p className="error-banner" role="alert">{checkpointStatusError}</p>}
                  {syncRecoveryError && syncRecoveryTaskId === task.id && <p className="run-error" role="alert">Cannot inspect sync recovery: {syncRecoveryError}</p>}
                  {currentSyncResult?.status === "SYNCED" && <p className="run-empty" role="status">
                    Synced main at {currentSyncResult.synced_base_sha.slice(0, 12)} into task commit {currentSyncResult.candidate_sha.slice(0, 12)}.
                  </p>}
                  {currentSyncCheck && <p className={currentSyncCheck.status === "IN_SYNC" ? "run-empty" : "run-error"}
                    role={currentSyncCheck.status === "IN_SYNC" ? "status" : "alert"}>
                    {currentSyncCheck.status === "IN_SYNC" ?
                      `Git state was in sync with base ${currentSyncCheck.base_sha?.slice(0, 12)} at task commit ${currentSyncCheck.task_sha?.slice(0, 12)} when checked at ${new Date(currentSyncCheck.checked_at).toLocaleTimeString()}. Recheck after Git changes.` :
                      currentSyncCheck.status === "STALE" ?
                        `The current base ${currentSyncCheck.base_sha?.slice(0, 12)} is not in the task history. Use Sync with main, then check again.` :
                        `Git sync check is blocked: ${currentSyncCheck.reasons.join(" ")}`}
                    {currentSyncCheck.base_moved && ` The base moved from recorded ${currentSyncCheck.recorded_base_sha?.slice(0, 12)} to ${currentSyncCheck.base_sha?.slice(0, 12)}.`}
                    {" This is a Git-state check only, not application testing or code review."}
                  </p>}
                  {currentSyncRecovery && <p className={currentSyncRecovery.state === "CONFLICT" ? "run-error" : "run-empty"}
                    role={currentSyncRecovery.state === "CONFLICT" ? "alert" : "status"}>
                    {currentSyncRecovery.state === "CONFLICT" ? `Sync stopped on conflicts. Git state is preserved; resolve and commit the conflict before continuing.${currentSyncRecovery.can_abort ? "" : " Abort is unavailable because the conflict snapshot is missing or changed."}` :
                      currentSyncRecovery.state === "RESOLUTION_COMMITTED" ? "The manual conflict resolution is committed and ready to finish sync." :
                        currentSyncRecovery.state === "SAFE_TO_RETRY" ? "No merge is in progress and the task branch is unchanged; explicit Retry will start a fresh sync." :
                          `Sync was interrupted and Git state needs inspection. ${currentSyncRecovery.error_message ?? "Preserve the worktree and inspect it before continuing."}`}
                  </p>}
                  <div className="dialog-actions">
                    {showMergeControls && <button className="button-quiet" disabled={busy} onClick={() => void run(async () => {
                      const taskId = task.id;
                      setSyncCheck(null);
                      setSyncCheckTaskId(null);
                      const result = await checkTaskSync(taskId);
                      if (liveTaskIdRef.current !== taskId) return;
                      setSyncCheck(result);
                      setSyncCheckTaskId(taskId);
                    })}>Check sync</button>}
                    {currentSyncRecovery ? <>
                      <button className="button-quiet" disabled={busy} onClick={() => void run(async () => {
                        await viewTaskSyncConflicts(task.id);
                      })}>{currentSyncRecovery.state === "CONFLICT" ? "View Conflicts" : "Open task worktree"}</button>
                      {(currentSyncRecovery.state === "RESOLUTION_COMMITTED" || currentSyncRecovery.state === "SAFE_TO_RETRY") &&
                        <button className="button-primary" disabled={busy} onClick={() => void run(async () => {
                          const taskId = task.id;
                          setSyncCheck(null);
                          setSyncCheckTaskId(null);
                          const result = await retryTaskSync(taskId);
                          if (liveTaskIdRef.current !== taskId) return;
                          if (result.status === "SYNCED") {
                            setSyncRecovery(null);
                            setSyncRecoveryTaskId(taskId);
                            setSyncResult({ taskId, status: "SYNCED",
                              synced_base_sha: result.synced_base_sha,
                              candidate_sha: result.candidate_sha });
                          } else {
                            await refreshSyncRecovery();
                          }
                        }, "Sync recovered")}>{currentSyncRecovery.state === "RESOLUTION_COMMITTED" ? "Finish sync" : "Retry Sync"}</button>}
                      {currentSyncRecovery.can_abort && (currentSyncRecovery.state === "CONFLICT" || currentSyncRecovery.state === "INTERRUPTED") &&
                        <button className="button-quiet" disabled={busy} onClick={() => setSyncAbortConfirmation(true)}>
                          {currentSyncRecovery.state === "CONFLICT" ? "Abort sync" : "Clear sync recovery"}
                        </button>}
                      <button className="button-quiet" disabled={busy} onClick={() => void run(refreshSyncRecovery)}>Refresh recovery</button>
                    </> : showMergeControls && task.base_branch && task.worktree_path && <button className="button-quiet"
                      disabled={busy}
                      onClick={() => void run(async () => {
                        const taskId = task.id;
                        setSyncCheck(null);
                        setSyncCheckTaskId(null);
                        const result = await syncTaskWithBase(taskId);
                        if (liveTaskIdRef.current !== taskId) return;
                        if (result.status === "CONFLICT") {
                          setSyncResult(null);
                          await refreshSyncRecovery();
                        } else {
                          setSyncResult({ taskId, ...result });
                        }
                      })}>Sync with main</button>}
                    {canCheckpoint && (checkpointStatus === null ? (
                      <button className="button-primary" disabled>Checking worktree…</button>
                    ) : checkpointHasChanges ? (
                      <button className="button-primary" disabled={busy} onClick={() => void run(async () => {
                        setSelectedCheckpointFile(0);
                        setCheckpointPreview(await loadCheckpointPreview(task.id));
                      })}>Update checkpoint</button>
                    ) : latestCheckpointSha ? (
                      <span className="run-empty">Checkpoint {latestCheckpointSha.slice(0, 12)} is ready for review.</span>
                    ) : (
                      <span className="run-empty">No changes to checkpoint.</span>
                    ))}
                    <button className="button-quiet" disabled={busy} onClick={() => setStartingRun(true)}>Start run</button>
                    {showMergeControls && task.review_tag !== "MERGE_CONFLICT" && <>
                      <button className="button-primary" disabled={busy || mergePreview?.eligible !== true || !mergePreview.preview_id}
                        title={mergePreview?.reasons?.join(" ") ?? mergePreview?.reason ?? undefined}
                        onClick={() => void prepareMergeConfirmation()}>Merge back to working branch</button>
                      {mergePreview?.eligible !== true && <span className="run-error">
                        {(mergePreview?.reasons?.join(" ") ?? mergePreview?.reason ?? "Check sync before merging.").replaceAll("_", " ")}
                      </span>}
                    </>}
                    {mergeStatus && <p className="run-empty" role="status">{mergeStatus}</p>}

                    {completionStatus?.ready ? (
                      <button className="button-primary" disabled={busy || !!activeJob} onClick={() => void run(async () => {
                        await completeTask(task.id);
                      }, "Task marked as done")}>Mark as done</button>
                    ) : completionStatus?.reason === "BRANCH_CHANGES" ? (
                      <button className="button-quiet" disabled>Merge back to source (unavailable until Phase 9)</button>
                    ) : completionStatus?.reason === "WORKTREE_CHANGES" ? (
                      <span className="run-error">Commit or discard Git changes before marking this task as done.</span>
                    ) : completionStatus?.reason === "GIT_STATE_UNAVAILABLE" ? (
                      <span className="run-error">Git state could not be verified; this task cannot be marked as done.</span>
                    ) : completionStatusError ? (
                      <span className="run-error">Cannot verify task Git state: {completionStatusError}</span>
                    ) : <button className="button-quiet" disabled>Checking Git status…</button>}
                    {showMergeControls && task.review_tag === "MERGE_CONFLICT" && <>
                      <button className="button-quiet" disabled={busy} onClick={() => void runMergeAction("view-conflicts")}>View Conflicts</button>
                      <button className="button-quiet" disabled={busy} onClick={() => void runMergeAction("retry")}>Retry</button>
                      <button className="button-quiet" disabled={busy} onClick={() => void runMergeAction("abort")}>Abort merge</button>
                    </>}
                    <button className="button-quiet" disabled={busy} onClick={() => void openCheckpointDiff()}>View checkpoint diff</button>
                  </div>
                </section>
              )}
            </>
          )}

          {reviewDiffOpen && currentCheckpointStatus && (
            <div className="dialog-backdrop" role="presentation">
              <section className="dialog checkpoint-diff-dialog" role="dialog" aria-modal="true" aria-labelledby="changes-review-dialog-title" onClick={(event) => event.stopPropagation()}>
                <h2 id="changes-review-dialog-title">Changes to review</h2>
                <div className="checkpoint-diff-files" aria-label="Changed files">
                  {reviewFiles.map((file, index) => <button key={`${index}:${file}`} className="button-quiet"
                    aria-pressed={selectedReviewFile === index} onClick={() => setSelectedReviewFile(index)}>{file}</button>)}
                </div>
                <pre className="checkpoint-diff-content">{selectedReviewPatch || "No diff available for this file."}</pre>
                <div className="dialog-actions"><button className="button-quiet" onClick={() => setReviewDiffOpen(false)}>Close</button></div>
              </section>
            </div>
          )}

          {checkpointDiff && (
            <div className="dialog-backdrop" role="presentation">
              <section className="dialog checkpoint-diff-dialog" role="dialog" aria-modal="true" aria-labelledby="checkpoint-diff-title" onClick={(event) => event.stopPropagation()}>
                <h2 id="checkpoint-diff-title">Checkpoint diff</h2>
                <p>Base {checkpointDiff.from_sha?.slice(0, 12) ?? "unknown"} → checkpoint {checkpointDiff.to_sha.slice(0, 12)}</p>
                {checkpointDiff.files.length === 0 ? <p>No changed files or differences.</p> : <>
                  <p><strong>Changed files</strong></p>
                  <div className="checkpoint-diff-files" aria-label="Changed files">
                    {checkpointDiff.files.map((file, index) => <button key={`${index}:${file}`} className="button-quiet"
                      aria-pressed={selectedDiffFile === index} onClick={() => setSelectedDiffFile(index)}>{file}</button>)}
                  </div>
                  <div className="dialog-actions">
                    <button className="button-quiet" aria-pressed={diffView === "unified"} onClick={() => setDiffView("unified")}>Unified</button>
                    <button className="button-quiet" aria-pressed={diffView === "side-by-side"} onClick={() => setDiffView("side-by-side")}>Side by side</button>
                  </div>
                  {diffView === "unified" ? <pre className="checkpoint-diff-content">{selectedDiffPatch || "No differences for this file."}</pre> :
                    <div className="checkpoint-diff-side-by-side" role="table" aria-label="Side-by-side diff">
                      {sideBySideLines(selectedDiffPatch).map((line, index) => <div role="row" key={index}>
                        <pre role="cell">{line.left}</pre><pre role="cell">{line.right}</pre>
                      </div>)}
                    </div>}
                </>}
                <div className="dialog-actions"><button className="button-quiet" onClick={() => {
                  diffRequestIdRef.current++;
                  setCheckpointDiff(null);
                }}>Close</button></div>
              </section>
            </div>
          )}

          {mergeConfirmation && (
            <div className="dialog-backdrop" role="presentation">
              <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="merge-confirm-title" onClick={(event) => event.stopPropagation()}>
                <h2 id="merge-confirm-title">Confirm merge back</h2>
                <p>Merge the checkpoint into <strong>{task.base_branch}</strong>?</p>
                {mergePreview?.checked_base_sha && mergePreview.task_sha && <p>Check sync found base {mergePreview.checked_base_sha.slice(0, 12)} and task {mergePreview.task_sha.slice(0, 12)}{mergePreview.checked_at ? ` at ${new Date(mergePreview.checked_at).toLocaleTimeString()}` : ""}. Git state is checked again before integration.</p>}
                {mergePreview?.candidate_sha && <p>Checkpoint {mergePreview.candidate_sha.slice(0, 12)}</p>}
                <aside className="developer-test-reminder" role="note" aria-label="Before merge reminder">
                  {DEVELOPER_TEST_REMINDER}
                </aside>
                <div className="dialog-actions">
                  <button className="button-primary" disabled={busy || mergePreview?.eligible !== true || !mergePreview.preview_id} onClick={() => void runMergeAction("start")}>Confirm merge</button>
                  <button className="button-quiet" disabled={busy} onClick={() => setMergeConfirmation(false)}>Cancel</button>
                </div>
              </section>
            </div>
          )}

          {syncAbortConfirmation && currentSyncRecovery?.can_abort &&
            (currentSyncRecovery.state === "CONFLICT" || currentSyncRecovery.state === "INTERRUPTED") && (
            <div className="dialog-backdrop" role="presentation">
              <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="sync-abort-title" onClick={(event) => event.stopPropagation()}>
                <h2 id="sync-abort-title">{currentSyncRecovery.state === "CONFLICT" ? "Abort sync" : "Clear sync recovery"}</h2>
                {currentSyncRecovery.state === "CONFLICT" ? <>
                  <p>Abort this sync and clear its conflict markers/index state, restoring the task worktree to the pre-sync commit. The primary checkout is untouched. Abort is allowed only while the conflict worktree still matches its saved snapshot.</p>
                  <p>This does not discard edits made after the conflict snapshot; if the worktree changes, the server refuses the abort.</p>
                </> : <p>No Git operation is in progress and the task branch is at its pre-sync commit. Clear this interrupted recovery without running Git; start a fresh sync separately if desired.</p>}
                <div className="dialog-actions">
                  <button className="button-primary" disabled={busy} onClick={() => void run(async () => {
                    try {
                      await abortTaskSync(task.id, true);
                    } catch (caught) {
                      await refreshSyncRecovery().catch(() => {});
                      throw caught;
                    }
                    if (liveTaskIdRef.current !== task.id) return;
                    setSyncRecovery(null);
                    setSyncRecoveryTaskId(task.id);
                    setSyncCheck(null);
                    setSyncCheckTaskId(null);
                    setSyncAbortConfirmation(false);
                    setSyncResult(null);
                  }, "Sync aborted")}>{currentSyncRecovery.state === "CONFLICT" ? "Confirm abort" : "Clear recovery"}</button>
                  <button className="button-quiet" disabled={busy} onClick={() => setSyncAbortConfirmation(false)}>Cancel</button>
                </div>
              </section>
            </div>
          )}

          {checkpointPreview && (
            <div className="dialog-backdrop" role="presentation">
              <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="checkpoint-confirm-title" onClick={(event) => event.stopPropagation()}>
                <h2 id="checkpoint-confirm-title">Confirm checkpoint</h2>
                <p>Record this exact Git snapshot on branch <strong>{checkpointPreview.branch}</strong> at {checkpointPreview.commit_sha.slice(0, 12)}. This records the checkpoint only; it is not a code-review or testing sign-off.</p>
                <p><strong>Tracked changes</strong></p>
                {checkpointPreview.tracked_changes.length
                  ? <ul>{checkpointPreview.tracked_changes.map((file) => <li key={file}>{file}</li>)}</ul>
                  : <p>No tracked changes.</p>}
                <p><strong>New files (included only with your approval)</strong></p>
                {checkpointPreview.untracked_files.length
                  ? <ul>{checkpointPreview.untracked_files.map((file) => <li key={file}>{file}</li>)}</ul>
                  : <p>No new files.</p>}
                {checkpointPreview.tracked_changes.length === 0 && checkpointPreview.untracked_files.length === 0 &&
                  <p role="alert">There are no changes to checkpoint.</p>}
                {checkpointPreviewFiles.length > 0 && <>
                  <p><strong>Previewed diff</strong></p>
                  <div className="checkpoint-diff-files" aria-label="Checkpoint preview files">
                    {checkpointPreviewFiles.map((file, index) => <button key={`${index}:${file}`} className="button-quiet"
                      aria-pressed={selectedCheckpointFile === index} onClick={() => setSelectedCheckpointFile(index)}>{file}</button>)}
                  </div>
                  <pre className="checkpoint-diff-content">{selectedCheckpointPatch || "No diff available for this file."}</pre>
                </>}
                <div className="dialog-actions">
                  <button className="button-primary" disabled={busy || (checkpointPreview.tracked_changes.length === 0 && checkpointPreview.untracked_files.length === 0)} onClick={() => void run(async () => {
                    let result;
                    try {
                      result = await createCheckpoint(task.id, {
                        tracked_changes: checkpointPreview.tracked_changes,
                        include_untracked_files: checkpointPreview.untracked_files,
                        branch: checkpointPreview.branch,
                        commit_sha: checkpointPreview.commit_sha,
                        state_token: checkpointPreview.state_token,
                      });
                    } catch (caught) {
                      const message = caught instanceof Error ? caught.message : String(caught);
                      if (!/changed|stale/i.test(message)) throw caught;
                      setCheckpointPreview(null);
                      const latestPreview = await loadCheckpointPreview(task.id);
                      setSelectedCheckpointFile(0);
                      setCheckpointPreview(latestPreview);
                      throw new Error("The worktree changed. The preview has been refreshed; review it and confirm again.");
                    }
                    setCheckpointedSha(result.commit_sha);
                    setCheckpointStatusError(null);
                    setCheckpointStatus({ ...checkpointPreview, tracked_changes: [], untracked_files: [], commit_sha: result.commit_sha });
                    setCheckpointStatusTaskId(task.id);
                    setCheckpointPreview(null);
                  }, "Checkpoint created")}>{checkpointPreview.untracked_files.length ? "Include files and update checkpoint" : "Update checkpoint"}</button>
                  <button className="button-quiet" disabled={busy} onClick={() => void run(async () => {
                    setSelectedCheckpointFile(0);
                    setCheckpointPreview(await loadCheckpointPreview(task.id));
                  })}>Refresh preview</button>
                  <button className="button-quiet" disabled={busy} onClick={() => setCheckpointPreview(null)}>Cancel</button>
                </div>
              </section>
            </div>
          )}

          {tab === "runs" && (
            <section className="ticket-section">
              {runs.length === 0 && <p className="run-empty">This ticket has no runs yet.</p>}
              {runs.map((item) => <HandoverCard run={item} key={item.id} />)}
            </section>
          )}

          {tab === "live" && (
            <section className="ticket-section live-conversation">
              {activeJob && <p className="run-empty live-state">
                {runningRunId
                  ? (streamState === "open" ? "Streaming." : streamState === "error" ? "Live stream unavailable; reconnecting…" : "Connecting to live output…")
                  : `Run is ${activeJob.run_status.toLowerCase().replaceAll("_", " ")}.`}
              </p>}

              {historyRecoveryFailed && <button className="button-quiet" onClick={() => {
                setHistoryRecoveryFailed(false);
                setHistoryRetry((value) => value + 1);
              }}>Retry history</button>}
              {!history && <p className="run-empty">Loading conversation…</p>}
              {history && buildLiveTimeline(history.entries, compactionSummaries).map((item) => item.type === "entry"
                ? <LiveMessageCard
                    key={`entry:${item.entry.session_id}:${item.entry.entry_id}`}
                    entry={item.entry}
                    input={transcriptInputByEntry.get(`${item.entry.session_id}:${item.entry.entry_id}`)}
                  />
                : <details className="compaction-summary" key={`compaction:${item.summary.id}`}>
                    <summary>Compaction summary</summary>
                    <div className="compaction-summary-text">{item.summary.summary}</div>
                  </details>)}
              {unattachedInputs.map((input) => <article className="live-input-status" key={input.id}>
                <header><strong>You</strong><span className={`input-status input-status-${input.delivery_status.toLowerCase()}`}>{inputStatusLabel(input.delivery_status)}</span></header>
                <p>{input.content}</p>
                {input.failure_reason && <small>{input.failure_reason}</small>}
                {input.reused_from_input_id && <small>Explicitly reused from an earlier input.</small>}
                {(["UNDELIVERED", "DELIVERY_UNKNOWN"].includes(input.delivery_status) && (activeJob || canStartRun)) &&
                  <button className="button-quiet" disabled={busy} onClick={() => reuseInput(input)}>Reuse / Send again</button>}
              </article>)}
              {liveLog && <pre className="live-log live-provisional">{liveLog}</pre>}
              {compactionActive && <p className="run-empty live-state compaction-status" role="status">Compacting context…</p>}
              {(persistedRunError || compactionError) && <p className="run-error live-state" role="alert">{persistedRunError || compactionError}</p>}
              {history && history.entries.length === 0 && unattachedInputs.length === 0 && !activeJob &&
                <p className="run-empty">No agent messages yet.</p>}
            </section>
          )}
        </div>

        {tab === "live" && activeHumanRequest && <HumanRequestPanel key={activeHumanRequest.id}
          request={activeHumanRequest} busy={humanRequestBusy} error={humanRequestError}
          onAnswer={(answers) => { void submitHumanAnswers(answers); }}
          onStop={() => { void stopWaitingForHuman(); }} />}
        {tab === "live" && !activeHumanRequest && humanRequestError &&
          <div className="human-request-load-error" role="alert">Human Request status: {humanRequestError}</div>}
        {tab === "live" && <footer className="ticket-composer">
          <p className="composer-hint">
            {waitingForHuman ? "Answer the Human Request above or stop the run before sending other guidance."
              : runningRunId
              ? "New guidance is saved before being steered. Delivery status updates when its transcript entry is confirmed."
              : activeJob
                ? "Guidance sent now is saved to this queued run in send order."
                : canStartRun ? "Enter a prompt to start a run." : "This ticket is read-only."}
          </p>
          <textarea
            value={draft}
            rows={3}
            placeholder={activeJob ? "Add guidance to this run…" : "What should the agent do?"}
            disabled={!!waitingForHuman || (!activeJob && !canStartRun)}
            onChange={(event) => { setDraft(event.target.value); setDraftInputId(null); setReuseInputId(null); }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitDraft();
              }
            }}
          />
          <div className="dialog-actions">
            <button className="button-primary" disabled={busy || !!waitingForHuman || !draft.trim() || (!activeJob && !canStartRun)} onClick={submitDraft}>
              {activeJob ? "Send guidance" : "Start run"}
            </button>
          </div>
        </footer>}
        {startingRun && <StartTaskDialog
          task={task}
          initialPrompt={draft}
          reusedFromInputId={reuseInputId}
          onCancel={(prompt) => {
            setStartingRun(false);
            setDraft(prompt);
            if (reuseInputId && prompt.trim() !== history?.inputs.find((input) => input.id === reuseInputId)?.content) setReuseInputId(null);
          }}
          onStarted={() => {
            setStartingRun(false);
            setDraft("");
            setReuseInputId(null);
            pushToast({ title: "Run queued", description: "Work queued.", variant: "success" });
            onChanged();
            void refresh();
            void refreshLiveHistory().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
          }}
        />}
      </aside>
    </div>
  );
}
