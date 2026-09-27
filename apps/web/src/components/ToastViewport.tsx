import type { ReactElement } from "react";
import { TOAST_DEFAULT_DURATION_MS, useToast, type ToastVariant } from "./ToastContext.js";

const icons: Record<ToastVariant, ReactElement> = {
  default: <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 3.2v.1M8 7v4" />,
  success: <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM5.2 8.2l1.9 1.9 3.7-3.9" />,
  warning: <path d="M8 1.7 1.3 13.3h13.4L8 1.7Zm0 4v3.3m0 2.1v.1" />,
  danger: <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM5.8 5.8l4.4 4.4m0-4.4-4.4 4.4" />,
};

export function ToastViewport() {
  const { toasts, dismissToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className="toast-viewport" role="region" aria-label="Notifications">
      {toasts.map((toast) => {
        const variant = toast.variant ?? "default";
        const duration = toast.durationMs ?? TOAST_DEFAULT_DURATION_MS;
        return (
          <div key={toast.id} className={`toast toast-${variant}`} role="status">
            <div className="toast-body">
              <svg className="toast-icon" viewBox="0 0 16 16" aria-hidden="true">{icons[variant]}</svg>
              <div className="toast-text">
                <p className="toast-title">{toast.title}</p>
                {toast.description && <p className="toast-description">{toast.description}</p>}
              </div>
              <button className="toast-close" aria-label="Dismiss notification" onClick={() => dismissToast(toast.id)}>×</button>
            </div>
            <div className="toast-progress-track">
              <div className="toast-progress-bar" style={{ animationDuration: `${duration}ms` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
