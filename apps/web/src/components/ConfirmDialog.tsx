import type { ReactNode } from "react";

interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel, busyLabel = "Working…", busy = false, onCancel, onConfirm }: ConfirmDialogProps) {
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <section className="dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <header className="confirm-header">
          <h2 id="confirm-title">{title}</h2>
          <button className="confirm-close" aria-label="Close" disabled={busy} onClick={onCancel}>×</button>
        </header>
        <div className="confirm-alert">
          <svg className="confirm-alert-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.7 1.3 13.3h13.4L8 1.7Zm0 4v3.3m0 2.1v.1" /></svg>
          <div className="confirm-message">{message}</div>
        </div>
        <div className="dialog-actions">
          <button className="button-quiet" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="button-danger" disabled={busy} onClick={onConfirm}>{busy ? busyLabel : confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
