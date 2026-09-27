import type { CommentDeliveryStatus, CommentDeliveryType } from "@kanban-board/shared";

const LABELS: Record<CommentDeliveryStatus, { text: string; title: string }> = {
  PENDING: { text: "Not sent yet", title: "Included in the next agent prompt." },
  QUEUED: { text: "Queued", title: "Accepted by the agent's steering queue, not delivered yet." },
  DELIVERED: { text: "Delivered", title: "The agent has received this message. It can no longer be changed." },
};

function Icon({ status }: { status: CommentDeliveryStatus }) {
  if (status === "DELIVERED") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="delivery-icon">
        <path d="M4.5 7V5.5a3.5 3.5 0 1 1 7 0V7h.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h.5Zm1.5 0h4V5.5a2 2 0 1 0-4 0V7Z" />
      </svg>
    );
  }
  if (status === "QUEUED") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="delivery-icon">
        <path d="M8 1.5A6.5 6.5 0 1 0 14.5 8 6.5 6.5 0 0 0 8 1.5Zm0 1.5A5 5 0 1 1 3 8a5 5 0 0 1 5-5Zm-.75 2v3.31l2.6 1.55.75-1.24-2.1-1.25V5Z" />
      </svg>
    );
  }
  return null;
}

export function DeliveryBadge({ status, type }: { status: CommentDeliveryStatus; type: CommentDeliveryType | null }) {
  const label = LABELS[status];
  return (
    <span className={`delivery-badge delivery-${status.toLowerCase()}`} title={label.title}>
      <Icon status={status} />
      <span>{label.text}</span>
      {type === "STEERING" && <span className="delivery-kind">steering</span>}
    </span>
  );
}
