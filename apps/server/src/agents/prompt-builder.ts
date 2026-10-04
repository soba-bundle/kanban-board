import type Database from "better-sqlite3";

export interface RunPrompt {
  text: string;
  /** Run inputs that will be included in the initial Pi user message. */
  inputIds: string[];
}

interface PromptRow {
  title: string;
  description: string;
}

export function buildRunPrompt(db: Database.Database, runId: string): RunPrompt {
  const row = db.prepare(`SELECT t.title, t.description FROM task_runs r
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
    "Work on this task.",
    `Title: ${row.title}`,
    `User's initial instructions:\n${initialPrompt.content}`,
    `Task description:\n${row.description}`,
  ];
  if (queuedInputs.length > 0) {
    sections.push(`Additional queued guidance:\n${queuedInputs.map((input) => `- ${input.content}`).join("\n")}`);
  }

  return { text: sections.join("\n\n"), inputIds: inputs.map((input) => input.id) };
}
