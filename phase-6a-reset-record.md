# Phase 6A — Step 4 demo database reset record

Completed 2026-09-28 with user authorization. Reset targeted only
`C:/Users/leeju/repos/kanban-board/apps/server/data/kanban.sqlite` and its SQLite
`-wal` / `-shm` sidecars. No backend process matching the app and no listener on
port 3000 were found before reset. The old DB had no QUEUED/CLAIMED jobs.

## Backup

Created a consistent SQLite online backup before removing the demo DB:

`C:/Users/leeju/repos/kanban-board/apps/server/data/backups/kanban-pre-phase6a-reset.sqlite`

Verified the backup with `PRAGMA quick_check = ok`; it contains schema versions
1–3, 1 project, 13 tasks, and 0 comments. The backup is retained and was not
modified during reset.

## Fresh DB and re-added project

Removed only the confirmed demo DB and its sidecars. Recreated the database through
`openDatabase()`; migration versions **1, 2, 3, and 4** are applied. Re-added the
project configuration from the verified backup, with a new project ID:

- Name: `kanban board`
- Repository root: `C:/Users/leeju/repos/kanban-board`
- Worktree root: `C:/Users/leeju/tmp`
- IDE command: unset

Fresh DB verification: `PRAGMA quick_check = ok`; one project; zero tasks, jobs,
run inputs, or comments. The database path is the server workspace path (not the
repository-root default path).

## Preserved resources

- Existing session JSONL files under `apps/server/data/sessions/` remain present
  (52 files at post-reset inventory).
- Seven existing task worktrees under `C:/Users/leeju/tmp/<task ID>` remain
  registered with Git and clean. The repository root is also in the worktree list;
  its pre-existing user changes remain untouched.
- Separate `security-smoke.sqlite` and its sidecars were not targeted.
- No task worktree, agent branch, session file, repository source file, or primary
  checkout change was deleted or reset.

The new DB intentionally has no task metadata linking those preserved demo
worktrees/sessions; they remain preserved outside the fresh demo board state.
