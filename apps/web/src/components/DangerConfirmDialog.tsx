import { useState, type ReactNode } from "react";

interface DangerConfirmDialogProps {
  name: string;
  kind: "project" | "ticket";
  effects: ReactNode;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DangerConfirmDialog({ name, kind, effects, busy = false, onCancel, onConfirm }: DangerConfirmDialogProps) {
  const [step, setStep] = useState<1 | 2>(1);

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <section className="dialog danger-dialog" role="alertdialog" aria-modal="true" aria-labelledby="danger-title">
        <header className="danger-header">
          <h2 id="danger-title">Delete <span className="danger-name">{name}</span></h2>
          <button className="confirm-close" aria-label="Close" disabled={busy} onClick={onCancel}>×</button>
        </header>

        {step === 1 ? (
          <div className="danger-body">
            <p className="danger-text">Are you sure you want to delete this {kind}?</p>
            <button className="button-danger-block" disabled={busy} onClick={() => setStep(2)}>
              I want to delete this {kind}
            </button>
          </div>
        ) : (
          <div className="danger-body">
            <div className="danger-warn">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.7 1.3 13.3h13.4L8 1.7Zm0 4v3.3m0 2.1v.1" /></svg>
              <span>Unexpected bad things will happen if you don’t read this!</span>
            </div>
            <p className="danger-text">{effects}</p>
            <button className="button-danger-block" disabled={busy} onClick={onConfirm}>
              {busy ? "Deleting…" : "I have read and understood these effects"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
