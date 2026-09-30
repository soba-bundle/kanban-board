import { useState } from "react";
import type { TaskRunSummary, ValidationAttribution, ValidationFinding } from "@kanban-board/shared";

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

function formatFinding(finding: ValidationFinding): string {
  const locations = finding.locations.map((location) => `  - ${location.file}:${location.line}`).join("\n");
  return `${finding.attribution}: ${finding.summary}\nRationale: ${finding.rationale}\nEvidence: ${finding.evidence}\nLocations:\n${locations}`;
}

export function HandoverCard({ run }: { run: TaskRunSummary }) {
  const [copied, setCopied] = useState<string | null>(null);
  const handover = run.handover as Record<string, unknown> | null;
  const validation = run.validation_result;
  const findings = validation?.findings ?? [];
  const stageLabel = run.stage === "INVESTIGATION" ? "Investigation" : run.stage === "IMPLEMENTATION" ? "Implementation" : "Validation";

  async function copyFindings(attribution: ValidationAttribution) {
    const selected = findings.filter((finding) => finding.attribution === attribution);
    if (!selected.length) return;
    try {
      await navigator.clipboard.writeText(selected.map(formatFinding).join("\n\n"));
      setCopied(attribution);
    } catch {
      setCopied("failed");
    }
  }

  return (
    <article className="run-card">
      <header className="run-card-header">
        <span className="run-stage">{stageLabel} #{run.sequence}</span>
        <span className={`run-status run-status-${run.status.toLowerCase()}`}>
          {run.reason_code ? `${run.status} · ${run.reason_code.replaceAll("_", " ")}` : run.status}
        </span>
      </header>
      {run.error_message && <p className="run-error">{run.error_message}</p>}
      {run.stage === "VALIDATION_REVIEW" ? (
        <section className="validation-result">
          {validation ? <>
            <p className="validation-outcome">Validation result: {validation.result.replaceAll("_", " ")}</p>
            {validation.result === "STALE" && <p className="run-empty">This historical report is stale and is not current merge readiness.</p>}
            {validation.active === false && validation.result !== "STALE" &&
              <p className="run-empty">This historical report is not the active validation snapshot.</p>}
            {findings.length === 0 ? <p className="run-empty">No findings reported.</p> : <>
              <ul className="validation-findings">
                {findings.map((finding) => <li key={finding.id}>
                  <span className={`finding-attribution finding-${finding.attribution.toLowerCase()}`}>{finding.attribution}</span>
                  <strong>{finding.summary}</strong>
                  <p>{finding.rationale}</p>
                  <p>{finding.evidence}</p>
                  <ul>{finding.locations.map((location) => <li key={`${location.file}:${location.line}`}>{location.file}:{location.line}</li>)}</ul>
                </li>)}
              </ul>
              <div className="dialog-actions">
                {findings.some((finding) => finding.attribution === "DIRECT") &&
                  <button className="button-quiet" onClick={() => void copyFindings("DIRECT")}>Copy direct findings</button>}
                {findings.some((finding) => finding.attribution === "INDIRECT") &&
                  <button className="button-quiet" onClick={() => void copyFindings("INDIRECT")}>Copy indirect findings</button>}
              </div>
              {copied && <p className="run-empty" role="status">{copied === "failed" ? "Could not copy findings." : `Copied ${copied.toLowerCase()} findings.`}</p>}
            </>}
          </> : <p className="run-empty">{run.status === "RUNNING" || run.status === "QUEUED"
            ? "Validation is reviewing the pinned checkpoint."
            : "No validation report was recorded for this run."}</p>}
        </section>
      ) : !handover ? <p className="run-empty">{run.status === "INTERRUPTED"
        ? "Run interrupted before the final handover. Enter a new prompt in Live to continue."
        : run.status === "FAILED"
          ? "Run failed before a final handover was recorded."
          : "No handover recorded for this run."}</p> : (
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
