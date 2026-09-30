import type Database from "better-sqlite3";

interface ValidationWorktreeRemover {
  removeValidationWorktree(taskId: string, worktreePath: string): Promise<void>;
}

export class ValidationCleanupManager {
  constructor(private readonly db: Database.Database, private readonly worktrees: ValidationWorktreeRemover) {}

  async cleanup(taskId: string, runId: string, worktreePath: string): Promise<void> {
    try {
      await this.worktrees.removeValidationWorktree(taskId, worktreePath);
      this.db.transaction(() => {
        this.db.prepare(`UPDATE validation_results SET validation_worktree_path = NULL, cleanup_status = NULL
          WHERE run_id = ?`).run(runId);
        this.db.prepare("UPDATE task_runs SET validation_worktree_path = NULL WHERE id = ?").run(runId);
      })();
    } catch {
      this.db.transaction(() => {
        this.db.prepare(`UPDATE validation_results SET validation_worktree_path = ?, cleanup_status = 'CLEANUP_PENDING'
          WHERE run_id = ?`).run(worktreePath, runId);
        this.db.prepare("UPDATE task_runs SET validation_worktree_path = ? WHERE id = ?").run(worktreePath, runId);
      })();
    }
  }

  async reconcilePending(): Promise<void> {
    const results = this.db.prepare(`SELECT task_id, run_id, validation_worktree_path AS path
      FROM validation_results WHERE cleanup_status = 'CLEANUP_PENDING' AND validation_worktree_path IS NOT NULL`)
      .all() as Array<{ task_id: string; run_id: string; path: string }>;
    const runs = this.db.prepare(`SELECT task_id, id AS run_id, validation_worktree_path AS path FROM task_runs
      WHERE stage = 'VALIDATION_REVIEW' AND validation_worktree_path IS NOT NULL`).all() as
      Array<{ task_id: string; run_id: string; path: string }>;
    const pending = new Map([...results, ...runs].map((item) => [`${item.run_id}:${item.path}`, item]));
    for (const item of pending.values()) await this.cleanup(item.task_id, item.run_id, item.path);
  }
}
