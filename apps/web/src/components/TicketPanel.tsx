import { useCallback, useEffect, useRef, useState } from "react";
import type { CheckpointPreview, HumanRequest, HumanRequestAnswerInput, LiveEvent, LiveHistoryEntry, LiveHistorySnapshot, QueueSnapshot, RunInput, Task, TaskRunSummary } from "@kanban-board/shared";
import { HandoverCard } from "./HandoverCard.js";
import { HumanRequestPanel } from "./HumanRequestPanel.js";
import { StartTaskDialog } from "./StartTaskDialog.js";
import { useToast } from "./ToastContext.js";
import { completeTask, loadTaskCompletionStatus } from "../board-api.js";
import {
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

function formatProvisional(snapshot: LiveHistorySnapshot): string {
  const provisional = snapshot.provisional_events.map(describeEvent).filter((text): text is string => !!text).join("");
  return snapshot.provisional_truncated
    ? `${provisional}\n[Some recent live output is unavailable; refresh to load persisted history.]\n`
    : provisional;
}

function textContent(entry: LiveHistoryEntry): string {
  const message = entry.message as { content?: unknown };
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((part): part is { type: string; text: string } =>
    !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text).join("");
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
  const [humanRequests, setHumanRequests] = useState<HumanRequest[]>([]);
  const [humanRequestError, setHumanRequestError] = useState<string | null>(null);
  const [humanRequestBusy, setHumanRequestBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("live");
  const [draft, setDraft] = useState("");
  const [draftInputId, setDraftInputId] = useState<string | null>(null);
  const [startStage, setStartStage] = useState<"INVESTIGATION" | "IMPLEMENTATION" | null>(null);
  const [reuseInputId, setReuseInputId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [startingRun, setStartingRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveLog, setLiveLog] = useState("");
  const [liveHistory, setLiveHistory] = useState<LiveHistorySnapshot | null>(null);
  const [streamState, setStreamState] = useState<"idle" | "open" | "closed" | "error">("idle");
  const [historyRecoveryFailed, setHistoryRecoveryFailed] = useState(false);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [checkpointPreview, setCheckpointPreview] = useState<CheckpointPreview | null>(null);
  const [checkpointStatus, setCheckpointStatus] = useState<CheckpointPreview | null>(null);
  const [checkpointStatusError, setCheckpointStatusError] = useState<string | null>(null);
  const [completionStatus, setCompletionStatus] = useState<{
    ready: boolean; reason: "WORKTREE_CHANGES" | "BRANCH_CHANGES" | "GIT_STATE_UNAVAILABLE" | null;
  } | null>(null);
  const [completionStatusError, setCompletionStatusError] = useState<string | null>(null);
  const [checkpointedSha, setCheckpointedSha] = useState<string | null>(null);
  const [checkpointDiff, setCheckpointDiff] = useState<{ files: string[]; diff: string; to_sha: string } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const liveCursorRef = useRef(0);
  const liveTaskIdRef = useRef(task.id);
  liveTaskIdRef.current = task.id;
  const { pushToast } = useToast();

  const activeJob = queue?.jobs.find((job) => job.task_id === task.id);
  const runningRunId = activeJob?.run_status === "RUNNING" ? activeJob.run_id : null;
  const canStartRun = task.workflow_state === "TODO" || (task.workflow_state === "REVIEW" &&
    ["INVESTIGATION_COMPLETE", "IMPLEMENTATION_COMPLETE", "RUN_FAILED", "INTERRUPTED"].includes(task.review_tag ?? ""));
  const canReviewAction = task.workflow_state === "REVIEW" &&
    ["INVESTIGATION_COMPLETE", "IMPLEMENTATION_COMPLETE", "RUN_FAILED", "INTERRUPTED"].includes(task.review_tag ?? "");
  const canCheckpoint = task.workflow_state === "REVIEW" &&
    ["INVESTIGATION_COMPLETE", "IMPLEMENTATION_COMPLETE"].includes(task.review_tag ?? "");
  const latestCheckpointSha = checkpointedSha ?? task.latest_task_commit_sha;
  const checkpointHasChanges = !!checkpointStatus &&
    (checkpointStatus.tracked_changes.length > 0 || checkpointStatus.untracked_files.length > 0);

  const refresh = useCallback(async () => {
    try {
      const nextRuns = await loadRuns(task.id);
      if (!mountedRef.current) return;
      setRuns(nextRuns);
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

  async function refreshLiveHistory() {
    const snapshot = await loadLiveHistory(task.id);
    if (!mountedRef.current || liveTaskIdRef.current !== task.id) return;
    setLiveHistory(snapshot);
    setLiveLog(formatProvisional(snapshot));
  }

  useEffect(() => { void refresh(); }, [refresh]);

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
    setCheckpointStatusError(null);
    if (!canCheckpoint) return;
    let current = true;
    const load = () => {
      void loadCheckpointPreview(task.id).then((preview) => {
        if (current) {
          setCheckpointStatus(preview);
          setCheckpointStatusError(null);
        }
      }).catch((caught) => {
        if (current) {
          setCheckpointStatus(null);
          setCheckpointStatusError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { current = false; clearInterval(timer); };
  }, [canCheckpoint, task.id, task.latest_task_commit_sha]);

  useEffect(() => {
    let current = true;
    setLiveHistory(null);
    setLiveLog("");
    setHistoryRecoveryFailed(false);
    void loadLiveHistory(task.id).then((snapshot) => {
      if (!current) return;
      liveCursorRef.current = snapshot.active_run_id === runningRunId ? snapshot.cursor : 0;
      setLiveHistory(snapshot);
      setLiveLog(formatProvisional(snapshot));
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
        setLiveHistory(snapshot);
        setLiveLog(formatProvisional(snapshot));
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
    const sourceStage = runs.find((item) => item.id === input.run_id)?.stage;
    setStartStage(sourceStage === "INVESTIGATION" || sourceStage === "IMPLEMENTATION" ? sourceStage : null);
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
    if (!canStartRun || !startStage) return;
    setStartingRun(true);
  }

  return (
    <div className="panel-backdrop" onClick={onClose}>
      <aside className="ticket-panel" onClick={(event) => event.stopPropagation()} aria-label={`Ticket ${task.title}`}>
        <header className="ticket-panel-header">
          <div className="ticket-panel-heading">
            <span className="ticket-state">{task.workflow_state.replaceAll("_", " ")}</span>
            {task.review_tag && <span className="review-tag">{task.review_tag.replaceAll("_", " ")}</span>}
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
              {canReviewAction && (
                <section className="ticket-section review-actions">
                  <p className="ticket-section-title">Next step</p>
                  {checkpointStatusError && <p className="error-banner" role="alert">{checkpointStatusError}</p>}
                  <div className="dialog-actions">
                    {canCheckpoint && (checkpointStatus === null ? (
                      <button className="button-primary" disabled>Checking worktree…</button>
                    ) : checkpointHasChanges ? (
                      <button className="button-primary" disabled={busy} onClick={() => void run(async () => {
                        setCheckpointPreview(await loadCheckpointPreview(task.id));
                      })}>Commit changes</button>
                    ) : latestCheckpointSha ? (
                      <button className="button-quiet" disabled>Merge back (unavailable until Phase 9)</button>
                    ) : (
                      <span className="run-empty">No changes to checkpoint.</span>
                    ))}
                    <button className="button-quiet" disabled={busy} onClick={() => setStartingRun(true)}>Start run</button>
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
                    <button className="button-quiet" disabled={busy} onClick={() => void run(async () => {
                      setCheckpointDiff(await loadCheckpointDiff(task.id));
                    })}>View checkpoint diff</button>
                  </div>
                </section>
              )}
            </>
          )}

          {checkpointDiff && (
            <div className="dialog-backdrop" role="presentation">
              <section className="dialog checkpoint-diff-dialog" role="dialog" aria-modal="true" aria-labelledby="checkpoint-diff-title" onClick={(event) => event.stopPropagation()}>
                <h2 id="checkpoint-diff-title">Checkpoint diff</h2>
                <p>Commit {checkpointDiff.to_sha.slice(0, 12)}</p>
                <p><strong>Changed files</strong></p>
                <ul>{checkpointDiff.files.map((file) => <li key={file}>{file}</li>)}</ul>
                <pre className="checkpoint-diff-content">{checkpointDiff.diff || "No differences."}</pre>
                <div className="dialog-actions"><button className="button-quiet" onClick={() => setCheckpointDiff(null)}>Close</button></div>
              </section>
            </div>
          )}

          {checkpointPreview && (
            <div className="dialog-backdrop" role="presentation">
              <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="checkpoint-confirm-title" onClick={(event) => event.stopPropagation()}>
                <h2 id="checkpoint-confirm-title">Confirm checkpoint</h2>
                <p>Commit the reviewed changes on branch <strong>{checkpointPreview.branch}</strong> at {checkpointPreview.commit_sha.slice(0, 12)}?</p>
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
                <div className="dialog-actions">
                  <button className="button-primary" disabled={busy || (checkpointPreview.tracked_changes.length === 0 && checkpointPreview.untracked_files.length === 0)} onClick={() => void run(async () => {
                    const result = await createCheckpoint(task.id, {
                      tracked_changes: checkpointPreview.tracked_changes,
                      include_untracked_files: checkpointPreview.untracked_files,
                      branch: checkpointPreview.branch,
                      commit_sha: checkpointPreview.commit_sha,
                      state_token: checkpointPreview.state_token,
                    });
                    setCheckpointedSha(result.commit_sha);
                    setCheckpointStatusError(null);
                    setCheckpointStatus({ ...checkpointPreview, tracked_changes: [], untracked_files: [], commit_sha: result.commit_sha });
                    setCheckpointPreview(null);
                  }, "Checkpoint created")}>{checkpointPreview.untracked_files.length ? "Include files and commit" : "Confirm and commit"}</button>
                  <button className="button-quiet" disabled={busy} onClick={() => void run(async () => {
                    setCheckpointPreview(await loadCheckpointPreview(task.id));
                  })}>Review latest contents</button>
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
              {history?.entries.map((entry) => <LiveMessageCard
                key={entry.id}
                entry={entry}
                input={transcriptInputByEntry.get(`${entry.session_id}:${entry.entry_id}`)}
              />)}
              {unattachedInputs.map((input) => <article className="live-input-status" key={input.id}>
                <header><strong>You</strong><span className={`input-status input-status-${input.delivery_status.toLowerCase()}`}>{inputStatusLabel(input.delivery_status)}</span></header>
                <p>{input.content}</p>
                {input.failure_reason && <small>{input.failure_reason}</small>}
                {input.reused_from_input_id && <small>Explicitly reused from an earlier input.</small>}
                {(["UNDELIVERED", "DELIVERY_UNKNOWN"].includes(input.delivery_status) && (activeJob || canStartRun)) &&
                  <button className="button-quiet" disabled={busy} onClick={() => reuseInput(input)}>Reuse / Send again</button>}
              </article>)}
              {liveLog && <pre className="live-log live-provisional">{liveLog}</pre>}
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
                : canStartRun ? "Enter a prompt and choose a stage to start a run." : "This ticket is read-only."}
          </p>
          {!activeJob && canStartRun && <fieldset className="composer-stage-picker">
            <legend>Stage</legend>
            {(["INVESTIGATION", "IMPLEMENTATION"] as const).map((stage) => <label key={stage}>
              <input type="radio" name={`composer-stage-${task.id}`} checked={startStage === stage} onChange={() => setStartStage(stage)} />
              {stage === "INVESTIGATION" ? "Investigation" : "Implementation"}
            </label>)}
          </fieldset>}
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
            <button className="button-primary" disabled={busy || !!waitingForHuman || !draft.trim() || (!activeJob && (!canStartRun || !startStage))} onClick={submitDraft}>
              {activeJob ? "Send guidance" : "Start run"}
            </button>
          </div>
        </footer>}
        {startingRun && <StartTaskDialog
          task={task}
          initialPrompt={draft}
          initialStage={startStage}
          reusedFromInputId={reuseInputId}
          onCancel={(prompt, stage) => {
            setStartingRun(false);
            setDraft(prompt);
            setStartStage(stage);
            if (reuseInputId && prompt.trim() !== history?.inputs.find((input) => input.id === reuseInputId)?.content) setReuseInputId(null);
          }}
          onStarted={(stage) => {
            setStartingRun(false);
            setDraft("");
            setReuseInputId(null);
            setStartStage(stage);
            pushToast({ title: "Run queued", description: `${stage === "INVESTIGATION" ? "Investigation" : "Implementation"} queued.`, variant: "success" });
            onChanged();
            void refresh();
            void refreshLiveHistory().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
          }}
        />}
      </aside>
    </div>
  );
}
