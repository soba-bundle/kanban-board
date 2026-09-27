import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveEvent, QueueSnapshot, Task, TaskRunSummary, TicketComment } from "@kanban-board/shared";
import { Avatar } from "./Avatar.js";
import { DeliveryBadge } from "./DeliveryBadge.js";
import { HandoverCard } from "./HandoverCard.js";
import { useToast } from "./ToastContext.js";
import {
  addComment,
  deleteComment,
  editComment,
  loadComments,
  loadRuns,
  openRunEvents,
  steerRun,
} from "../ticket-api.js";

type Tab = "timeline" | "runs" | "live";

interface TicketPanelProps {
  task: Task;
  queue: QueueSnapshot | null;
  onClose: () => void;
  onChanged: () => void;
}

/** How often the panel re-reads the board while it has queued or active work. */
const ACTIVE_POLL_MS = 3000;

const EDITABLE_STATES = new Set(["TODO", "REVIEW"]);

function authorLabel(comment: TicketComment): string {
  return comment.author_type === "USER" ? "You" : comment.author_type === "AGENT" ? "Agent" : "System";
}

function describeEvent(event: LiveEvent): string | null {
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case "message_update":
      return typeof data.delta === "string" ? data.delta : null;
    case "tool_execution_start":
      return `\n[tool] ${String(data.toolName ?? "unknown")}\n`;
    case "comment_queued":
      return `\n[steering queued] ${String(data.content ?? "")}\n`;
    case "comment_delivered":
      return `\n[steering delivered]\n`;
    default:
      return null;
  }
}

export function TicketPanel({ task, queue, onClose, onChanged }: TicketPanelProps) {
  const [comments, setComments] = useState<TicketComment[]>([]);
  const [runs, setRuns] = useState<TaskRunSummary[]>([]);
  const [tab, setTab] = useState<Tab>("timeline");
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveLog, setLiveLog] = useState("");
  const [streamState, setStreamState] = useState<"idle" | "open" | "closed" | "error">("idle");
  const logRef = useRef<HTMLPreElement>(null);
  const { pushToast } = useToast();

  const activeJob = queue?.jobs.find((job) => job.task_id === task.id);
  const runningRunId = activeJob?.run_status === "RUNNING" ? activeJob.run_id : null;
  const canEdit = EDITABLE_STATES.has(task.workflow_state);

  const refresh = useCallback(async () => {
    try {
      const [nextComments, nextRuns] = await Promise.all([loadComments(task.id), loadRuns(task.id)]);
      setComments(nextComments);
      setRuns(nextRuns);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [task.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!runningRunId) return;
    // The stream starts with this run's replayed backlog, so start from a clean log.
    setLiveLog("");
    setStreamState("idle");
    const socket = openRunEvents(runningRunId, (event) => {
      const text = describeEvent(event);
      if (text) setLiveLog((current) => current + text);
      // Delivery state lives in SQLite, so re-read rather than patching locally.
      if (event.type === "comment_delivered" || event.type === "comment_queued") void refresh();
    });
    socket.addEventListener("open", () => setStreamState("open"));
    socket.addEventListener("error", () => setStreamState("error"));
    socket.addEventListener("close", () => setStreamState((current) => (current === "error" ? current : "closed")));
    return () => socket.close();
  }, [runningRunId, refresh]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [liveLog]);

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

  function submitDraft() {
    const text = draft.trim();
    if (!text) return;
    if (runningRunId) {
      void run(async () => { await steerRun(runningRunId, text); setDraft(""); }, "Steering message sent");
      return;
    }
    void run(async () => { await addComment(task.id, text); setDraft(""); });
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
          {(["timeline", "runs", "live"] as Tab[]).map((value) => (
            <button
              key={value}
              className={`ticket-tab${tab === value ? " ticket-tab-active" : ""}`}
              onClick={() => setTab(value)}
            >
              {value === "timeline" ? "Timeline" : value === "runs" ? `Runs (${runs.length})` : "Live"}
            </button>
          ))}
        </nav>

        <div className="ticket-panel-body">
          {error && <div className="error-banner" role="alert"><span>{error}</span></div>}

          {tab === "timeline" && (
            <>
              <section className="ticket-section">
                <p className="ticket-section-title">Description</p>
                <p className="ticket-description">{task.description || "No description."}</p>
              </section>
              <section className="ticket-section">
                <p className="ticket-section-title">Comments</p>
                {comments.length === 0 && <p className="run-empty">No comments yet.</p>}
                <ul className="comment-list">
                  {comments.map((comment) => {
                    const mutable = comment.author_type === "USER" && comment.delivery_status === "PENDING" && canEdit;
                    return (
                      <li className="comment-item" key={comment.id}>
                        <Avatar name={authorLabel(comment)} size="small" />
                        <div className="comment-body">
                          <div className="comment-meta">
                            <strong>{authorLabel(comment)}</strong>
                            <DeliveryBadge status={comment.delivery_status} type={comment.delivery_type} />
                            <span className="comment-time">{new Date(comment.created_at).toLocaleString()}</span>
                          </div>
                          {editingId === comment.id ? (
                            <div className="comment-edit">
                              <textarea value={editDraft} rows={3} onChange={(event) => setEditDraft(event.target.value)} />
                              <div className="comment-edit-actions">
                                <button className="button-quiet" onClick={() => setEditingId(null)}>Cancel</button>
                                <button
                                  className="button-primary"
                                  disabled={busy || !editDraft.trim()}
                                  onClick={() => void run(async () => {
                                    await editComment(comment.id, editDraft.trim());
                                    setEditingId(null);
                                  })}
                                >
                                  Save
                                </button>
                              </div>
                            </div>
                          ) : (
                            <p className="comment-content">{comment.content}</p>
                          )}
                          {mutable && editingId !== comment.id && (
                            <div className="comment-actions">
                              <button className="link-button" onClick={() => { setEditingId(comment.id); setEditDraft(comment.content); }}>Edit</button>
                              <button className="link-button link-danger" disabled={busy} onClick={() => void run(() => deleteComment(comment.id))}>Delete</button>
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            </>
          )}

          {tab === "runs" && (
            <section className="ticket-section">
              {runs.length === 0 && <p className="run-empty">This ticket has no runs yet.</p>}
              {runs.map((item) => <HandoverCard run={item} key={item.id} />)}
            </section>
          )}

          {tab === "live" && (
            <section className="ticket-section">
              {!runningRunId && (
                <p className="run-empty">
                  {activeJob
                    ? `This run is ${activeJob.run_status.toLowerCase().replaceAll("_", " ")}. Live output appears once it starts running.`
                    : "No run is streaming. Live output appears while an agent works."}
                </p>
              )}
              {runningRunId && (
                <>
                  <p className="run-empty live-state">
                    {streamState === "error" && "Live stream could not connect. Restart the dev server so the WebSocket proxy is active."}
                    {streamState === "closed" && "Live stream disconnected."}
                    {streamState === "open" && "Streaming."}
                    {streamState === "idle" && "Connecting…"}
                  </p>
                  <pre className="live-log" ref={logRef}>{liveLog || "Waiting for output…"}</pre>
                </>
              )}
            </section>
          )}
        </div>

        <footer className="ticket-composer">
          <p className="composer-hint">
            {runningRunId
              ? "A run is active. Your message is sent as steering and delivered at the next turn boundary."
              : "Comments wait here and are included in the next agent prompt."}
          </p>
          <textarea
            value={draft}
            rows={3}
            placeholder={runningRunId ? "Send steering to the active run…" : "Add a comment…"}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="dialog-actions">
            <button className="button-primary" disabled={busy || !draft.trim()} onClick={submitDraft}>
              {runningRunId ? "Send steering" : "Add comment"}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}
