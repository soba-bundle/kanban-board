# Phase 6A — Step 1 baseline

Recorded 2026-09-28. Step 1 only; no application behavior changes, schema changes,
data reset, or legacy conversion performed.

References: [PRD v2](local-agent-kanban-prd-v2.md) and
[implementation plan v2](local-agent-kanban-implementation-plan-v2.md).

## Source and verification

- Baseline commit: `577df52ad1ab8d65e8bbe333f65596753317e8e2` (`main`).
- Environment: Windows; Node `v24.16.0`, npm `11.12.1`, Git `2.47.1.windows.2`.
- `npm run typecheck`: passed for shared, server, and web.
- `npm test`: passed, including production builds.
  - Shared: 7 passed.
  - Server: 57 passed.
  - Web: 8 passed.
  - Total: 72 passed, zero failures, skips, or cancellations.
- Pi smoke tests, Windows process-tree smoke tests, and browser acceptance tests
  were not run in this step. Existing tests establish the pre-6A baseline, not v2
  conformance; several deliberately assert the old comment/start/replay behavior.
- Pre-existing working-tree changes were left untouched: modified `.gitignore`,
  deleted original PRD/implementation-plan files, and untracked v2 replacements.

## Runtime-data inventory

Paths below are observations, not an instruction to delete anything. Database
inspection used a read-only SQLite connection, not application initialization.
No `KANBAN_*` environment overrides were present in the inspection shell; this
cannot establish another process's environment or whether a backend is running.

Repository root: `C:/Users/leeju/repos/kanban-board`.

| Resource | Observed location / state |
| --- | --- |
| Demo database | `apps/server/data/kanban.sqlite` |
| Applied schema versions | 1, 2, 3 |
| Root-level default DB | `data/kanban.sqlite` does not exist |
| Server session directory | `apps/server/data/sessions/` (48 JSONL files) |
| Additional session directory | `data/sessions/` (9 JSONL files; ownership not inferred) |
| Separate smoke database | `apps/server/data/security-smoke.sqlite`, with WAL/SHM sidecars; outside demo-reset scope |
| Demo project | `807d8878-84aa-488d-b4bd-6233bf748641`, name `kanban board`, repository root as above |
| Configured worktree root | `C:/Users/leeju/tmp` (external shared directory; never recursively delete it) |
| Tasks | 13 stored: 10 active, 3 inactive |
| Agent jobs | 7 FINISHED; no QUEUED/CLAIMED rows observed |
| Legacy comments | 0 rows |

Two stored tasks still say IN_PROGRESS despite no queued/claimed jobs. This is
an observed baseline inconsistency, not evidence of a running agent. No repair
was attempted. Recheck backend/process ownership before any later reset.

### Path-resolution caution

`db.ts` defaults to `data/kanban.sqlite`; `AgentManager` defaults to `data/sessions`.
Both are relative to the backend's working directory. The npm workspace start
runs from `apps/server`, matching the observed demo DB and task session paths.
Launching directly from repository root can select different data locations.
Resolve absolute paths explicitly when performing the later backup/reset.

### Existing task worktrees and session references

Every worktree below exists and is registered with Git. All seven were clean at
inspection (`git --no-optional-locks ... status --porcelain`). Their branches are
`agent/task-<task ID>`, and their paths are `C:/Users/leeju/tmp/<task ID>`.
All referenced session files exist under `apps/server/data/sessions/`.

| Task ID | Session filename |
| --- | --- |
| `90b1fc7b-75eb-4d11-baaa-27d3fe2b03e6` | `2026-09-26T19-25-13-657Z_01a0df2d-c439-71a6-9b32-3484f09720f3.jsonl` |
| `87972f8b-d85e-4c89-a1c8-c49a9431b4fa` | `2026-09-27T08-34-28-425Z_01a0e200-57c8-7b00-a2a2-81fe67180e6a.jsonl` |
| `2e048689-2e9c-4b4f-bd97-a5bd603b3da6` | `2026-09-27T08-52-07-892Z_01a0e210-8254-7ec1-a4ce-788045d3efcc.jsonl` |
| `e6718fc7-20f1-49d9-8add-cb5d461ab58f` | `2026-09-27T15-01-59-341Z_01a0e363-1fad-7625-a7b4-095b8676778a.jsonl` |
| `b87ad160-28a4-4040-ad5b-5abeedca8d20` | `2026-09-27T15-58-19-260Z_01a0e396-b27c-7428-a6b3-e2f09f4ded06.jsonl` |
| `341f5cad-edb9-4957-a880-a83bd22c04ae` | `2026-09-27T16-11-01-776Z_01a0e3a2-5510-71b7-a587-b85dc85b2ac9.jsonl` |
| `788d5cf4-589f-4210-8a75-cb323089dd81` | `2026-09-28T08-35-54-240Z_01a0e728-0300-77f2-a563-687823c1e5b7.jsonl` |

Stored session paths are relative (`data\\sessions\\<filename>`). Preserve this
mapping and the database backup before resetting; a fresh DB will not automatically
adopt old worktrees or conversations merely because the project is re-added.

## Demo-data reset exception

The user confirmed that the existing project data is disposable demo data and
approved planning around a fresh database rather than converting legacy inputs.
For this installation, this is an explicit exception to the legacy-preservation
acceptance requirements in PRD v2 section 9 and implementation-plan section 6A.1.

- Keep versioned schema migrations; do not rewrite initialization or reset on startup.
- No conversion/replay of old demo comments into new run inputs is required.
- This exception does not authorize destructive migration of other databases or
  deletion of repository content, branches, worktrees, or session JSONL files.
- Retaining legacy tables is acceptable; removing them is not needed for step 1.
- New Phase 6A inputs must still preserve delivery identity and expose undelivered
  guidance on Stop/failure/cancellation. A disposable old DB does not relax these rules.

The reset remains a separate later step, after migration implementation/testing:
stop the backend and owned work, recheck paths and worktree state, make a consistent
SQLite backup (accounting for any WAL), then reset only the confirmed demo database
and its associated SQLite sidecars. Initialize through migrations and re-add the
project. Do not delete either session directory, the separate smoke DB, or the
external worktree root. No backup/reset has been performed in step 1.

## Next step

Step 2: focused Pi delivery/history verification before choosing delivery correlation
and transcript reconstruction details. Await user direction before proceeding.
