# Local Agent Kanban — Product Requirements v2

**Status:** Authoritative v2 requirements
**Companion:** [Implementation plan v2](local-agent-kanban-implementation-plan-v2.md)

This document replaces `local-agent-kanban-prd.md` for future development. The
original remains a historical reference. This is a consolidated revision, not
an assertion that all requirements below have already been implemented.

## 1. Product and architecture

Local-first task orchestration for developers on Windows workstations using Pi
Coding Agent, local Git repositories and a shared LAN vLLM inference service.
The Kanban board remains the primary way to manage multiple ongoing tasks and
concurrent agent sessions. Tickets show the corresponding agent conversation.

Retain React/TypeScript, Node/TypeScript/Fastify, SQLite, REST snapshots and
WebSocket live events. Backend-owned AgentSessions survive browser closure.
Pi JSONL owns conversation history; SQLite owns workflow, delivery and queue
metadata; Git owns code state. Never scrape terminal output for agent events.

One global local queue spans projects. `maxConcurrentAgents` controls concurrency.
No team-wide scheduler, strong sandbox, automatic conflict resolution, automatic
rebase/squash, automatic archiving, hard turn/time/token budgets, or remote control
API is introduced by this revision.

## 2. Board, projects and task identity

Retain Todo, In Progress, Requires Human, Review and Done. Queueing places a task
in In Progress, even before generation starts. The board remains primary;
project filtering is display-only and never changes scheduling or sessions.

Project settings retain repository root, IDE executable and short worktree root.
Tasks require project, title and description. Title/description remain editable
before agent work begins and immutable afterward. Done is read-only and cannot
be reopened in MVP. Global Investigation, Implementation and Review profiles
remain; project-specific profiles are future work.

## 3. Ticket navigation

Ticket tabs are **Live** (default) and **Runs**. Remove Timeline and the writable
comments section. Runs retains the current structured handover presentation.
A new Todo ticket has no agent output: Live shows title, description, prompt
composer and Investigation/Implementation selection.

Live displays submitted user messages, their delivery status, assistant output
and tool activity. It remains available after completion, not only while a run
streams. Closing a panel or refreshing must not stop backend activity.

## 4. Starting and continuing work

### Todo

The user enters a nonblank initial prompt and selects Investigation or
Implementation. Neither the description alone nor selecting a stage starts work.
Start opens/focuses this interaction instead of immediately enqueueing a run.
Send and Enter use the same eligibility and confirmation path; Shift+Enter is a
newline. Send is disabled until both stage and prompt are provided.

Compose the user's initial prompt **before** the description, with title and
stage context. Retain the direct-Implementation warning in the start confirmation.
Only after confirmation is the run queued and the task moved to In Progress.
Cancelling preserves the draft and leaves task/queue state unchanged.

### Review

Investigation and Implementation follow the same stage + nonblank prompt rule.
Send/Enter opens a confirmation popup. Confirming atomically persists the input,
creates the run/job, and moves the task to In Progress. Stage selection alone has
no side effects. Use the same persistent working session and task worktree.

Commit is the prompt-free exception described below. Other workflow actions such
as validation, questionnaire answers and merge keep their own safety prerequisites;
they are not ordinary prompts that automatically launch a working run.

### Queueing and active steering

While a run is queued, each send attaches durable text to that exact run in send
order. Combine queued messages into one prompt with the run's initial instructions
when dispatch begins. They are not Pi steering sent to an idle session.

Once actively running, new sends use Pi steering at supported turn boundaries.
The backend, not a stale browser state, chooses the correct delivery path.
Serialize message acceptance with dispatch so every accepted message is included
in either the queued prompt or live steering exactly once. Duplicate HTTP retries
must not duplicate jobs or guidance.

Acceptance into Pi's steering queue is not delivery. Pi `steer()` has no
application input-ID parameter, so the backend assigns a stable ID and per-session
sequence in SQLite, records the active transcript boundary, then serializes Pi
steering and delivery reconciliation for that session. Mark delivery only when a
new user entry on the active Pi session branch can be uniquely matched in managed
send order; persist its Pi entry ID. Identical text may be matched FIFO only when
no intervening/unmanaged entry, branch change, or competing writer makes ownership
ambiguous. A resolved `steer()` call alone is not proof of delivery.

The Live UI must provide an explicit **Reuse / Send again** action for eligible
undelivered and delivery-unknown inputs. Choosing it creates a new input ID linked
to the original with fresh idempotency and delivery state; it never retries or
rewrites the uncertain input, and never sends without the user's action.

On restart reconcile accepted inputs against the saved boundary and active branch.
Never resend a delivered input. If a crash or transcript change makes delivery
ambiguous, mark it delivery-unknown and surface it for explicit user resolution;
do not silently retry or attach it to another run. Messages retain task, run,
session and delivery identity; do not append a separate ticket comment.

## 5. Completion and handover

Investigation/Implementation requires a schema-validated `submit_handover`.
Retain Investigation confidence, outcome, evidence, root cause and recommendations;
Implementation retains files changed, key decisions, limitations and validation
recommendations. Recommended next steps are advisory, not automatic transitions.
Missing handover gets one retry, then Review / RUN_FAILED with HANDOVER_FAILED.

All accepted guidance for a normally completed run must be processed before its
single final handover is authoritative. Queued messages do not each produce a
separate run or handover. If late steering arrives after a candidate handover,
finish processing it and replace the candidate; Runs exposes one final result.
Serialize closure with acceptance; a send after closure is rejected visibly rather
than silently stranded. Failure/Stop may leave undelivered guidance, which must be
shown as undelivered, not falsely marked received.

Successful handover returns to Review with no automatic commit. Runs displays
the handover and Live retains the conversation.

## 6. Checkpoints, diffs and Review actions

Selecting Commit opens a confirmation popup **even with tracked-only changes**.
No prompt is required. List untracked files and require explicit approval to
include them. Commit all intended task changes, including approved new files;
do not force-add ignored files. Recheck status before execution: old confirmation
must not authorize newly discovered files. Serialize against queue start, another
commit, merge and worktree removal for the same task.

Cancel leaves the ticket in Review with all changes preserved. Investigation,
Implementation, Commit and safe close/delete remain available as appropriate.
An empty worktree or Git failure must not be reported as a successful checkpoint.
Record task/run checkpoint SHA only after success. Leave the task in Review.

After successful checkpointing, replace Commit with **Merge back to working
branch**, meaning the project's recorded base branch. Investigation and
Implementation remain available. Merge ships in Phase 9; before then it must
not execute or imply integration is available. New dirty work restores the need
for Commit; a previously recorded SHA does not prove current work is checkpointed.

Show checkpoint diffs between explicit base/checkpoint SHAs; later uncommitted
edits must not alter that historical comparison. A richer changed-file sidebar,
colored/unified or side-by-side rendering and IDE opening remain planned.

Checkpoint success is not validation or approval. The merge choice must explain
and enforce the validation prerequisites below, not bypass them.

## 7. Validation and safe merge

Validation remains Phase 8 and explicitly user-started. Require a checkpoint and
capture exact task/base SHAs plus a message watermark. Supply title/description,
relevant delivered user guidance through that watermark, latest handover, diff,
files and repository context, not the full working transcript by default.
Use a fresh disposable Review session and detached validation worktree each time.
Build/test must not mutate authoritative task state; unexpected tracked changes
in the validation worktree mean validation failure.

Outcomes remain PASSED, ISSUES_FOUND and VALIDATION_FAILED. Passing creates an
immutable snapshot and Ready to Merge. Store/render results in Runs/Live, not
comments. Retry uses a new Review session. Changing candidate code invalidates
validation; new guidance must not silently count as already validated.

Phase 9 integrates only the exact validated state:
- Same task/base SHAs: final safety checks, fast-forward, deterministic verification.
- Base moved: explicit approval intent, sync base into task, fresh priority validation,
  recheck exact SHAs, then fast-forward if still unchanged.
- Conflicts: stop automation, void approval, manual IDE resolution, new validation
  and fresh approval. Never auto-resolve.
- Base moves again: stop the loop, drop approval and require a new decision.
- Dirty primary checkout: never modify it; explain why integration is blocked.
- Base not checked out: prove ancestry and use expected-old-SHA compare-and-swap.
- Backend restart: approval never automatically resumes.

Review tags remain Investigation Complete, Implementation Complete, Validation
Issues, Validation Failed, Run Failed, Interrupted, Ready to Merge and Merge
Conflict. Recovery actions require safe session/Git state. Done resolutions remain
MERGED or CLOSED. Confirm close/removal, preserve the branch, and do not silently
discard uncommitted work. Cleanup failure uses CLEANUP_PENDING metadata.

## 8. Durable Live history and concurrent routing

Browser refresh must reconstruct previous output and continue the correct ticket's
stream, including when multiple tickets run concurrently. This is required now,
not deferred entirely to the later viewer-polish phase.

Read delivered history from Pi JSONL using persisted session references and run
boundaries. SQLite retains message intent, queued text, delivery identities and
workflow state. Scope every request/event to task/run/session; never infer the
owner from whichever ticket happens to be selected in the UI.

REST history and WebSocket replay need a sequenced handoff: avoid missing events
between loading history and subscribing, and deduplicate overlapping events.
Discard late responses from previously selected tickets. Completed messages are
authoritative; active partial deltas are provisional and need replay while the
backend lives. A backend crash need not preserve exact partial tokens, but must
restore durable history and classify interrupted runs accurately.

Render user/assistant messages, collapsed reasoning/tools and per-response model,
input/output token metadata. Basic reconstruction is Phase 6A; richer polish is
Phase 12. A bounded in-memory live buffer alone is not sufficient history.

## 9. Persistence and migration

Retain projects, tasks, task_runs, agent_jobs, human_requests, validation_results,
validation_snapshots and merge_attempts. Introduce run-scoped input records with
stable ID, task/run, sequence, text, delivery type/status, accepted/delivered time,
session/transcript identity and cancellation/failure information. Exact migration
schema is an implementation detail; distinguish intent from actual receipt.

Replace comment watermarks with message watermarks for future validation.
Remove new comment CRUD from the active API/UI. Preserve existing comments as
read-only legacy data for migration/audit; do not delete them or blindly resend
already delivered content. Surface undelivered legacy guidance for explicit reuse.
On queued-job cancellation or Stop, preserve undelivered inputs visibly; do not
silently inject them into another run. The user may explicitly reuse an eligible
input through Live, creating a new linked input record. Delivered transcript
content is immutable.

## 10. Questionnaire, queue and process safety

Phase 7 questionnaire requests persist outside the in-memory tool Promise. Move
to Requires Human, release scheduler capacity, retain the working session. Answers
are persisted/displayed in Live, requeue without preemption, and resume the same
flow safely. Requires Human uses Answer/Stop controls; ordinary messaging must
not bypass a pending questionnaire. Crash recovery must reconcile unmatched tool
calls/results before sending provider history.

Queue removal returns to previous stable state; Stop aborts generation and owned
Windows child process trees, preserves worktree/history and returns working runs
to Review / Interrupted. Validation Stop becomes Validation Failed. Prefer Windows
Job Objects, with whole-tree taskkill fallback where required. No hard budgets.

## 11. Git isolation and security

Create task branch/worktree at first execution, recording base branch/SHA. Reuse
it across working iterations. Use short external worktree roots and preflight
Windows long paths/locks. Disposable validation worktrees may be removed after
validation; primary worktrees persist until safe close/merge cleanup.

Worktrees are not a hostile-code sandbox. Restrict unnecessary mutation tools,
keep destructive Git/ref actions orchestrator-owned and check repository state.
Unrestricted shell still has developer privileges; do not claim stronger isolation.

Bind control API to localhost, validate Host/Origin and WebSocket Origin, and
hold a single-instance backend lock. Filtering/browser state is never authoritative.

## 12. Inference and recovery

Retain bounded retries for transient connection/502/503 failures and generous
stream timeouts. Roll back provisional text on failed retry attempts. Context
length overflow is not a transient retry; use native Pi compaction/recovery.
Before resuming a session at >=60% context, offer Continue or Compact & Continue.

Startup: acquire lock, open DB, reconcile jobs/worktrees/Git operations, preserve
queue order, mark orphaned working runs Interrupted and validation runs Failed,
rebuild human requests, drop approvals, restore session references/rebind events,
then expose REST snapshots. Reconcile accepted input delivery against the saved
per-session sequence, transcript boundary and active Pi branch. Only a unique,
ordered new-user-entry match proves delivery; persist that Pi entry ID. Never
resend delivered input. Mark unresolved acceptance/call/append cases delivery-unknown
and expose them for explicit user resolution, not automatic retry or reassignment.
MERGE_HEAD means Merge Conflict; unexpected rebase/cherry-pick/revert requires
manual recovery. No automatic destructive repair.

## 13. Acceptance criteria

1. Board manages multiple projects and concurrent sessions; Live/Runs replace Timeline.
2. Todo and Review require prompt + working stage + confirmation; cancelling is inert.
3. Initial prompt precedes description. Selection/description alone never starts work.
4. Queued sends combine in order; active sends steer; dispatch races lose no input.
5. One final handover follows processing all accepted guidance in a normal run.
6. Browser refresh restores history and the correct stream for at least two running tickets.
7. No new comments can be added; legacy data survives migration without duplicate delivery.
8. Commit always confirms; cancellation preserves Review/work; untracked files need approval.
9. Checkpoint diffs stay SHA-pinned despite later edits. Merge remains validation-gated.
10. Questionnaire, validation, merge, inference, process cleanup and restart scenarios
    retain the safety guarantees in sections 7–12.

## 14. Future scope

Keep centralized team scheduling, project-specific profiles, configurable workflows,
stronger sandboxing, hard budgets, archives, remote authentication and issue-tracker
integration outside this change. Merge remains Phase 9, not part of Phase 6A.
