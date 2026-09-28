import type Database from "better-sqlite3";

export interface RunPrompt {
  text: string;
  /** Run inputs that will be included in the initial Pi user message. */
  inputIds: string[];
  /** Legacy comments are never injected into a new run. */
  commentIds: string[];
}

interface PromptRow {
  stage: string;
  title: string;
  description: string;
}

export function buildRunPrompt(db: Database.Database, runId: string): RunPrompt {
  const row = db.prepare(`SELECT r.stage, t.title, t.description FROM task_runs r
    JOIN tasks t ON t.id = r.task_id WHERE r.id = ?`).get(runId) as PromptRow | undefined;
  if (!row) throw new Error(`Run ${runId} not found.`);

  const inputs = db.prepare(`SELECT id, content, delivery_type FROM run_inputs
    WHERE run_id = ? AND delivery_status IN ('PENDING', 'ACCEPTED')
      AND delivery_type IN ('INITIAL_PROMPT', 'QUEUED_INPUT')
    ORDER BY sequence`).all(runId) as Array<{ id: string; content: string; delivery_type: string }>;
  const initialPrompt = inputs.find((input) => input.delivery_type === "INITIAL_PROMPT");
  if (!initialPrompt) throw new Error(`Run ${runId} has no initial prompt.`);
  const queuedInputs = inputs.filter((input) => input.delivery_type === "QUEUED_INPUT");

  const sections = [
    `${row.stage === "INVESTIGATION" ? "Investigate" : "Implement"} this task.`,
    `Title: ${row.title}`,
    `User's initial instructions:\n${initialPrompt.content}`,
    `Task description:\n${row.description}`,
  ];
  if (queuedInputs.length > 0) {
    sections.push(`Additional queued guidance:\n${queuedInputs.map((input) => `- ${input.content}`).join("\n")}`);
  }

  return { text: sections.join("\n\n"), inputIds: inputs.map((input) => input.id), commentIds: [] };
}

export function revertCommentsToPending(db: Database.Database, commentIds: string[], runId: string): void {
  if (commentIds.length === 0) return;
  const update = db.prepare(`UPDATE ticket_comments SET delivery_status = 'PENDING', delivery_type = NULL,
    delivered_session_id = NULL, delivered_run_id = NULL, delivered_at = NULL
    WHERE id = ? AND delivery_status = 'DELIVERED' AND delivery_type = 'NEXT_PROMPT' AND delivered_run_id = ?`);
  db.transaction(() => {
    for (const id of commentIds) update.run(id, runId);
  })();
}

export function markCommentsDelivered(
  db: Database.Database,
  commentIds: string[],
  sessionId: string,
  runId: string,
): void {
  if (commentIds.length === 0) return;
  const now = new Date().toISOString();
  const update = db.prepare(`UPDATE ticket_comments SET delivery_status = 'DELIVERED',
    delivery_type = 'NEXT_PROMPT', delivered_session_id = ?, delivered_run_id = ?, delivered_at = ?
    WHERE id = ? AND delivery_status = 'PENDING'`);
  db.transaction(() => {
    for (const id of commentIds) update.run(sessionId, runId, now, id);
  })();
}
