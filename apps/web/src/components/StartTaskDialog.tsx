import { useState } from "react";
import type { Task } from "@kanban-board/shared";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { enqueueTask } from "../start-task-api.js";

interface StartTaskDialogProps {
  task: Task;
  initialPrompt?: string;
  reusedFromInputId?: string | null;
  onCancel: (prompt: string) => void;
  onStarted: () => void;
}

export function StartTaskDialog({ task, initialPrompt = "", reusedFromInputId = null, onCancel, onStarted }: StartTaskDialogProps) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [reuseSource, setReuseSource] = useState<string | null>(reusedFromInputId);
  const [confirm, setConfirm] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (!prompt.trim()) return;
    const key = idempotencyKey ?? crypto.randomUUID();
    setIdempotencyKey(key);
    setBusy(true);
    setError(null);
    try {
      await enqueueTask(task.id, prompt, key, fetch, reuseSource ?? undefined);
      onStarted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setConfirm(false);
      setBusy(false);
    }
  }

  return (
    <>
    <div className="dialog-backdrop" onClick={() => { if (!busy) onCancel(prompt); }}>
      <section className="dialog start-dialog" role="dialog" aria-modal="true" aria-labelledby="start-task-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="start-task-title">Start a run</h2>
        <p className="start-subtitle"><strong>{task.title}</strong></p>
        {task.description && <p className="ticket-description">{task.description}</p>}
        <label className="start-prompt-label" htmlFor={`start-prompt-${task.id}`}>Initial prompt</label>
        <textarea
          id={`start-prompt-${task.id}`}
          className="start-prompt"
          autoFocus
          value={prompt}
          rows={5}
          placeholder="What should the agent do?"
          onChange={(event) => {
            setPrompt(event.target.value);
            setIdempotencyKey(null);
            if (event.target.value.trim() !== initialPrompt.trim()) setReuseSource(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (prompt.trim()) setConfirm(true);
            }
          }}
        />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="button-quiet" disabled={busy} onClick={() => onCancel(prompt)}>Cancel</button>
          <button className="button-primary" disabled={busy || !prompt.trim()} onClick={() => setConfirm(true)}>Send</button>
        </div>
      </section>
    </div>
    {confirm && (
        <ConfirmDialog
          title="Confirm run"
          message={<>
            <p>Queue work for “{task.title}”?</p>
            <p><strong>Your prompt:</strong> {prompt.trim()}</p>
          </>}
          confirmLabel="Confirm and queue"
          busyLabel="Queueing…"
          busy={busy}
          onCancel={() => setConfirm(false)}
          onConfirm={() => void start()}
        />
    )}
    </>
  );
}
