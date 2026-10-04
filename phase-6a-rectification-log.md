# Phase 6A Rectification Log

**Purpose:** Reviewable record of the decisions, implementation changes, database operations, and verification performed to close the Phase 6A exit gate after retiring ticket comments.

**Historical requirements at the time:** [Implementation plan v2](local-agent-kanban-implementation-plan-v2.md) and [PRD v2](local-agent-kanban-prd-v2.md). For current workflow semantics, see [Workflow Simplification, Sync, and Checkpoint Plan](workflow-simplification-sync-and-checkpoint-plan.md).

## Operating rules

- Append an entry for each implementation or operational step as it is completed. Include date, summary, paths/components affected, tests/checks and outcomes, and unresolved issues.
- Record database paths and reset outcome without including secrets. Do not record a reset as complete until the target paths are verified and the operation succeeds.
- Keep this log factual. A planned or attempted check is not a passing result.
- Do not delete session files, worktrees, repositories, or unrelated databases as part of the application database reset.

## Decision

Ticket comments are a retired product concept. There will be no legacy-comment import, preservation, audit, display, or reuse flow. Existing application databases are intended to be cleared and initialized clean; the final active schema must not contain `ticket_comments` or comment-only metadata. Run inputs remain the sole user-guidance record and may be explicitly reused from another run input according to the existing workflow.

## Change log

### 2026-09-28 — Requirements documents updated

- Updated `local-agent-kanban-implementation-plan-v2.md` to remove legacy-comment migration/preservation/reuse acceptance criteria; specify the scoped database reset; require a clean schema without the comments table/metadata; and update the Phase 6A exit gate.
- Updated `local-agent-kanban-prd-v2.md` to remove ticket comments as a product concept and specify no legacy-comment import, audit, or reuse flow.
- Verification: `git diff --check` passed. Searched both documents for stale requirements to preserve or expose legacy comments; no matches.
- No application code, schema, tests, or databases changed in this step.

### 2026-09-29 — Step 1: ticket-comment reference audit completed

Scope: tracked application/shared source, tests, Pi smoke, and current requirements documents; inspected archived document names separately. Used `git grep` for comment/Timeline identifiers and followed helper/component references. Generated dependencies, build output, runtime databases and session contents are not removal targets in this audit. No application code, schema, tests, or database contents were changed. Tests/typecheck were not run for this read-only audit.

#### Step 2 removal/change inventory

| Files | Finding and required change |
| --- | --- |
| `apps/server/src/comments.ts`, `apps/server/src/index.ts` | Remove the whole comment route module and registration: GET/POST `/api/tasks/:taskId/comments`, PATCH/DELETE `/api/comments/:id`. No read-only compatibility endpoint is required. |
| `apps/server/src/agents/prompt-builder.ts` | Remove `RunPrompt.commentIds`, the empty return property, `markCommentsDelivered`, and `revertCommentsToPending`. Keep `text`, `inputIds`, and run-input prompt assembly. Current builder already reads only run inputs. |
| `apps/server/src/agents/run-manager.ts` | Remove imports/calls to the comment delivery/reversion helpers. `watchRunEvents().sawUserMessage` is used only by comment reversion; remove its tracking/return member as part of this change, not the transcript watcher or run-input delivery reconciliation. |
| `apps/server/src/agents/steering.ts` | Legacy `recordSteeringQueued`/`markSteeringDelivered` helpers write `ticket_comments`. Reference search found only their definitions, no callers. Remove this obsolete feature module; keep current steering in `run-manager.ts`. |
| `packages/shared/src/index.ts` | Remove `CommentAuthorType`, `CommentDeliveryStatus`, `CommentDeliveryType`, `TicketComment`, their schemas, and create/update-comment schemas. Retain all run-input schemas/types. |
| `apps/web/src/ticket-api.js`, `apps/web/src/ticket-api.d.ts` | Remove `loadComments`, `addComment`, `editComment`, `deleteComment`, and the `TicketComment` type import. Preserve run/history/checkpoint/steering APIs. |
| `apps/web/src/components/DeliveryBadge.tsx` | Unused component depends entirely on old comment delivery types; reference search found no consumers. Remove it. Current Live uses run-input status rendering instead. |
| `apps/web/src/components/TicketPanel.tsx` | Remove obsolete `comment_queued` and `comment_delivered` cases from `describeEvent`. No matching event producers were found in tracked application/shared code. Keep `run_input_status` and Live/Runs rendering. |
| `apps/web/src/App.tsx` | Remove references to comments in ticket/project deletion confirmation copy; do not change deletion behavior. |
| `apps/web/src/app.css` | Remove `.comment-*` and old DeliveryBadge-only `.delivery-*` rules. Split the combined `.comment-edit textarea, .ticket-composer textarea` selector so the active composer retains styling. Do not remove adjacent generic styles merely because they are nearby. |

#### Tests and smoke requiring updates

- `apps/server/test/comments.test.mjs`: replace old CRUD-success coverage with retirement checks for all four routes. Exercise actual application route registration (not an empty Fastify instance that trivially returns 404); choose the smallest test seam during implementation.
- `apps/server/test/agent-runs.test.mjs`, `handover-completion.test.mjs`, `live-replay.test.mjs`, `steering.test.mjs`, and `apps/server/smoke/pi-integration.mjs`: remove obsolete `commentIds` from prompt fixtures while preserving session, handover, replay and steering coverage.
- `apps/server/test/prompt-builder.test.mjs`: remove obsolete empty-comment-ID assertions; retain prompt ordering, stage and queued-input assertions.
- `apps/server/test/queue-manager.test.mjs`: the Stop-during-worktree-setup test inserts an unrelated pending comment and asserts it remains pending. Remove that fixture/assertion; retain interrupted-run, no-agent-start and `run_inputs.UNDELIVERED` checks.
- `apps/web/test/ticket-api.test.mjs`: remove comment endpoint expectations and imports. Move generic backend-error and unreachable-backend coverage from comment calls to a retained API.
- `packages/shared/test/contracts.test.mjs`: remove positive ticket-comment schema tests/imports. Retain run-input contract tests; the negative `delivery_type: "COMMENT"` test is valid rejection coverage, not an active comment feature.
- `apps/web/test/ticket-panel.test.mjs`: retain the assertion that Timeline/Comments are absent. Negative removal tests may intentionally mention retired names.

#### Step 3 schema inventory

- `apps/server/src/db.ts`: migration 1 creates `ticket_comments` and `validation_snapshots.comments_watermark`. These are the two comment-only schema objects found. Migration 4 already adds the replacement `messages_watermark`; keep it.
- `apps/server/test/db-migrations.test.mjs`: current fixture/assertions explicitly require legacy-comment preservation and presence of the table on fresh initialization. Replace those expectations with final-schema absence checks while retaining run-input, transcript-boundary, constraints and versioning coverage.
- Recommended minimal implementation: retain existing migration history and add a versioned removal migration for the table and old watermark column. Fresh initialization runs the chain and ends comment-free. Do not make application startup clear whole databases; the scoped operational reset remains a separate step.
- Historical migration SQL or test fixtures may still mention retired names when needed to prove removal. They are not active product functionality.

#### Retain / do not change

- Run-input IDs, `reused_from_input_id`, delivery statuses, queued prompts, active steering, immutable transcript references, Live/Runs and message watermarks.
- Generic source-code comments and unrelated CSS/components.
- The v2 plan/PRD references documenting retirement and the rectification log itself; no stale legacy-preservation requirement was identified in those current documents.
- `archived/local-agent-kanban-implementation-plan.md` and `archived/local-agent-kanban-prd.md`: historical documents, not active requirements; do not rewrite history to erase mentions of comments.
- At audit start, the working tree already showed deletions of `phase-6a-baseline.md`, `phase-6a-pi-spike.md`, and `phase-6a-reset-record.md`. This step neither made nor restored those deletions. The earlier requirements edits and this untracked log were also present.

#### Sequential handoff

Step 1 is complete. Next, remove the application feature and update affected tests/smoke fixtures (Step 2), then remove final-schema objects and update migration tests (Step 3). Only afterward inventory and confirm database reset targets (Step 4), run full exit verification (Step 5), and record the gate decision (Step 6). No database reset paths were approved or operated on during this audit.

## Implementation entries

### 2026-09-29 — Step 2: retired comment application functionality removed

Changes:

- Deleted `apps/server/src/comments.ts` and its import/registration in `apps/server/src/index.ts`. No legacy GET/POST/PATCH/DELETE endpoint remains registered.
- Deleted the unused comment-based `apps/server/src/agents/steering.ts`. Removed `RunPrompt.commentIds`, comment delivery/reversion helpers in `prompt-builder.ts`, and their callers in `run-manager.ts`. Removed the now-unused `sawUserMessage` flag/return member; retained entry-appended delivery attribution and run-input failure handling.
- Removed all ticket-comment types and schemas from `packages/shared/src/index.ts`. Kept run-input contracts, delivery states and reuse links.
- Removed comment load/create/edit/delete functions and declarations from `apps/web/src/ticket-api.*`. Removed the request helper's `expectJson` option, whose only false-valued caller was comment deletion; retained APIs all require JSON responses.
- Deleted unused `apps/web/src/components/DeliveryBadge.tsx`; removed its CSS and `.comment-*` CSS, preserving `.ticket-composer textarea` styling and unrelated generic styles. Removed obsolete comment event rendering in `TicketPanel.tsx` and comment wording in `App.tsx` deletion dialogs.
- Updated server prompt fixtures in agent-run, handover, replay and steering tests and `apps/server/smoke/pi-integration.mjs` to use `inputIds` without `commentIds`.
- Updated prompt-builder tests to assert ordered run-input IDs rather than empty comment IDs. Removed the unrelated legacy-comment fixture/assertion from the Stop-during-worktree-setup test while retaining run-input undelivered checks.
- Replaced `apps/server/test/comments.test.mjs` with a production-entrypoint regression test. It launches the actual server against a seeded temporary database with an isolated working directory and port, verifies a real task is visible, and checks all four retired endpoints return Fastify's route-not-found response. It does not rely on a missing task/comment response or an empty test server. Child process and temporary database are cleaned up.
- Updated web API tests to cover retained run/history/steering contracts and exercise backend-error/unreachable-backend behavior through retained APIs. Removed shared comment-schema tests while preserving their unrelated run-reason-code checks. Kept negative tests for absent Timeline/Comments and rejected COMMENT delivery type.

Verification:

- `npm run typecheck`: passed for shared, server and web.
- `npm test`: passed, including production builds; shared 9, server 67, web 16 (92 total; zero failures, cancellations or skips).
- Suite coverage included the new real-server route-removal test, controlled-session two-ticket reconnect/history, steering/finalization, component interactions and real-Git checkpoint tests.
- `git diff --check`: passed (Git emitted only existing LF/CRLF conversion warnings).
- Reference search across tracked `apps/` and `packages/`: remaining comment/Timeline matches are schema/migration tests reserved for Step 3 and intentional negative removal tests. No remaining active comment API, UI, shared contracts or prompt/steering functionality was found.
- Real-Pi smoke was NOT run in this step; only its prompt fixtures were updated. No claim of full exit-gate completion.

Scope and handoff:

- `apps/server/src/db.ts` and `apps/server/test/db-migrations.test.mjs` are unchanged. The comments table and old watermark still exist until Step 3; the old preservation assertions currently still pass for that reason.
- No persistent pre-existing application database was reset during Steps 2–3. Tests use isolated databases; the production-server route test uses only its temporary database. No session/worktree/repository cleanup beyond isolated test cleanup was performed.
- Previously observed deletions of the three Phase 6A record documents were left untouched.
- Step 3 schema cleanup and migration tests were completed next (see following entry). Step 4 database-path confirmation/reset and Step 5 real-Pi/full exit verification remain pending.

### 2026-09-29 — Step 3: comment-only schema objects removed

Changes:

- Added schema migration 7 in `apps/server/src/db.ts`. It drops the historical `ticket_comments` table and `validation_snapshots.comments_watermark`. Existing versioned history remains intact; `messages_watermark`, run inputs, transcript boundaries and transcript-entry storage remain.
- Updated `apps/server/test/db-migrations.test.mjs`: a pre-v4 database upgrades through migration 7, removes its old comment table, retains run-input/transcript schema and preserves message watermark support. A fresh database also ends at version 7 with no comment table/column. The historical fixture starts at versions 1–3 so it exercises the upgrade chain.
- No runtime database outside these isolated migration tests was opened, reset or changed.

Verification:

- Server build and focused migration tests: passed (2/2).
- `npm run typecheck`: passed for shared, server and web.
- `npm test`: passed, including production builds; shared 9, server 67, web 16 (92 total; zero failures, cancellations or skips).
- `git diff --check`: passed (Git emitted only LF/CRLF conversion warnings).
- Tracked source now mentions `ticket_comments` / `comments_watermark` only in historical migration creation and the new removal migration. Tests mention the identifiers only to verify old-schema removal. No application behavior reads or writes them.

At the time Step 3 closed, Step 4 reset and Step 5 real-Pi/full exit verification remained pending; both are recorded below.

### 2026-09-29 — Step 4 inventory completed; reset awaits scope confirmation

Read-only inventory findings:

- No `KANBAN_*`, `PORT`, or `NODE_ENV` environment overrides were present in the audit shell. Source defaults to relative `data/kanban.sqlite`; the normal server workspace location is `apps/server/data/kanban.sqlite`. Repository-root `data/kanban.sqlite` is absent.
- Three SQLite database files exist under `apps/server/data/`:
  - `apps/server/data/kanban.sqlite` — apparent active application database; 135,168 bytes; schema versions 1–6; 2 tasks; currently still has historical comment schema because it has not yet run migration 7.
  - `apps/server/data/security-smoke.sqlite` — security-smoke database; 4,096 bytes; schema version 1; 0 tasks; has WAL/SHM sidecars.
  - `apps/server/data/backups/kanban-pre-phase6a-reset.sqlite` — explicitly named pre-reset backup; 106,496 bytes; schema versions 1–3; 13 tasks; has sidecars.
- Read-only SQLite inspection was used; no app data was changed. Existing `apps/server/data/sessions/` and root `data/sessions/` contain session files and are outside reset scope.
- One Node process was found, PID 3476, running the Pi CLI (`pi-coding-agent ... cli.js -c`), not the Kanban backend. No listener was reported on ports 3000 or 5173. A separate tool-created temporary route-test server had already exited with its test.
- The normal backend process was therefore not observed as running during inventory. This is not proof another process cannot start before reset; recheck immediately before any destructive operation.

User explicitly selected the scope “Clear all three DBs including backup.” At 2026-09-29, after immediately rechecking processes/ports, deleted each selected database and its SQLite WAL/SHM/journal sidecars, then initialized a fresh schema at each same path with the current migration code:

- `apps/server/data/kanban.sqlite`
- `apps/server/data/security-smoke.sqlite`
- `apps/server/data/backups/kanban-pre-phase6a-reset.sqlite` (the old backup contents are intentionally gone; the path now holds a new empty database)

Post-reset read-only verification for all three: schema versions `[1,2,3,4,5,6,7]`, zero tasks, `PRAGMA integrity_check` = `ok`, no `ticket_comments` table, no `comments_watermark` column, and `messages_watermark` remains. No other SQLite files were found under the repository data roots; root `data/kanban.sqlite` remains absent. Session directories, repositories and worktrees were not targeted or deleted.

### 2026-09-29 — Step 5: Phase 6A verification checks run

- Harness review: `apps/server/smoke/pi-integration.mjs` uses a temporary directory for its SQLite DB and session files and removes that directory in `finally`. It does not point at application DBs or persist worktree changes. Proceeded after confirming this isolation.
- `npm run typecheck`: passed for shared, server and web.
- `npm test`: passed, including builds and all shared/server/web suites (9 + 67 + 16 = 92 tests; zero failures, cancellations or skips).
- Tests include controlled-session two-ticket refresh/reconnect/history and cross-talk checks (`phase6a-acceptance.test.mjs`), steering identity/delivery and finalization control-flow checks (`steering.test.mjs`), and actual temporary-Git-worktree checkpoint commit/failure-preserves-files tests (`worktree-manager.test.mjs`). These checks passed in the full suite. Step 6 review below identifies a gap in the late-steering handover evidence.
- `npm run smoke:pi`: passed against the configured real Pi provider. It verified repeated runs and fresh-manager restoration on one persistent session, real Pi WebSocket events and steering delivery, and abort during real streaming. The smoke printed PASS for all three scenarios.
- Post-check: no `kanban-pi-smoke-*` temporary directory remained. All three reset DBs still have zero tasks, version 7 and `integrity_check=ok`; root `data/kanban.sqlite` remains absent.
- `git diff --check`: passed (line-ending conversion warnings only).
- No new application-data reset or session/worktree deletion occurred during verification.

Step 5 is complete. Step 6 review and gate decision are recorded below; production-questionnaire-extension compatibility remains a separate Phase 7 kickoff prerequisite.

### 2026-09-29 — Step 6: gate reviewed; not yet passed

Criterion review:

- Ticket comments absent: supported by the production-server test returning 404 for old GET/POST/PATCH/DELETE routes, source removal, and version-7 schema tests.
- Database reset: all three user-confirmed SQLite paths were cleared/reinitialized and verified empty, valid and comment-schema-free.
- Two concurrent refreshed tickets: covered by `apps/server/test/phase6a-acceptance.test.mjs`; controlled-session coverage is complemented by the separate passing real-Pi history/restore smoke.
- Typecheck/full suite, steering, checkpoints and real-Pi smoke: passed as recorded in Step 5.
- Single authoritative handover after accepted guidance: initial review found an evidence gap: the old `steering.test.mjs` seeded `handover_json` with `{}` and manually advanced `handover_input_sequence`, bypassing `submit_handover`. Corrected in the follow-up entry below.
- Stop during finalization drain: was uncovered at the time of this initial review; the focused test and result are recorded in the next entry.

Decision recorded in `local-agent-kanban-implementation-plan-v2.md`: **NOT YET PASSED** pending resolution of the observed stale-candidate exposure after Stop. Phase 8 validation and Phase 9 merge remain out of scope. Production questionnaire-extension compatibility remains a separate Phase 7 kickoff prerequisite.

### 2026-09-29 — Late-steering handover test corrected

- Reworked `apps/server/test/steering.test.mjs` to use the actual registered `submit_handover` tool from the fake session factory. It submits and persists an initial candidate before steering, delivers the accepted late input, allows the real run-manager update-prompt path to execute, then submits the replacement through the same tool.
- Removed the direct SQL mutation of `handover_input_sequence` and the seeded empty `{}` `handover_json`.
- The test now asserts late sends after closure return 409, the run completes to Review, the final watermark is 1, and the final persisted handover payload contains the updated outcome/evidence reflecting the late guidance. It also queries the Runs endpoint and verifies exactly one run is listed with that final handover.
- Verification: server/shared build plus focused steering tests passed (6/6); `npm run typecheck` passed; `npm test` passed all 92 tests (9 shared, 67 server, 16 web); `git diff --check` passed (line-ending warnings only).
- This closes the late-steering handover evidence gap. The stale-handover revision evidence gap is closed. However, the Phase 6A gate remains **NOT YET PASSED** because Stop-during-drain behavior is unresolved (see next entry). No production code changed in this follow-up; no databases were touched. The production questionnaire-extension compatibility check is still separate for Phase 7.

### 2026-09-29 — Stop-during-finalization-drain test added; failure observed

- Added a focused case to `apps/server/test/steering.test.mjs`. It submits an initial candidate using the actual `submit_handover` tool, accepts and delivers late guidance, allows the run manager to enter its second/update prompt, then stops the run while that prompt is held open. It checks interruption status, `USER_STOPPED`, Review state, truthful delivered-input status, and the Runs endpoint result.
- Ran only `node --test --test-name-pattern='Stop during handover drain' apps/server/test/steering.test.mjs` as requested. Result: **failed at the final Runs handover assertion**. Earlier assertions passed: run status was `INTERRUPTED`, reason was `USER_STOPPED`, task returned to `REVIEW`, delivered guidance remained `DELIVERED`, and the Runs endpoint returned exactly one run.
- Failure finding: the Runs endpoint returned the earlier `Initial candidate` handover instead of `null`. `RunManager.markStopped()` marks the run interrupted but leaves `handover_json` intact; `registerTaskRunRoutes` returns it regardless of status; `HandoverCard` renders any non-null handover without filtering by run status. Thus an interrupted run can show a provisional, outdated candidate as its result.
- At the time of this failure, no production code was changed; the red test was retained for evaluation. The user then approved preserving the candidate internally while suppressing it from Runs and continuing only through a new explicit prompt. The implementation and verification are recorded below.

### 2026-09-29 — Interrupted handover suppression and explicit continuation implemented

- `apps/server/src/task-runs.ts`: Runs responses now expose `handover` only for `COMPLETED` runs. The provisional `handover_json` remains stored internally for interrupted/failed runs; no destructive clearing or migration was added.
- `apps/web/src/components/HandoverCard.tsx`: interrupted runs with no final handover say the run stopped before the final handover and invite the user to enter a new prompt in Live. Failed runs have distinct no-final-handover copy. The existing Live composer remains the explicit, confirmed continuation path; no automatic retry or new retry button was added.
- `apps/web/test/ticket-panel.test.mjs`: verifies the interrupted message, absence of the stale candidate, completed-handover rendering, and that the composer/stage picker remains available for a Review/INTERRUPTED ticket.
- Expanded `apps/server/test/steering.test.mjs` Stop-during-drain scenario: asserts the run becomes `INTERRUPTED` / `USER_STOPPED`, task returns to Review/Interrupted, already-delivered guidance stays `DELIVERED`, and Runs returns no handover for the interrupted run. It then submits a new prompt through the actual queue HTTP route, verifies a distinct run uses the same session ID, checks the new initial input is delivered and both old/new inputs remain in Live history, and confirms Runs shows the completed follow-up's final handover only.
- Focused Stop-during-drain test passed. Web component test passed. All steering tests passed (7/7). An initial full-suite attempt exposed fixture leakage: fake-session prompt entries affected two unrelated steering tests. Scoped that behavior to only the follow-up-recovery scenario; rerun succeeded.
- Final verification after the fix: `npm run typecheck` passed; `npm test` passed 93 tests (shared 9, server 68, web 16; zero failures); `git diff --check` passed. Earlier real-Pi smoke and checkpoint real-Git tests remain passing as recorded in Step 5; this change only affects Runs serialization/presentation and tests.
- Step 2 and Step 4 requested behaviors are verified. The Phase 6A exit gate can now be recorded as **PASSED** in the authoritative plan. Production questionnaire-extension compatibility remains a separate Phase 7 kickoff prerequisite.

### 2026-09-29 — Phase 7 requirements review and acceptance tests

- Reviewed the Phase 7 plan/PRD, installed `pi-questions` extension, and Pi 0.84.4 extension/TUI/RPC/session-format documentation. An isolated in-memory hosted `createAgentSession()` probe confirmed the default context is `print` with no UI and loads the home `questionnaire` extension; its TUI-only tool is incompatible with the Kanban server. The user-global extension remains untouched.
- Recorded the repo-owned Pi code boundary under `apps/server/src/pi/`, with SDK/server tools separate from TUI-only adapters. Phase 7 remains test-first; no production code or persistent database was changed.
- Added the hosted TUI compatibility characterization, migration/API/service tests, SDK-tool and transcript-recovery tests, queue/Stop tests, and pending/answered panel coverage. Initial test run showed expected missing behavior: migration 8, request service/routes, Kanban tool, answered tool-result repair, and Stop support for waiters. The existing scheduler test for a persisted waiter starting other work passed. Typecheck and `git diff --check` passed. See later Phase 7 review entry for the updated red-test status.

### 2026-09-29 — Phase 7 acceptance-test review and implementation plan refined

Scope remained test-first: no Phase 7 production code, global extension, provider call, or persistent database was changed.

- Added a hosted Pi `AgentSession` contract test for the planned repo-owned `kanban_questionnaire` tool. It specifies multi-question parameters, stable IDs, option selection, custom text, structured answers, and cancellation; the separate inline TUI-only fixture still records why the home extension is incompatible. The tool test is currently red because the planned `apps/server/src/pi/questionnaire-tool.ts` export does not exist.
- Expanded the service/scheduler contract: a persisted answer queues continuation, but the tool wait is not resolved until capacity is granted. The live queue test drives a service callback through park, competing work, answer, queued continuation, and same-session resume using controlled fake runs. This remains a scheduler seam test, not real Pi turn-suspension integration.
- Added unanswered-restart characterization: no tool result, provider prompt, replay, or status repair is allowed; the request remains pending and the run stays `WAITING_FOR_HUMAN`. Answered-restart repair remains covered separately. Cleanup is registered immediately after temp resources are created.
- Added the web interaction test for the user-selected Pi-style tab/review flow: option and free-text drafts persist across tab changes, all answers are submitted as one batch, ordinary guidance is disabled, and Stop submits no partial answers. The test uses a fetch stub and currently fails on the expected absent question UI; it is not an API-backed refresh/reopen test.
- Independent review found no critical test defects and confirmed the multi-question interaction coverage. Remaining explicit gates: test production Pi resource-loader isolation (exclude incompatible `pi-questions` while preserving other user extensions), connect scheduler behavior to an actual Pi continuation/tool result, test the real HumanRequest service through API routes, test API-backed Live refresh/reopen, and cover queued Stop plus multiple/mismatched dangling-call recovery. Controlled seams do not prove these integrations.
- Verification: `npm run typecheck` passed; updated `.mjs` tests passed `node --check`; `git diff --check` passed (only Git LF/CRLF conversion warnings). Focused Pi compatibility run: inline TUI characterization passed, repo-owned tool contract failed on the missing module as expected. Focused web interactions failed on missing question UI. Focused answered-restart repair failed because no tool-result repair exists; unanswered-restart characterization passed. The live queue test is expected red on the absent HumanRequestService export. These are intentional test-first failures, not a Phase 7 gate pass.
- Refined `local-agent-kanban-implementation-plan-v2.md` with the confirmed one-request/multiple-question contract, selected tab/review/batch UI, answer shape, and gated incremental sequence. No implementation, retries/replay, global extension changes, or data reset occurred.

### 2026-09-29 — Remaining Phase 7 acceptance specifications completed

Scope: test and plan updates only. No Phase 7 production features, global Pi extension, provider request, or persistent database were changed.

- Added a production-path `AgentManager` test using `PI_CODING_AGENT_DIR` pointed at a temporary fixture directory. It proves the default hosted session discovers the configured extensions, must exclude the TUI-only `questionnaire`, retain another user extension, and register `kanban_questionnaire`.
- Added a real hosted `AgentSession.prompt()` acceptance test driven by a deterministic in-process stream (no provider/network request). It exercises the questionnaire tool through `HumanRequestService`, `QueueManager`, `RunManager`, and `AgentManager`; a competing run owns the released slot, the accepted answer cannot resume Pi early, the original run operation resumes after capacity returns, and one correlated tool result appears in the persisted session/Live snapshot. The older direct/fake scheduler case is now explicitly named as a seam test.
- Expanded restart repair to two matching answered dangling calls, one pre-existing tool result, an unanswered call, and an answered ghost request with no matching tool call. Added a migration uniqueness assertion for one request per Pi tool-call ID. Added Stop coverage for an answered continuation queued behind another active task.
- Replaced the Human Request API route's local validation stub with the real `HumanRequestService`; it asserts persisted answers are returned after a fresh list request. The web close/reopen test now uses actual service/routes and the real Live-history route, reopening once while pending and once after answering; its fixture appends the matching tool result to the persisted session to exercise Live rendering. The actual Pi continuation is covered separately by the server integration test.
- Final independent review found no critical defects or remaining warnings in these acceptance specifications. The reviewer confirmed the hosted-session/queue path, multiple-call restart cases, per-tool-call uniqueness, and pending/answered API-backed panel reopen coverage. This is test coverage approval only, not a Phase 7 implementation pass.
- Verification: `npm run typecheck`, `node --check` on updated MJS tests, and `git diff --check` passed. Focused red tests stop at the expected missing production behavior: the configured Pi loader still exposes the TUI-only tool; schema is before migration 8; and the questionnaire tool/service/routes, wait/resume scheduler, restart repair, and UI are not implemented. No external provider call or persistent data reset occurred.

### Step 1 — Migration and shared Human Request contract

Implemented only Step 1 of the sequential Phase 7 plan:

- Migration 8 adds nullable `questions_json` / `answers_json` columns to `human_requests`, retains all legacy columns and rows, and creates a partial unique index for `(session_id, tool_call_id)` when both identities are present.
- Added shared Zod schemas/types for request status, question/option sets, answer input batches, normalized answers, and Human Request records. Question sets require at least one valid question and unique stable IDs; a question must offer choices or permit custom text.
- Expanded migration coverage to verify upgrading a legacy schema through v8 retains legacy answer data and leaves new structured fields null; migration acceptance verifies structured persistence and duplicate tool-call rejection. Added shared-contract validation coverage.

Verification passed: `npm run build --workspace @kanban-board/shared`, `npm run build --workspace @kanban-board/server`, focused `node --test apps/server/test/human-request-migrations.test.mjs apps/server/test/db-migrations.test.mjs packages/shared/test/contracts.test.mjs` (13/13), `npm run typecheck`, syntax checks for the changed MJS tests, and `git diff --check`. No service/API/tool/scheduler/UI implementation was started; no provider call or persistent DB reset occurred.

### Step 2 — Durable Human Request service

Implemented `apps/server/src/agents/human-requests.ts` only; HTTP routes and Pi/queue integration remain for later steps. The service persists requests before calling `onWaiting`, exposes task-scoped reloads, validates exact answer coverage and option/custom-text rules, normalizes answers with labels and one-based option indices, and performs answer/cancel transitions atomically. Identical answer retries are idempotent; conflicting answers fail. `answer()` schedules through `onAnswered` but does not release the parked tool Promise; only explicit `resume()` does. `cancelForRun()` cancels pending rows and rejects every in-memory waiter for that run while preserving already-committed answers. Legacy single-question records are mapped for list compatibility. Independent review found no remaining critical issues or warnings after tightening waiter registration, answer-vs-wait-hook failure handling, and legacy custom-answer projection.

Verification passed: server build; focused migration, service, and shared-contract tests (15/15); `npm run typecheck`; MJS syntax checks; and `git diff --check`. No API, tool, scheduler, restart recovery, or UI implementation was started; no provider call or persistent database reset occurred.

### Step 3 — Human Request HTTP API

Added `apps/server/src/agents/human-request-routes.ts` with task-scoped list, validated batch-answer, and per-request Stop endpoints. List verifies that the task exists; answer uses the shared batch schema and maps validation/not-found/conflict failures to HTTP statuses; Stop resolves the owning run and delegates to the existing queue Stop path. Registered the service/routes in `apps/server/src/index.ts`. All endpoints inherit the server's existing local host/origin request guard. Scheduling hooks are intentionally no-ops until Step 5 connects the service to the agent lifecycle.

Verification passed: server build; focused Human Request migration/service/API and shared-contract tests (16/16); `npm run typecheck`; changed MJS syntax checks; and `git diff --check`. No Pi tool, queue lifecycle, restart recovery, or UI behavior was implemented.

### Step 4 — Repo-owned Pi questionnaire tool and loader isolation

Added `apps/server/src/pi/questionnaire-tool.ts` with a TypeBox SDK tool schema, shared-contract normalization, `HumanRequestService` delegation, structured results, and rejection of incomplete batches. Stop/cancellation now propagates as a rejected tool execution rather than a successful “cancelled” result. The active run ID is resolved at tool invocation and retained in the request. `AgentManager` registers the tool and uses `apps/server/src/pi/resource-loader.ts`, which excludes only the configured global `extensions/pi-questions` path while retaining unrelated user extensions. A manager without a queue-backed Human Request service reports that the feature is not configured instead of parking silently; server/queue service injection remains for Step 5.

Independent review found no remaining critical issues or warnings. Verification passed: server build; hosted Pi tool/compatibility and production `AgentManager` extension-isolation/session-reuse tests (4/4); `npm run typecheck`; MJS syntax checks; and `git diff --check`. The full queued `AgentSession.prompt()` acceptance remains gated on Step 5. No external provider call, global extension change, or persistent DB reset occurred.

### Step 5 — Queue lease release, same-run continuation, and Stop

Connected `HumanRequestService` callbacks to the production queue and registered the service with `AgentManager` and `RunManager`. `QueueManager.parkForHuman()` now atomically parks the existing run/job and sets `REQUIRES_HUMAN`, then releases the dispatch lease while retaining the suspended completion promise. An accepted answer moves the same run/job back to the queue; capacity is acquired before `RunManager.resume()` releases the pending tool waiter. The lease can cycle through multiple Human Requests without starting another Pi prompt. Stop cancels unanswered requests and removes answered-but-queued continuations; a Stop that wins before resume prevents answer delivery. Persisted Live history normalizes Pi `toolResult` entries to the web's `tool` role and correlates entries within recorded run boundaries.

The hosted `AgentSession.prompt()` acceptance verifies one correlated result, same-session resumption, and no preemption. Queue lifecycle tests also verify repeated waits, capacity release/reacquisition, and queued Stop. Independent review found no remaining critical issues.

Verification passed: server build; focused Human Request, hosted Pi/queue/Stop, compatibility, and run-route tests (20/20); `npm run typecheck`; and `git diff --check`. No external provider request, global extension change, or persistent database reset occurred. Step 6's session-repair slice is now implemented; startup requeue/resumption of answered requests still needs coverage. The UI and integrated/full-suite gate remain outstanding.

### Step 6 — Answered questionnaire session repair (focused slice)

`AgentManager.openSession()` now checks the saved active transcript before constructing a hosted session. It matches answered requests only to a unique `kanban_questionnaire` call with the same task/session/tool-call ID, appends one correlated tool result, and skips existing results, unanswered requests, duplicate/mismatched calls, and ghost request IDs. It reconstructs summaries from structured answers and legacy single-question rows. Reopening the same session is idempotent.

The focused tests pass (2/2): answered dangling calls are repaired before the session factory runs—including multiple calls, existing results, mismatched/ghost calls, and legacy free-text answers—while unanswered requests stay pending without a tool result or provider prompt. Broader `agent-runs` and queue tests passed (20/20) before the legacy-row assertion was added; after that addition, build, the focused restart tests, typecheck, and `git diff --check` passed. This is not the complete Step 6 gate: startup queue ordering and continuation after an answered request across restart remain unverified/unimplemented. The UI has not been designed or implemented, and the integrated Phase 7 gate has not been run.

### Future requirement recorded — per-agent Pi capability profiles

At the user's request, the plan now includes a future Settings implementation: dynamically resolve role-specific tools, skills, and extensions for Investigation, Implementation, and Validation/Review agents; make profiles configurable in the Settings page; persist configuration in an application-owned JSON file; and test round-trip, role isolation, and changes between runs. This is intentionally separate from Step 5 and has not been implemented.

### 2026-09-29 — Step 6: startup reconciliation and answered continuation completed

- `RunManager.reconcileHumanRequests()` now runs before `QueueManager.initialize()` at server startup. It reconciles durable Human Requests even when their queue row is missing or stale, recreating the job needed to keep a pending request visible and parked. A cancelled job remains stopped; pending requests are not resolved or turned into tool results during restart.
- Answered requests are repaired before any resumed prompt. Recovery requires exactly one questionnaire call and, if already present, exactly one successful matching result that follows the call in the saved Pi branch. Results that precede the call, errors, duplicates, mismatched calls, and ghost request IDs cannot authorize continuation. All durable Human Requests for the run must be answered and correlated before requeueing.
- Recovered continuations are appended after existing queue work. They reacquire a claimed queue slot and continue the same saved session with a distinct continuation instruction; the original user prompt is not replayed. Conditional run/job status updates make Stop win before a continuation starts. Generic orphaned `RUNNING` runs are marked interrupted even if their job is missing or no longer claimed.
- Tests cover pre-park crash recovery, missing queue-row repair, unanswered requests remaining parked, answered tool-result repair/idempotence, early and ghost results, legacy rows, same-session continuation without original-prompt replay, queue ordering, queued Stop, and orphaned RUNNING recovery. Independent review found no remaining critical issues.
- Verification: server build passed; focused `agent-runs`, queue, HumanRequest service, and API tests passed (25/25); `npm run typecheck` passed for shared/server/web; `git diff --check` passed. Only Git line-ending conversion warnings were emitted.
- Step 6 is complete. At this point the web questionnaire UI remained undesigned/unimplemented and Phase 7 was not complete. No global Pi extension change or persistent database reset occurred.

### 2026-09-29 — Step 7: agreed Live-panel Human Request UI implemented

- Collaborated with the user on presentation and workflow: the task remains in the distinct Needs Input (`REQUIRES_HUMAN`) board column, not Review; the question card appears immediately above the Live prompt composer and does not overlay transcript responses; question tabs retain drafts; a final Review tab submits one complete answer batch; Stop submits no partial answers and leaves a compact cancelled card.
- Added `HumanRequestPanel` plus typed API helpers for listing, batch-answering, and stopping requests. `TicketPanel` loads durable state on open/reopen, refreshes while the task/run is active, shows terminal answer/cancel status, and disables ordinary guidance during a pending request. Selected options and custom text are retained separately while switching tabs. Review/edit and API validation errors remain available before or after submission.
- Added interaction and API coverage for choice/free-text drafts, review/edit, one POST batch, disabled guidance, placement above the composer, compact Stop-without-submit behavior, persisted API-backed reopen, and Live tool-result history. Updated the existing static panel test to rely on the interactive integration test for API-loaded requests rather than passing request data as a component prop.
- Independent UI review and integrated Phase 7 review found no critical issues.

### 2026-09-29 — Step 8: Phase 7 integrated gate PASSED

- `npm test`: passed all shared/server/web tests (10 + 86 + 20 = 116; zero failures, cancellations, or skips). This includes migration/service/API contracts, real hosted Pi tool/queue behavior, Stop and queue-capacity cases, both restart boundaries, transcript repair correlation, API-backed Live reopen, and web tab/review/Stop interactions.
- `npm run typecheck`: passed for shared, server, and web. `git diff --check`: passed (Git emitted only LF/CRLF conversion warnings).
- `npm run smoke:pi`: passed all three configured real-Pi checks—persistent-session restart/Live history, WebSocket events and steering delivery, and abort during real streaming. Smoke cleanup is isolated; no persistent application database reset was performed.
- The integrated review covered queue capacity and order, Stop/answer ordering, unanswered and answered restart recovery, no original-prompt replay, extension isolation, and the agreed UI. No critical issues or warnings were reported.
- **Phase 7 gate: PASSED.** Phase 8 and later remain out of scope. Per-agent Pi capability profiles remain future Settings work. No changes were made to the user-global Pi extension.

### 2026-09-29 — Review completion feedback: safe Mark as done

- Added a Review-only completion preview and `POST /api/tasks/:taskId/complete` action. Mark as done is permitted only when there is no active work, the worktree has no uncommitted Git changes, and the task branch still points at its recorded base. Completion removes the clean worktree before moving the task to Done; dirty, changed, unverifiable, or failed-cleanup cases leave the task in Review.
- The panel shows Mark as done only when the backend preview reports readiness. Uncommitted changes require commit/discard before closure; a changed task branch shows a disabled Merge back to source action pending Phase 9. Added the requested Phase 9 policy: after validation and explicit confirmation, successful merge-back closes the task and removes its worktree only when clean.
- Added route/API/UI coverage for clean completion and worktree removal, dirty and branch-changed rejection, retained Review state on rejection, and the Mark as done vs. Merge back UI distinction. Independent review found no critical issues.
- Verification passed: `npm test` (119 tests across shared/server/web), `npm run typecheck`, and `git diff --check`. No application database reset or persistent worktree operation was performed.
- Merge-back execution, validation, and confirmation are intentionally not implemented in this safe-close change; they remain Phase 9 work.
