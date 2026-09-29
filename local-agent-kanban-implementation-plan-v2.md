# Local Agent Kanban — Implementation Plan v2

**Status:** Authoritative v2 implementation reference
**Requirements:** [PRD v2](local-agent-kanban-prd-v2.md)

This replaces `local-agent-kanban-implementation-plan.md` for future work. Preserve
the original as history. This plan describes target behavior, not completed code.

## 1. Current baseline and where to resume

Development stopped after the v1 Phase 6 checkpoint work, committed as `577df52`.
The baseline includes Review actions, user-triggered checkpoints, untracked-file
confirmation, SHA persistence and a basic SHA-pinned checkpoint diff API/viewer.
It still has the retired ticket-comments/Timeline concept and does not implement the
newly confirmed workflow. Existing passing tests do not establish conformance to v2.
Existing application databases are to be intentionally cleared; legacy ticket
comments will not be migrated or preserved.

**Resume at Phase 6A — Direct Messaging and Durable Live Migration.** Do not restart
Phases 0–6 wholesale, and do not jump directly to Phase 7. Phase 6A deliberately
revises parts of Phases 3–6 and brings basic history reconstruction forward from
Phase 12. After its acceptance gate passes, continue Phase 7, then 8 through 13.

```text
0–6   Existing foundation and checkpoint baseline; retain and regression-test
6A    Direct prompts, queued messages, confirmation flow, durable Live history
7     Questionnaire / Requires Human
8     Independent Validation + message-pinned snapshots
9     Diff polish + Merge back to working branch / approval
10    Inference Failure + Compaction
11    Backend Restart Recovery + Git Reconciliation
12    Full Session Rendering Polish
13    End-to-End Hardening
```

## 2. Foundation retained from Phases 0–6

- Phase 0: verify persistent sessions/reopen, event rebinding, steering ordering,
  questionnaire waiting/Stop/crash repair, streaming crash, compaction, profile
  restrictions, Windows process trees, worktree paths/locks, checkpoint Git
  behavior, disposable validation worktrees, merge compare-and-swap and inference
  failure classes. New Phase 6A delivery/history assumptions require focused spikes.
- Phase 1: React/server/shared contracts, SQLite migrations, REST/WebSocket,
  localhost Host/Origin checks and single-instance lock.
- Phase 2: project settings, task worktree creation, short roots, IDE launch,
  status/diff/files, cleanup protection and Git-operation detection.
- Phase 3: persistent working session per task; structured events, task/run/session
  identity, restore and fresh subscriptions; no stdout scraping.
- Phase 4: five-column board remains primary, global queue/max concurrency,
  reorder/remove/Stop and Windows owned-process cleanup; no hard budgets.
- Phase 5: preserve strict stage-specific handovers and single missing-handover
  retry. Replace the retired ticket-comments/Timeline behavior with Phase 6A run
  inputs, not a second input channel.
- Phase 6: retain user-directed checkpointing, SHA persistence and exact-SHA diffs.
  Upgrade always-confirm UX, concurrency guards and post-checkpoint action state.

Pi constraints already established: tools register at session construction; retain
one permissive tool schema with strict stage-specific execution validation rather
than swapping tools on a live session. Pi steer acceptance is not delivery; idle
steering does not start a turn. Verify delivery through actual conversation events.

## 3. Phase 6A — Direct Messaging and Durable Live Migration

Implement in the following order, with a passing verification gate at each step.

### 6A.1 Contracts and clean database initialization

Define run-start request: task ID, stage, nonblank prompt and idempotency identity.
Define run-message request with stable identity and backend-selected queued/steer
routing. Add durable ordered run input records with delivery status/type, accepted
and delivered times, session/transcript entry references, failure reason, and a
link to the original when explicitly reused. Add run transcript start/end boundary
references and a future validation message watermark; retain immutable run history.
Keep the new schema versioned.

Retire ticket comments completely: do not expose comment routes or UI, do not
migrate old comments into run inputs, and do not retain old application data.
Before reset, inventory all configured database paths, stop the backend, and clear
only the confirmed application databases. Do not delete session files, worktrees,
repositories, or unrelated databases. Ensure the final versioned schema and clean
database initialization have no ticket_comments table or comment-only metadata.

Verify: clean initialization has no ticket_comments table or comment records, while
run inputs and transcript history work normally. Contract tests reject blank prompts
and invalid stages, and retries are idempotent.

### 6A.2 Unified Todo/Review start flow

Change queue request and prompt builder so starting a working run requires stage
and explicit prompt. Initial user prompt precedes description; retain title/stage
context. Selection alone never starts work. Atomically save prompt/run/job and
transition to In Progress only after confirmation. Reuse existing task session and
worktree. Eligibility for failed/interrupted recovery must check safe state rather
than being limited forever to completed-review tags.

Verify: Todo and Review starts, missing prompt/stage rejection, confirmation cancel,
queue removal restoring prior state, repeated runs retaining the same session,
and description alone unable to enqueue. Run-level input must not leak across tasks.

### 6A.3 Queued inputs and active steering

Accept messages while queued and combine them in stable send order into the
initial prompt when dispatch starts. Persist acceptance before acknowledging it.
Define one atomic dispatch cutoff; messages racing it enter exactly one path:
initial combined prompt or active steering. Cover the claimed-but-not-yet-ready
session interval without losing or sending messages to an idle session.

Pi `steer()` accepts text, not an application input ID. Therefore delivery must be
coordinated per task session, not inferred from the HTTP response or text alone:

- Assign each accepted input a durable per-session sequence and stable app input
  ID in a transaction before acknowledging it. Record the target task/run/session,
  accepted text, delivery state, and the last known Pi transcript entry ID before
  issuing Pi calls.
- Serialize Pi steer submissions and delivery reconciliation through one session
  coordinator. Preserve acceptance order; never have concurrent backend senders
  race while attributing transcript entries. Retries with the same app input ID
  return the existing record and do not call Pi again.
- On actual Pi transcript append, match the next expected managed user input in
  that session's ordered delivery queue using its expected content and sequence;
  atomically store the exact Pi entry ID and mark that input delivered. Require
  the entry to be a new user-message entry after the recorded transcript boundary.
  Do not mark delivery merely because `steer()` resolved or a message-start event
  arrived without a uniquely attributable entry.
- Identical text is attributed FIFO only when the session's managed send sequence
  and intervening transcript entries make that attribution unambiguous. An
  unexpected/external user entry, missing sequence, branch change, or competing
  writer makes attribution uncertain; stop automatic attribution for affected
  inputs and expose them as delivery-unknown for explicit user resolution.
- Persist send intent and transcript boundary before the Pi call. A crash after
  intent but before provable transcript append must never trigger automatic resend.
  On restart, compare the saved boundary with the active Pi session branch and
  reconcile only a unique, ordered match; otherwise retain an explicit ambiguous /
  delivery-unknown state. Never silently move an input to another task/run/session.

On cancellation/Stop/crash expose undelivered or delivery-unknown guidance for
explicit reuse. The Live UI must provide an explicit **Reuse / Send again** action
for each eligible input; choosing it creates a new input ID linked to the original,
with fresh idempotency and delivery state. Never retry/mutate the ambiguous record
or auto-send reused text. Preserve delivered inputs as immutable transcript
references.

Verify: multiple queue messages combine once, concurrent dispatch/send tests,
steering during tool execution, identical text with distinct IDs, unrelated user
entry interleaving, branch/boundary mismatch, idempotent retry, crash at each
accept/call/append/persist boundary, Stop and queue removal without dropped or
falsely delivered guidance.

### 6A.4 One authoritative handover per run

Treat submit_handover as a candidate until accepted guidance is processed and the
run can close. Late accepted steering requires further response and replacement
of the candidate, not a second authoritative handover. Serialize message acceptance
against finalization; reject sends after closure with a refreshable error.
Retain one missing-handover retry and Review / RUN_FAILED if still absent.

Verify: queued multi-message run, steering near final response, provisional handover
followed by more guidance, Stop during drain, and one final Runs result only.
Normal completion returns to Review without committing anything.

### 6A.5 Durable Live history and stream handoff

Add task-scoped history retrieval from Pi JSONL plus SQLite run boundaries and
queued delivery records. Reconstruct user/assistant/tool messages across working
iterations. Do not duplicate full transcripts into the workflow DB.

Provide event identity/cursors and a race-safe REST-history/WebSocket handoff.
Deduplicate replay against persisted completed messages; maintain provisional text
only for active attempts. Rebind subscriptions after session restoration. Reject
mis-scoped task/run access and ignore stale frontend responses after ticket switch.
Basic history is a requirement here; visual polish stays Phase 12.

Verify: two or more simultaneous tickets with distinct output, refresh each mid-run,
rapid ticket switching, reconnect between snapshot and subscription, replay overlap,
completed-history reopen and bounded-buffer overflow. Backend crash may lose
provisional tokens but must not corrupt or misattribute durable messages.

### 6A.6 Live-first UI and confirmation dialogs

Remove the ticket-comments/Timeline concept entirely. Default to Live; retain Runs
handovers. Show title and description above the initial composer. Start focuses the
same stage/prompt flow.
Todo/Review Send and Enter require both fields and open confirmation; Shift+Enter
adds a newline. Preserve draft on cancel. Retain direct-Implementation warning.
Queued sends append run inputs; running sends steer. Display accepted/pending versus
actually delivered states. Provide an explicit per-input reuse/resend action for
undelivered and delivery-unknown guidance; confirmation creates a new input linked
to the original and never implies the earlier input was delivered. Requires Human
and Done keep their dedicated/read-only controls. Backend remains authoritative for
all eligibility.

Verify with component/browser tests, not just fetch-wrapper tests: gating, Enter,
cancel, queued/running transitions, stream restoration and independent concurrent
panels. Runs still displays the final handover after return to Review.

### 6A.7 Checkpoint UX and safety reconciliation

Always confirm Commit even without untracked files; no prompt required. Include
new-file approval in that dialog and recheck status at execution. Cancellation
leaves Review and work untouched. Block simultaneous commit/start/delete/merge
for the same task; inspect branch identity and in-progress Git operations before
mutating. Preserve index/files on failure without destructive reset.

Persist resulting SHAs consistently, distinguish Git success from DB persistence
failure, and do not blindly retry a commit after an ambiguous failure. Verify
validation invalidation on task-state change rather than merely hiding a UI button.

After a valid clean checkpoint, replace Commit with the Phase 9 merge capability
(unavailable until implemented), retaining Investigation/Implementation. Restore
Commit when further dirty changes need checkpointing. Existing SHA-pinned diffs
must remain stable after later worktree edits.

Verify: tracked-only confirmation, untracked approval/cancel, stale contents,
duplicate requests, concurrent queue/delete, Git failures, dirty primary checkout
untouched, empty worktree, SHA recording, and post-checkpoint action state.

### Phase 6A exit gate

**Decision: PASSED — 2026-09-29.** Evidence against the gate:

- Ticket-comment routes are not registered; the production-server regression test
  verifies legacy GET/POST/PATCH/DELETE paths return 404. Comment UI, APIs,
  shared contracts and active application behavior are removed.
- The three confirmed SQLite files were intentionally cleared and reinitialized:
  `apps/server/data/kanban.sqlite`, `apps/server/data/security-smoke.sqlite`, and
  `apps/server/data/backups/kanban-pre-phase6a-reset.sqlite`. Each is at schema
  version 7, has zero tasks, passes `PRAGMA integrity_check`, and contains neither
  `ticket_comments` nor `comments_watermark`. Paths and scope are in
  `phase-6a-rectification-log.md`.
- `phase6a-acceptance.test.mjs` verifies two simultaneous tickets across refresh,
  reconnect, steering and completion without cross-talk. It uses controlled
  sessions; `npm run smoke:pi` separately verifies real Pi persistent-session
  restoration, event streaming, steering delivery and abort.
- Run-input delivery/reuse, handover retry/failure, checkpoint, migration and
  component behavior have focused suite coverage. `steering.test.mjs` submits
  initial and revised candidates through the actual `submit_handover` tool and
  verifies the final payload/watermark and one Runs result.
- The Stop-during-drain test stops while the handover-update prompt is pending. It
  verifies `INTERRUPTED` / `USER_STOPPED`, delivered guidance remains `DELIVERED`,
  and Runs suppresses the provisional candidate. It then queues a new explicit
  prompt from Review and verifies a distinct run uses the same session, Live history
  retains both runs' inputs, and Runs shows only the completed follow-up handover.
  The component test checks interrupted-run messaging and that the prompt composer
  remains enabled for an explicit continuation.
- `npm run typecheck` passed. `npm test` passed all 93 tests (shared 9, server 68,
  web 16), including real temporary-Git checkpoint commit/failure tests.
  `npm run smoke:pi` passed all three real-Pi scenarios. `git diff --check` passed.

This gate does not claim Phase 8 validation or Phase 9 merge implementation.
Production questionnaire-extension compatibility remains a separate Phase 7
kickoff prerequisite.

## 4. Phase 7 — Questionnaire / Requires Human

Begin only after questionnaire spikes prove waiting, Stop and crash repair.
Persist HumanRequest, park the same session, move to Requires Human and release
local scheduler capacity. Answer persists/displays in Live and requeues without
preemption; continue the same safe tool flow when scheduled. Stop aborts pending
tool/turn and owned children, preserves history/work and returns Review/Interrupted.
Repair incomplete tool history before provider requests after crash.

Verify normal answer, another concurrent run during wait, Stop and backend crash.

## 5. Phase 8 — Independent Validation and Snapshots

User explicitly selects Validate; require a checkpoint, capture current base SHA
and delivered-message watermark, create detached validation worktree and fresh
Review session. Pass task, scoped guidance, handover, diff and exact SHAs.
Build/test/review, detect tracked mutation, clean disposable worktree.

PASSED creates immutable task/base/message snapshot and Ready to Merge.
ISSUES_FOUND becomes Validation Issues; infrastructure/session/tool problems become
Validation Failed. Results appear in Runs/Live. Retry never resumes
an old validation session. Candidate changes invalidate readiness.

Verify snapshot pinning, message selection, worktree isolation and all outcomes.

## 6. Phase 9 — Merge Back and Diff Polish

Implement “Merge back to working branch” for the project's recorded base branch.
Require successful matching validation and explicit approval. A checkpoint alone
must not enable unsafe integration. Expose validation prerequisites clearly.

Unchanged SHAs: final checks, fast-forward, deterministic post-integration verification.
Base moved: persist approval, sync into task, priority fresh validation, recheck
exact SHAs before integration. Priority never preempts an active job.
Conflicts: void approval, manual IDE flow, Abort/Retry/View Conflicts, fresh validation
and fresh approval after resolution. Never auto-resolve. If base moves again, stop
and ask again. Dirty primary checkout is untouched; unchecked-out base uses
expected-old-SHA ref update. Crash drops approval and reconciles Git markers.

Add richer changed-file and unified/side-by-side views, retaining Phase 6's pinned
comparison semantics. Verify every merge race, conflict, cleanup and crash case.

## 7. Phase 10 — Inference Failure and Compaction

Bounded retries for transient connection/502/503 errors, generous streaming timeout,
provisional-delta rollback on retry. No blind identical context-overflow retries.
Use native Pi compaction; offer Continue or Compact & Continue before resuming
sessions at >=60% context. Verify failure classes and consistent reconstructed Live.

## 8. Phase 11 — Backend Recovery and Git Reconciliation

Acquire lock, open DB, inspect jobs/worktrees/Git markers, drop stale approval,
preserve queue order, classify orphaned working runs Interrupted and validation
runs Failed, rebuild human requests, restore sessions/rebind subscriptions, expose
authoritative snapshot. MERGE_HEAD routes to conflict; unexpected rebase/cherry-pick/
revert needs manual recovery. Browser reconstruction from 6A is not a substitute
for backend crash reconciliation.

Reconcile message delivery against actual transcript entries using the persisted
per-session input sequence and Pi entry IDs. Compare only against the recorded
transcript boundary on the active session branch. Mark delivered only on a unique
ordered match; do not infer from a resolved `steer()` call, text alone, or a user
message whose ownership is uncertain. Never resend delivered guidance. Inputs
whose acceptance/call/append boundary cannot be resolved uniquely become
delivery-unknown and are exposed for explicit user resolution/reuse, not silently
retried or attached to another run. No silent resurrection of cancelled runs or
approval. Verify crashes before the call, after the call, after transcript append,
and before SQLite delivery metadata commits, as well as checkpoint persistence,
questionnaire, validation and merge.

## 9. Phase 12 — Session Rendering and UI Polish

Build on already functional durable Live: collapsed reasoning/tools with previews,
per-response Model/Input Tokens/Output Tokens, richer tool renderers, changed-file
sidebar, project filter, Settings, toasts and recovery messaging. Do not reintroduce
Timeline or ticket comments. Keep board primary and Runs handover behavior intact.

## 10. Phase 13 — End-to-End Hardening

- Todo prompt + stage + confirmation → queue → stream → handover → Review.
- Review prompt + stage → cancel (inert) or confirm → same-session iteration.
- Multiple queued messages → combined prompt → one final handover.
- Late steering/finalization races; Stop exposes undelivered guidance.
- Two concurrent tickets; refresh/reconnect/switch with correct output attribution.
- Commit tracked-only and new files; cancel preserves work; dirty-again requires checkpoint.
- Checkpoint diff unchanged by later uncommitted edits.
- Validation pass/issues/infrastructure failure and fresh-session retry.
- Questionnaire capacity release, answer, Stop and unmatched-history crash repair.
- Windows nested process cleanup; worktree lock → Cleanup Pending.
- Merge conflicts, base moving once/twice, dirty primary, compare-and-swap and crash.
- Inference retries/overflow/compaction and provisional text rollback.
- Single-instance exclusion, localhost Host/Origin protection and no cross-task access.
- Clean database initialization contains no ticket-comments schema or data; reset
does not delete session files, worktrees or unrelated databases.

## 11. Verification commands and engineering invariants

Run `npm run typecheck` and `npm test`, plus focused real-Git integration tests and
browser/component tests for the new interaction. Smoke-test Windows process trees
and real session history/rebinding as required; mocks alone do not establish SDK
or OS behavior.

Browser state is never authoritative. Persisted intent is not delivered history.
Git operations are scoped, confirmed and serialized. No automatic checkpoint on
handover, no destructive discard, no auto-resolution/rebase/squash, no approval
surviving crash/manual conflict repair, and no claim that worktrees are a sandbox.
