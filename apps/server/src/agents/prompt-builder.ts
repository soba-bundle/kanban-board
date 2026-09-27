import type Database from "better-sqlite3";

export interface RunPrompt {
  text: string;
  /** Pending comments folded into this prompt, marked delivered once it is sent. */
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

  const pending = db.prepare(`SELECT c.id, c.content FROM ticket_comments c
    JOIN task_runs r ON r.task_id = c.task_id
    WHERE r.id = ? AND c.author_type = 'USER' AND c.delivery_status = 'PENDING'
    ORDER BY c.created_at, c.id`).all(runId) as Array<{ id: string; content: string }>;

  const sections = [
    `${row.stage === "INVESTIGATION" ? "Investigate" : "Implement"} this task.`,
    `Title: ${row.title}`,
    `Description:\n${row.description}`,
  ];
  if (pending.length > 0) {
    sections.push(`New comments from the user:\n${pending.map((c) => `- ${c.content}`).join("\n")}`);
  }

  return { text: sections.join("\n\n"), commentIds: pending.map((comment) => comment.id) };
}

/**
 * Returns comments to PENDING when they never entered conversation history, so the
 * guidance is included in the next run instead of being silently consumed. Delivery
 * is stamped before prompt() is awaited, so a prompt that throws early leaves a
 * premature stamp. Only NEXT_PROMPT comments stamped by this run are reset; anything
 * the model actually saw is permanent.
 */
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
