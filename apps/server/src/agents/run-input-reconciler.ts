import type Database from "better-sqlite3";
import { buildRunPrompt } from "./prompt-builder.js";

export interface ActiveBranchEntry {
  id: string;
  type: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

export interface ActiveBranchSnapshot {
  sessionId: string;
  branch: ActiveBranchEntry[];
}

export type ActiveBranchReader = (taskId: string) => Promise<ActiveBranchSnapshot | null>;

interface RecoverableInput {
  id: string;
  task_id: string;
  run_id: string;
  content: string;
  delivery_type: "INITIAL_PROMPT" | "QUEUED_INPUT" | "STEERING";
  delivery_status: "PENDING" | "ACCEPTED";
  delivery_intent_at: string | null;
  session_id: string | null;
  session_sequence: number | null;
  transcript_boundary_entry_id: string | null;
  transcript_entry_id: string | null;
}

function messageText(entry: ActiveBranchEntry): string | null {
  if (entry.type !== "message" || entry.message?.role !== "user") return null;
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((part) => typeof part === "object" && part !== null && "text" in part
      ? (part as { text?: unknown }).text : null)
    .filter((part): part is string => typeof part === "string")
    .join("");
  return text || null;
}

export class RunInputReconciler {
  constructor(
    private readonly db: Database.Database,
    private readonly readActiveBranch: ActiveBranchReader,
  ) {}

  async reconcileAfterRestart(): Promise<void> {
    const taskIds = this.db.prepare(`SELECT DISTINCT task_id FROM run_inputs
      WHERE delivery_status IN ('PENDING', 'ACCEPTED')`).all() as Array<{ task_id: string }>;
    for (const { task_id: taskId } of taskIds) await this.reconcileTask(taskId);
  }

  private async reconcileTask(taskId: string): Promise<void> {
    const inputs = this.db.prepare(`SELECT id, task_id, run_id, content, delivery_type, delivery_status,
        delivery_intent_at, session_id, session_sequence, transcript_boundary_entry_id, transcript_entry_id
      FROM run_inputs
      WHERE task_id = ? AND delivery_status IN ('PENDING', 'ACCEPTED')
      ORDER BY run_id, COALESCE(session_sequence, sequence), sequence`).all(taskId) as RecoverableInput[];
    if (inputs.length === 0) return;

    let snapshot: ActiveBranchSnapshot | null;
    try {
      snapshot = await this.readActiveBranch(taskId);
    } catch (error) {
      const reason = `Working session could not be inspected during restart recovery: ${error instanceof Error ? error.message : String(error)}`;
      this.markUnknown(inputs.filter((input) => input.delivery_intent_at), reason);
      this.markUndelivered(inputs.filter((input) => !input.delivery_intent_at), reason);
      return;
    }

    if (!snapshot) {
      this.markUnknown(inputs.filter((input) => input.delivery_intent_at),
        "Delivery was attempted, but the working session is unavailable for transcript recovery.");
      this.markUndelivered(inputs.filter((input) => !input.delivery_intent_at),
        "The Pi call was not started before the backend stopped.");
      return;
    }

    const branchIndexes = new Map(snapshot.branch.map((entry, index) => [entry.id, index]));
    const userEntries = snapshot.branch
      .map((entry, index) => ({ entry, index, text: messageText(entry) }))
      .filter((entry): entry is { entry: ActiveBranchEntry; index: number; text: string } => entry.text !== null);
    const used = new Set<string>(this.db.prepare(`SELECT transcript_entry_id FROM run_inputs
      WHERE task_id = ? AND transcript_entry_id IS NOT NULL`).all(taskId)
      .map((row) => (row as { transcript_entry_id: string }).transcript_entry_id));
    const bundled = new Set<string>();
    const initialGroups = new Map<string, RecoverableInput[]>();
    for (const input of inputs.filter((item) => item.delivery_type !== "STEERING")) {
      const group = initialGroups.get(input.run_id) ?? [];
      group.push(input);
      initialGroups.set(input.run_id, group);
    }
    for (const [runId, group] of initialGroups) {
      this.reconcileBundledInputs(runId, group, snapshot, branchIndexes, userEntries, used);
      for (const input of group) bundled.add(input.id);
    }

    const grouped = new Map<string, RecoverableInput[]>();
    for (const input of inputs.filter((item) => !bundled.has(item.id))) {
      const key = input.session_id ?? "";
      const group = grouped.get(key) ?? [];
      group.push(input);
      grouped.set(key, group);
    }

    for (const [sessionId, sessionInputs] of grouped) {
      if (!sessionId || sessionId !== snapshot.sessionId) {
        this.markUnknown(sessionInputs.filter((input) => input.delivery_intent_at),
          "Transcript delivery belongs to a different session and cannot be attributed safely.");
        this.markUndelivered(sessionInputs.filter((input) => !input.delivery_intent_at),
          "The Pi call was not started before the backend stopped.");
        continue;
      }

      let cursor = 0;
      let blocked = false;
      for (const input of sessionInputs.sort((left, right) =>
        (left.session_sequence ?? Number.MAX_SAFE_INTEGER) - (right.session_sequence ?? Number.MAX_SAFE_INTEGER))) {
        if (!input.delivery_intent_at) {
          this.markUndelivered([input], "The Pi call was not started before the backend stopped.");
          continue;
        }
        if (blocked) {
          this.markUnknown([input], "Transcript delivery became ambiguous after an earlier unmatched entry.");
          continue;
        }
        const boundaryIndex = input.transcript_boundary_entry_id === null
          ? -1 : branchIndexes.get(input.transcript_boundary_entry_id);
        if (boundaryIndex === undefined) {
          this.markUnknown([input], "The recorded transcript boundary is not on the active session branch.");
          blocked = true;
          continue;
        }
        cursor = Math.max(cursor, boundaryIndex + 1);
        const candidate = userEntries.find((entry) => entry.index >= cursor && !used.has(entry.entry.id));
        if (!candidate) {
          this.markUnknown([input], "No uniquely attributable transcript entry was found after the saved boundary.");
          blocked = true;
          continue;
        }
        if (candidate.text !== input.content) {
          this.markUnknown([input], "An unexpected user entry makes transcript delivery attribution ambiguous.");
          blocked = true;
          continue;
        }
        const laterMatching = userEntries.filter((entry) => entry.index > candidate.index &&
          !used.has(entry.entry.id) && entry.text === input.content);
        const remainingSameText = sessionInputs.some((other) => other !== input &&
          (other.session_sequence ?? Number.MAX_SAFE_INTEGER) > (input.session_sequence ?? Number.MAX_SAFE_INTEGER) &&
          other.content === input.content && other.delivery_intent_at);
        if (laterMatching.length > 0 && !remainingSameText) {
          this.markUnknown([input], "Multiple matching transcript entries prevent unique delivery attribution.");
          blocked = true;
          continue;
        }
        const owner = this.db.prepare(`SELECT run_id FROM run_transcript_entries
          WHERE session_id = ? AND entry_id = ?`).get(snapshot.sessionId, candidate.entry.id) as { run_id: string } | undefined;
        if (owner && owner.run_id !== input.run_id) {
          this.markUnknown([input], "The matching transcript entry is already owned by another run.");
          blocked = true;
          continue;
        }
        this.markDelivered(input, snapshot.sessionId, candidate.entry.id);
        used.add(candidate.entry.id);
        cursor = candidate.index + 1;
      }
    }
  }

  private reconcileBundledInputs(
    runId: string,
    inputs: RecoverableInput[],
    snapshot: ActiveBranchSnapshot,
    branchIndexes: Map<string, number>,
    userEntries: Array<{ entry: ActiveBranchEntry; index: number; text: string }>,
    used: Set<string>,
  ): void {
    const attempted = inputs.filter((input) => input.delivery_intent_at);
    const notAttempted = inputs.filter((input) => !input.delivery_intent_at);
    if (notAttempted.length > 0) this.markUndelivered(notAttempted, "The Pi call was not started before the backend stopped.");
    if (attempted.length === 0) return;
    if (attempted.some((input) => input.session_id !== snapshot.sessionId)) {
      this.markUnknown(attempted, "Transcript delivery belongs to a different session and cannot be attributed safely.");
      return;
    }
    const boundaryIds = new Set(attempted.map((input) => input.transcript_boundary_entry_id));
    if (boundaryIds.size !== 1) {
      this.markUnknown(attempted, "Bundled inputs do not share one transcript boundary.");
      return;
    }
    const boundaryId = attempted[0]!.transcript_boundary_entry_id;
    const boundaryIndex = boundaryId === null ? -1 : branchIndexes.get(boundaryId);
    if (boundaryIndex === undefined) {
      this.markUnknown(attempted, "The recorded transcript boundary is not on the active session branch.");
      return;
    }
    let expected: string;
    try {
      expected = buildRunPrompt(this.db, runId).text;
    } catch (error) {
      this.markUnknown(attempted, `The initial prompt could not be reconstructed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const candidates = userEntries.filter((entry) => entry.index > boundaryIndex && !used.has(entry.entry.id));
    const matching = candidates.filter((entry) => entry.text === expected);
    if (matching.length !== 1) {
      this.markUnknown(attempted, "The bundled initial prompt was not uniquely found on the active transcript branch.");
      return;
    }
    const candidate = matching[0]!;
    const first = candidates[0];
    if (!first || first.entry.id !== candidate.entry.id) {
      this.markUnknown(attempted, "An unexpected user entry makes bundled prompt attribution ambiguous.");
      return;
    }
    const owner = this.db.prepare(`SELECT run_id FROM run_transcript_entries
      WHERE session_id = ? AND entry_id = ?`).get(snapshot.sessionId, candidate.entry.id) as { run_id: string } | undefined;
    if (owner && owner.run_id !== runId) {
      this.markUnknown(attempted, "The bundled prompt entry is already owned by another run.");
      return;
    }
    attempted.forEach((input, index) => this.markDelivered(input, snapshot.sessionId, candidate.entry.id, index === 0));
    used.add(candidate.entry.id);
  }

  private markDelivered(input: RecoverableInput, sessionId: string, entryId: string, recordTranscript = true): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE run_inputs SET delivery_status = 'DELIVERED', delivered_at = ?,
        transcript_entry_id = ?, failure_reason = NULL
        WHERE id = ? AND delivery_status IN ('PENDING', 'ACCEPTED') AND transcript_entry_id IS NULL`)
        .run(now, entryId, input.id);
      if (!changed.changes) return;
      if (recordTranscript) {
        const sequence = (this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS next
          FROM run_transcript_entries WHERE run_id = ?`).get(input.run_id) as { next: number }).next;
        this.db.prepare(`INSERT OR IGNORE INTO run_transcript_entries (session_id, entry_id, run_id, sequence)
          VALUES (?, ?, ?, ?)`).run(sessionId, entryId, input.run_id, sequence);
      }
    })();
  }

  private markUnknown(inputs: RecoverableInput[], reason: string): void {
    if (inputs.length === 0) return;
    const update = this.db.prepare(`UPDATE run_inputs SET delivery_status = 'DELIVERY_UNKNOWN', failure_reason = ?
      WHERE id = ? AND delivery_status IN ('PENDING', 'ACCEPTED')`);
    this.db.transaction(() => { for (const input of inputs) update.run(reason, input.id); })();
  }

  private markUndelivered(inputs: RecoverableInput[], reason: string): void {
    if (inputs.length === 0) return;
    const update = this.db.prepare(`UPDATE run_inputs SET delivery_status = 'UNDELIVERED', failure_reason = ?
      WHERE id = ? AND delivery_status IN ('PENDING', 'ACCEPTED')`);
    this.db.transaction(() => { for (const input of inputs) update.run(reason, input.id); })();
  }
}
