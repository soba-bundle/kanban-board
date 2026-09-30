import type Database from "better-sqlite3";
import { invalidateStaleValidationReadiness } from "./validation-results.js";
import type { WorktreeManager } from "../git/worktree-manager.js";

export async function refreshValidationReadiness(
  db: Database.Database,
  taskId: string,
  worktrees?: WorktreeManager,
): Promise<boolean> {
  const task = db.prepare(`SELECT review_tag, active_validation_snapshot_id FROM tasks WHERE id = ?`)
    .get(taskId) as { review_tag: string | null; active_validation_snapshot_id: string | null } | undefined;
  if (!task) return false;
  if (!task.active_validation_snapshot_id) {
    if (task.review_tag === "READY_TO_MERGE") {
      db.prepare(`UPDATE tasks SET review_tag = 'IMPLEMENTATION_COMPLETE', updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), taskId);
    }
    return false;
  }
  if (task.review_tag !== "READY_TO_MERGE" || !worktrees) return false;

  try {
    const [liveBaseTip, worktree] = await Promise.all([
      worktrees.getBaseBranchTip(taskId),
      worktrees.getTaskWorktreeState(taskId),
    ]);
    invalidateStaleValidationReadiness(db, taskId, liveBaseTip, worktree);
  } catch {
    return false;
  }

  const refreshed = db.prepare(`SELECT review_tag, active_validation_snapshot_id FROM tasks WHERE id = ?`)
    .get(taskId) as { review_tag: string | null; active_validation_snapshot_id: string | null };
  return refreshed.review_tag === "READY_TO_MERGE" &&
    refreshed.active_validation_snapshot_id === task.active_validation_snapshot_id;
}
