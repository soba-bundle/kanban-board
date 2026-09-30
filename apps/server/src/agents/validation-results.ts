import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { ValidationReportSchema, type ValidationResult } from "@kanban-board/shared";

export interface ValidationResultInput {
  task_id: string;
  run_id: string;
  candidate_sha: string;
  base_sha: string;
  base_tip_at_start: string;
  base_tip_at_finish: string;
  guidance_watermark: string | null;
  report: unknown;
  failure?: { kind: string; message: string };
  task_head_at_start?: string;
  task_head_at_finish?: string;
  task_worktree_clean_at_start?: boolean;
  task_worktree_clean_at_finish?: boolean;
  validation_worktree_clean?: boolean;
  validation_worktree_path?: string | null;
  read_live_base_tip?: () => Promise<string> | string;
}

interface TaskValidationState {
  review_tag: string | null;
  base_commit_sha: string | null;
  latest_task_commit_sha: string | null;
}

function sqlBoolean(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

function isStale(input: ValidationResultInput, task: TaskValidationState, liveBaseTip: string): boolean {
  return task.latest_task_commit_sha !== input.candidate_sha ||
    task.base_commit_sha !== input.base_sha ||
    input.base_tip_at_start !== liveBaseTip ||
    (input.task_head_at_finish !== undefined && input.task_head_at_finish !== input.candidate_sha) ||
    input.task_worktree_clean_at_finish === false;
}

export async function recordValidationResult(db: Database.Database, input: ValidationResultInput): Promise<void> {
  const parsedReport = ValidationReportSchema.safeParse(input.report);
  const findings = parsedReport.success ? parsedReport.data.findings : [];
  let failure = input.failure;
  if (!failure && !parsedReport.success) {
    failure = { kind: "MALFORMED_REPORT", message: parsedReport.error.message };
  }
  if (!failure && input.validation_worktree_clean === false) {
    failure = { kind: "VALIDATION_WORKTREE_MUTATED", message: "Validation changed tracked files in its detached worktree." };
  }

  let liveBaseTip = input.base_tip_at_finish;
  if (!failure && input.read_live_base_tip) {
    try {
      liveBaseTip = await input.read_live_base_tip();
    } catch (error) {
      failure = { kind: "BASE_TIP_CHECK_FAILED", message: error instanceof Error ? error.message : String(error) };
    }
  }

  const initialTask = db.prepare(`SELECT review_tag, base_commit_sha, latest_task_commit_sha
    FROM tasks WHERE id = ?`).get(input.task_id) as TaskValidationState | undefined;
  if (!initialTask) throw new Error(`Task ${input.task_id} not found.`);

  const result: ValidationResult = failure
    ? "VALIDATION_FAILED"
    : isStale(input, initialTask, liveBaseTip)
      ? "STALE"
      : findings.length === 0 ? "PASSED" : "ISSUES_FOUND";
  const blocksReadiness = findings.some((finding) => finding.attribution === "DIRECT" || finding.attribution === "UNCERTAIN");
  const snapshotId = result === "VALIDATION_FAILED" ? null : randomUUID();
  const resultId = randomUUID();
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`INSERT INTO validation_results (id, task_id, run_id, result, findings_json, created_at,
      candidate_sha, base_sha, base_tip_at_start, base_tip_at_finish, guidance_watermark,
      task_head_at_start, task_head_at_finish, task_worktree_clean_at_start, task_worktree_clean_at_finish,
      validation_worktree_clean, validation_worktree_path, cleanup_status, failure_kind, failure_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(resultId, input.task_id, input.run_id, result, parsedReport.success ? JSON.stringify(findings) : null, now,
        input.candidate_sha, input.base_sha, input.base_tip_at_start, liveBaseTip, input.guidance_watermark,
        input.task_head_at_start ?? null, input.task_head_at_finish ?? null,
        sqlBoolean(input.task_worktree_clean_at_start), sqlBoolean(input.task_worktree_clean_at_finish),
        sqlBoolean(input.validation_worktree_clean), input.validation_worktree_path ?? null,
        input.validation_worktree_path ? "PENDING" : null, failure?.kind ?? null, failure?.message ?? null);

    let finalResult = result;
    let activeSnapshotId: string | null = null;
    if (snapshotId) {
      db.prepare(`INSERT INTO validation_snapshots (id, task_id, validation_run_id, validated_task_sha,
        validated_base_sha, result, created_at, messages_watermark) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(snapshotId, input.task_id, input.run_id, input.candidate_sha, input.base_sha, result, now, input.guidance_watermark);

      const currentTask = db.prepare(`SELECT review_tag, base_commit_sha, latest_task_commit_sha
        FROM tasks WHERE id = ?`).get(input.task_id) as TaskValidationState;
      if (finalResult !== "STALE" && isStale(input, currentTask, liveBaseTip)) {
        finalResult = "STALE";
        db.prepare("UPDATE validation_results SET result = ? WHERE id = ?").run(finalResult, resultId);
        db.prepare("UPDATE validation_snapshots SET result = ? WHERE id = ?").run(finalResult, snapshotId);
      }

      if (finalResult !== "STALE" && !blocksReadiness) activeSnapshotId = snapshotId;
    }

    const latestRun = db.prepare(`SELECT id FROM task_runs WHERE task_id = ? AND stage = 'VALIDATION_REVIEW'
      ORDER BY sequence DESC LIMIT 1`).get(input.task_id) as { id: string } | undefined;
    if (latestRun?.id === input.run_id) {
      const reviewTag = finalResult === "VALIDATION_FAILED" ? "VALIDATION_FAILED"
        : finalResult === "STALE" ? "IMPLEMENTATION_COMPLETE"
          : blocksReadiness ? "VALIDATION_ISSUES" : "READY_TO_MERGE";
      db.prepare(`UPDATE tasks SET review_tag = ?, active_validation_snapshot_id = ?, updated_at = ? WHERE id = ?`)
        .run(reviewTag, activeSnapshotId, now, input.task_id);
    }
  })();
}

export interface TaskWorktreeState {
  head_sha: string;
  dirty: boolean;
}

export function invalidateStaleValidationReadiness(
  db: Database.Database,
  taskId: string,
  liveBaseTip: string,
  taskWorktree?: TaskWorktreeState,
): boolean {
  const active = db.prepare(`SELECT s.validated_task_sha, s.validated_base_sha, r.base_tip_at_start
    FROM tasks t JOIN validation_snapshots s ON s.id = t.active_validation_snapshot_id
    JOIN validation_results r ON r.run_id = s.validation_run_id
    WHERE t.id = ?`).get(taskId) as {
      validated_task_sha: string; validated_base_sha: string; base_tip_at_start: string | null;
    } | undefined;
  if (!active) return false;

  const currentTask = db.prepare("SELECT latest_task_commit_sha, base_commit_sha FROM tasks WHERE id = ?")
    .get(taskId) as { latest_task_commit_sha: string | null; base_commit_sha: string | null } | undefined;
  if (!currentTask) return false;
  const taskWorktreeStale = taskWorktree &&
    (taskWorktree.head_sha !== active.validated_task_sha || taskWorktree.dirty);
  if (active.base_tip_at_start === liveBaseTip && active.validated_task_sha === currentTask.latest_task_commit_sha &&
    active.validated_base_sha === currentTask.base_commit_sha && !taskWorktreeStale) return false;

  const now = new Date().toISOString();
  db.prepare(`UPDATE tasks SET active_validation_snapshot_id = NULL, review_tag = 'IMPLEMENTATION_COMPLETE', updated_at = ?
    WHERE id = ?`).run(now, taskId);
  return true;
}
