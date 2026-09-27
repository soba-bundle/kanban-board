import { useState } from "react";
import type { Task } from "@kanban-board/shared";
import { chooseStartAction, enqueueTask } from "../start-task-api.js";

type StartStage = "INVESTIGATION" | "IMPLEMENTATION";

interface StartTaskDialogProps {
  task: Task;
  onCancel: () => void;
  onStarted: (stage: StartStage) => void;
}

export function StartTaskDialog({ task, onCancel, onStarted }: StartTaskDialogProps) {
  const [confirmDirect, setConfirmDirect] = useState(false);
  const [pending, setPending] = useState<StartStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const directAction = chooseStartAction("IMPLEMENTATION");

  async function start(stage: StartStage) {
    setPending(stage);
    setError(null);
    try {
      await enqueueTask(task.id, stage);
      onStarted(stage);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPending(null);
    }
  }

  const busy = pending !== null;

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <section className="dialog start-dialog" role="dialog" aria-modal="true" aria-labelledby="start-task-title" onClick={(event) => event.stopPropagation()}>
        {!confirmDirect ? (
          <>
            <h2 id="start-task-title">Start Task</h2>
            <p className="start-subtitle">How should the agent begin work on “{task.title}”?</p>
            <div className="start-options">
              <button className="start-option" disabled={busy} onClick={() => {
                const action = chooseStartAction("INVESTIGATION");
                if (action.type === "enqueue") void start(action.stage);
              }}>
                {pending === "INVESTIGATION" ? <Spinner /> : (
                  <svg className="start-option-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M7 1.7a5.3 5.3 0 1 0 3.4 9.36l3.2 3.2m-3-4.9A5.3 5.3 0 0 0 7 1.7Z" /></svg>
                )}
                <span className="start-option-text">
                  <span className="start-option-title">Queue for Investigation</span>
                  <span className="start-option-desc">Diagnose the root cause first, then decide whether to implement.</span>
                </span>
              </button>
              <button className="start-option" disabled={busy} onClick={() => {
                const action = chooseStartAction("IMPLEMENTATION");
                if (action.type === "confirm") setConfirmDirect(true);
                else void start(action.stage);
              }}>
                <svg className="start-option-icon icon-impl" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 1.5 2.5 9h4l-1 5.5 7-7.5h-4l1-5.5Z" /></svg>
                <span className="start-option-text">
                  <span className="start-option-title">Implement Directly</span>
                  <span className="start-option-desc">Skip investigation and let the agent implement right away.</span>
                </span>
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="start-task-title">{directAction.type === "confirm" ? directAction.title : ""}</h2>
            <p className="start-subtitle">{directAction.type === "confirm" ? directAction.warning : ""}</p>
            <div className="dialog-actions dialog-actions-block">
              <button className="button-primary button-block" disabled={busy} onClick={() => {
                const action = chooseStartAction("IMPLEMENTATION", true);
                if (action.type === "enqueue") void start(action.stage);
              }}>
                {pending === "IMPLEMENTATION" ? <><Spinner /> Queueing…</> : "Continue to Implementation"}
              </button>
              <button className="button-quiet button-block" disabled={busy} onClick={() => setConfirmDirect(false)}>Back</button>
            </div>
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </section>
    </div>
  );
}

function Spinner() {
  return <svg className="spinner" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" /></svg>;
}
