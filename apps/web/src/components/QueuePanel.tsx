import type { QueueItem, QueueSnapshot } from "@kanban-board/shared";
import { Avatar } from "./Avatar.js";

interface QueuePanelProps {
  queue: QueueSnapshot | null;
  loading: boolean;
  busyId: string | null;
  onMove: (jobId: string, position: number) => void;
  onRemove: (job: QueueItem) => void;
  onStop: (job: QueueItem) => void;
}

export function QueuePanel({ queue, loading, busyId, onMove, onRemove, onStop }: QueuePanelProps) {
  const queued = queue?.jobs.filter((job) => job.job_status === "QUEUED") ?? [];
  return (
    <section className="queue-panel" aria-labelledby="queue-heading">
      <div className="queue-heading">
        <div>
          <p className="eyebrow">GLOBAL SCHEDULER</p>
          <h2 id="queue-heading">Agent queue</h2>
        </div>
        {queue && <span className="capacity-pill">{queue.active_count} active <i /> {queue.max_concurrent_agents} max</span>}
      </div>
      {!queue && <p className="queue-empty">{loading ? "Loading queue…" : "Queue unavailable. Check the API error above, then refresh."}</p>}
      {queue?.jobs.length === 0 && <p className="queue-empty">The queue is clear. Start a Todo task to put an agent to work.</p>}
      {queue && queue.jobs.length > 0 && (
        <div className="queue-jobs">
          {queue.jobs.map((job) => {
            const active = job.job_status === "CLAIMED";
            const agent = job.stage === "INVESTIGATION" ? "Investigator" : "Worker";
            const position = queued.findIndex((item) => item.job_id === job.job_id) + 1;
            return (
              <article className={`queue-item ${active ? "queue-item-active" : ""}`} key={job.job_id}>
                <span className={`queue-position ${active ? "position-active" : ""}`}>{active ? <span className="pulse-dot" /> : String(job.queue_position ?? position).padStart(2, "0")}</span>
                <div className="queue-item-main">
                  <div className="queue-task-title"><strong>{job.title}</strong><span className={`queue-status ${active ? "status-active" : ""}`}>{active ? (job.run_status === "RUNNING" ? "Running" : "Starting") : "Queued"}</span></div>
                  <div className="queue-agent"><Avatar name={agent} size="small" /><span>{agent}</span><span className="queue-separator">·</span><span>{job.stage === "INVESTIGATION" ? "Investigation" : "Implementation"}</span></div>
                </div>
                {active ? (
                  <button className="button-stop" disabled={busyId !== null} onClick={() => onStop(job)}>
                    {busyId === job.run_id ? "Stopping…" : "Stop"}
                  </button>
                ) : (
                  <div className="queue-controls">
                    <button aria-label={`Move ${job.title} up`} title="Move up" disabled={busyId !== null || position <= 1} onClick={() => onMove(job.job_id, position - 1)}>↑</button>
                    <button aria-label={`Move ${job.title} down`} title="Move down" disabled={busyId !== null || position >= queued.length} onClick={() => onMove(job.job_id, position + 1)}>↓</button>
                    <button className="remove-queue" aria-label={`Remove ${job.title} from queue`} title="Remove from queue" disabled={busyId !== null} onClick={() => onRemove(job)}>×</button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
