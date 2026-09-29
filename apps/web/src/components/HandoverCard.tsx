import type { TaskRunSummary } from "@kanban-board/shared";

const LIST_FIELDS = [
  "evidence",
  "affected_files",
  "recommended_changes",
  "missing_information",
  "files_changed",
  "key_decisions",
  "known_limitations",
  "recommended_validation",
] as const;

const SCALAR_FIELDS = ["confidence", "outcome", "root_cause", "recommended_next_step", "human_verification_required"] as const;

function label(field: string): string {
  return field.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}

export function HandoverCard({ run }: { run: TaskRunSummary }) {
  const handover = run.handover as Record<string, unknown> | null;
  const stageLabel = run.stage === "INVESTIGATION" ? "Investigation" : run.stage === "IMPLEMENTATION" ? "Implementation" : "Validation";

  return (
    <article className="run-card">
      <header className="run-card-header">
        <span className="run-stage">{stageLabel} #{run.sequence}</span>
        <span className={`run-status run-status-${run.status.toLowerCase()}`}>
          {run.reason_code ? `${run.status} · ${run.reason_code.replaceAll("_", " ")}` : run.status}
        </span>
      </header>
      {run.error_message && <p className="run-error">{run.error_message}</p>}
      {!handover && <p className="run-empty">{run.status === "INTERRUPTED"
        ? "Run interrupted before the final handover. Enter a new prompt in Live to continue."
        : run.status === "FAILED"
          ? "Run failed before a final handover was recorded."
          : "No handover recorded for this run."}</p>}
      {handover && (
        <div className="handover-body">
          {typeof handover.summary === "string" && <p className="handover-summary">{handover.summary}</p>}
          <dl className="handover-fields">
            {SCALAR_FIELDS.filter((field) => handover[field] !== undefined && handover[field] !== null).map((field) => (
              <div key={field}>
                <dt>{label(field)}</dt>
                <dd>{String(handover[field])}</dd>
              </div>
            ))}
          </dl>
          {LIST_FIELDS.filter((field) => Array.isArray(handover[field]) && (handover[field] as unknown[]).length > 0).map((field) => (
            <div className="handover-list" key={field}>
              <p className="handover-list-title">{label(field)}</p>
              <ul>
                {(handover[field] as string[]).map((item, index) => <li key={index}>{item}</li>)}
              </ul>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
