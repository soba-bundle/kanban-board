# Local Agent Kanban
# Implementation Plan

**Status:** Draft v1.1  
**Purpose:** Build the MVP in risk-first order and prove Pi/Git/Windows behavior before depending on it.

---

## 1. Implementation Strategy

Recommended sequence:

```text
Phase 0   Technical Spikes
Phase 1   App Skeleton + Persistence + Local Security
Phase 2   Projects + Worktrees + Git Foundation
Phase 3   Pi Working Session + Live Events
Phase 4   Board + Queue + Stop Controls
Phase 5   Comments + Steering + Handovers
Phase 6   Checkpoint Commit Model
Phase 7   Questionnaire / Requires Human
Phase 8   Independent Validation + Validation Snapshots
Phase 9   Diff + Merge / Approval Workflow
Phase 10  Inference Failure + Compaction
Phase 11  Restart Recovery + Git Reconciliation
Phase 12  Full Session Viewer + UI Polish
Phase 13  End-to-End Hardening
```

The full React workflow should not be treated as stable until Phase 0 proves the risky Pi SDK, Windows process, and Git assumptions.

---

# 2. Phase 0 — Technical Spikes

## 2.1 Pi Spike — Persistent Working Session

Prove:

1. create persistent AgentSession;
2. capture session ID/file;
3. prompt;
4. exit process;
5. reopen session;
6. prompt again;
7. confirm conversation continuity.

Deliverable:

```text
AgentManager.restoreSession()
```

prototype and notes.

---

## 2.2 Pi Spike — Structured Live Events

Capture:

- text deltas;
- completed messages;
- tool start/update/end;
- agent lifecycle;
- usage/model metadata.

Define normalized application events.

Do not scrape stdout.

---

## 2.3 Pi Spike — Restore + Event Rebinding

Prove that when a persisted session is reopened/replaced:

- prior subscriptions are not assumed to remain valid;
- backend can attach fresh subscriptions;
- UI continues receiving events.

---

## 2.4 Pi Spike — Live Steering

Test explicit steering while:

- assistant is generating;
- a tool call is executing;
- multiple steering messages are queued.

Record exact delivery ordering.

Target product behavior:

```text
Live View message
→ accepted for Pi steering
→ append ticket comment
→ mark DELIVERED / STEERING
```

---

## 2.5 Pi Spike — Questionnaire Waiting

Test:

```text
Working session calls questionnaire
        ↓
tool waits locally
        ↓
scheduler logically releases slot
        ↓
another AgentSession runs
        ↓
user answer arrives
        ↓
original session continues
```

Measure:

- AgentSession state while waiting;
- event order;
- JSONL shape;
- whether another session can run normally.

Do not assume this preserves vLLM KV cache.

---

## 2.6 Pi Spike — Stop Questionnaire

While questionnaire is pending:

1. invoke Stop Run;
2. reject/abort the pending tool flow;
3. abort active turn as needed;
4. verify JSONL remains usable;
5. verify session can later continue.

---

## 2.7 Pi Spike — Crash During Questionnaire

Procedure:

1. force questionnaire;
2. persist request externally;
3. kill backend;
4. inspect JSONL;
5. restart;
6. attempt safe session reconstruction;
7. reconcile any unmatched tool call/result;
8. provide recovered human answer;
9. continue session.

The implementation plan must not assume OpenAI-compatible providers accept malformed unmatched tool history.

Deliverable:

documented recovery algorithm.

---

## 2.8 Pi Spike — Crash During Streaming

Kill backend during a long assistant response/tool workflow.

Inspect:

- what JSONL contains;
- whether partial assistant message exists;
- what the reopened session sees.

Verify a continuation prompt works.

---

## 2.9 Pi Spike — Compaction

Verify:

- current context-usage API/metadata;
- native Pi compact invocation;
- JSONL compaction representation;
- continuing the same working session afterward.

This supports the >=60% proactive compaction prompt.

---

## 2.10 Pi Spike — Agent Profiles

Create:

```text
Investigation
Implementation
Review
```

Verify practical tool/skill restriction mechanisms.

Review should not receive explicit edit/write tools.

Document what unrestricted shell can still do so the product does not claim sandboxing.

---

## 2.11 Windows Spike — Process Trees

Create a tool command that spawns nested children such as:

```text
PowerShell -> msbuild/dotnet/test process
```

Prototype:

- Windows Job Object ownership if feasible;
- whole-tree termination;
- fallback `taskkill /T`.

Success:

Stop Run leaves no owned compiler/test processes behind.

---

## 2.12 Git Spike — Worktrees and Long Paths

On representative Windows C++/C# repositories:

- create task branch/worktree;
- use short root;
- test deep paths;
- inspect `core.longpaths`;
- test open Visual Studio handles;
- test cleanup failure.

Document preflight and cleanup-pending behavior.

---

## 2.13 Git Spike — User-Directed Checkpoint Commits

Prototype the checkpoint operation used only after an explicit user action from
Review:

```text
Review → user selects Commit Changes
→ inspect task worktree status
→ if untracked files exist, show paths and request explicit inclusion approval
→ stage all changes (tracked and approved untracked)
→ commit
→ record commit SHA
```

Successful agent handover alone must never commit. Declining untracked-file
inclusion cancels that attempt without changing workflow state or worktree
contents; the ticket remains in Review for another user action. Verify failed or
interrupted runs are never auto-committed and that the primary checkout remains
untouched.

---

## 2.14 Git Spike — Disposable Validation Worktree

Given task commit `T1`:

1. create detached validation worktree;
2. run build/test that creates artifacts;
3. verify authoritative task branch/worktree remains unchanged;
4. detect tracked-file mutation in validation worktree;
5. clean up.

---

## 2.15 Git Spike — Merge / Approval Algorithm

Test:

1. validated task/base unchanged -> fast-forward;
2. base moves -> merge base into task;
3. conflict -> manual IDE flow;
4. manual conflict resolution -> new commit -> revalidation;
5. base moves again during merge-prep validation;
6. dirty primary checkout;
7. base not checked out -> safe expected-old-SHA ref update;
8. backend dies during merge;
9. startup detects `MERGE_HEAD`;
10. unexpected rebase/cherry-pick state.

Deliverable:

production merge state machine.

---

## 2.16 Inference Spike — vLLM Failure Classes

Simulate or mock:

- connection refused;
- HTTP 503;
- stream drop;
- slow stream/read timeout;
- context-length 400.

Define:

```text
transient retry
non-transient context overflow
UI provisional-delta rollback
```

---

# 3. Phase 1 — Application Skeleton + Persistence + Local Security

Create:

```text
apps/
  web/
  server/

packages/
  shared/
```

Implement:

- Fastify/Express backend;
- React frontend;
- SQLite migrations;
- REST contracts;
- WebSocket contracts;
- single-instance application lock;
- localhost-only binding;
- Origin/Host checks.

Initial schema:

```text
projects
tasks
task_runs
agent_jobs
ticket_comments
human_requests
validation_results
validation_snapshots
merge_attempts
task_events (optional)
```

Implement shared enums/schemas.

---

# 4. Phase 2 — Projects + Git Foundation

Settings -> Projects:

- add project;
- validate Git root;
- remove project configuration;
- configure IDE;
- configure short worktree root.

Implement `WorktreeManager`:

```text
createTaskWorktree()
createValidationWorktree()
removeValidationWorktree()
getStatus()
getDiff()
getChangedFiles()
openInIDE()
removeTaskWorktree()
```

At first agent action:

1. capture current branch;
2. capture base SHA;
3. create task branch;
4. create task worktree.

Add Git-operation-state detection utilities.

---

# 5. Phase 3 — Pi Working Session + Live Events

Implement `AgentManager`:

```text
createWorkingSession(task)
restoreWorkingSession(task)
prompt(task, prompt)
steer(task, text)
subscribe(task, handler)
abort(task)
```

Persist working session ID/file.

Normalize Pi events to application/WebSocket events.

Add run-level live event endpoint.

At this phase, prove:

```text
Investigation #1
→ Implementation #1
→ Investigation #2
```

all reuse the same persistent working session.

---

# 6. Phase 4 — Board + Global Queue + Stop Controls

Implement five-column board:

```text
Todo
In Progress
Requires Human
Review
Done
```

Implement one queue across all projects.

Config:

```text
maxConcurrentAgents
```

Implement:

- Todo -> Investigate / Implement Directly chooser;
- direct-Implementation warning;
- queue insertion;
- queue position;
- queue reorder;
- Remove from Queue;
- Stop Run;
- Windows child-process-tree cleanup integration.

No hard turn/time/token budgets for MVP.

---

# 7. Phase 5 — Comments + Steering + Handovers

Implement ticket timeline.

Immutability:

```text
Before first agent run:
description/comments editable

After first agent run:
historical description/comments immutable
new comments append-only
```

Implement delivery metadata.

### Non-running task

Pending comments go into next working-session prompt and are marked delivered.

### Running task

Normal ticket comments remain pending.

Live View prompt uses Pi steering and is appended to comments only after accepted for delivery.

Implement schema-validated:

```text
submit_handover
```

for Investigation and Implementation.

Implement one retry if required handover is missing.

Route repeated failure to:

```text
Review / RUN_FAILED
```

---

## 7.1 Pi SDK Constraints Established Before Implementation

### Tools cannot be swapped on a live session

`customTools` is captured once at session construction and only re-read from that
same private array by the internal tool-registry refresh. There is no public
API to add/replace tools on an open `AgentSession`.

A task owns one long-lived working session across
Investigation -> Implementation -> Investigation, so recreating the session to
change tools is not acceptable.

Therefore `submit_handover` is registered once per session with a permissive
TypeBox parameter schema, and the stage-specific contract is enforced by strict
validation inside the tool execution:

```text
Layer 1  TypeBox (permissive)   what the model sees; union of both variants
Layer 2  Zod (strict)           selected from the active run stage at call time
```

Invalid payloads return a tool error containing field-level messages so the
agent can correct and retry the call itself.

### Steering may be sent directly

`AgentSession.steer()` performs no state check. It expands prompt/skill
templates, pushes onto the internal steering queue, emits `queue_update`, and
forwards to the agent. Delivery happens after the current assistant turn
finishes its tool calls, before the next LLM call.

Consequences:

- while a run is `RUNNING`, steering is sent directly to the session;
- while idle, the queue is in-memory only and triggers no turn, so steering
  must be rejected and the next-prompt path used instead;
- `steer()` resolving means accepted, not obeyed, and not yet delivered.

### Actual delivery is observable

Pi removes a queued steering message from its queue when `message_start` fires
with `role: "user"` and matching text. That is the moment the message enters
conversation history and the JSONL.

This gives an authoritative delivered signal distinct from accepted.

---

## 7.2 Comment Delivery States

```text
PENDING    ordinary comment awaiting the next working-session prompt
QUEUED     steering accepted by Pi, waiting at a turn boundary
DELIVERED  sent to the working session
```

`DELIVERED` is normally permanent. It may only be reset when the comment turns
out never to have entered conversation history; see 13.1.

```text
delivery_type = NEXT_PROMPT | STEERING
```

UI representation:

```text
PENDING    plain
QUEUED     clock icon
DELIVERED  lock icon
```

A run that aborts or ends with steering still `QUEUED` leaves those comments
`QUEUED`. They are never retroactively marked delivered, because Pi's in-memory
queue is lost.

Such comments are stranded: not resent and not editable. See 13.1, where Phase
11 must resolve them.

### Comment mutability rule

A comment may be edited or deleted only when all of the following hold:

```text
author_type     = USER
delivery_status = PENDING
workflow_state  IN (TODO, REVIEW)
```

The workflow-state condition is the important one. Steering is only possible
while a run streams, so restricting mutation to Todo/Review makes a `QUEUED`
comment structurally unreachable for editing. The backend therefore never has
to mutate Pi's live steering queue, and `clearQueue()` / re-steer ordering /
delivery-race handling are all avoided.

Mutability is driven by delivery state, not by whether the task has ever run.
An undelivered comment written during Investigation #1 remains editable once
the task returns to Review, because it has not yet reached the model. Only
historical (delivered) comments are immutable.

`REQUIRES_HUMAN` is excluded because a live session is parked inside a pending
tool call. `DONE` is excluded because nothing further will be sent.

---

## 7.3 Implementation Steps

```text
1. Shared schemas
   ticket comment, delivery status/type, author type,
   Investigation/Implementation handover, HANDOVER_FAILED reason code
   verify: typecheck

2. Comments API + immutability
   GET/POST /api/tasks/:id/comments, PATCH/DELETE /api/comments/:id
   reuse the existing agent-work-started gate used by task editing
   verify: pre-run edit/delete allowed, post-run 409, append always allowed

3. Prompt composition
   extract prompt building out of the queue manager
   include PENDING comments, mark DELIVERED / NEXT_PROMPT at send
   verify: prompt contains pending comments, rows flip, no resend on next run

4. Live steering
   POST /api/runs/:runId/steer, 409 unless a run is RUNNING
   insert comment QUEUED / STEERING when steer() resolves
   flip to DELIVERED on matching user message_start, emit comment_delivered
   verify: idle 409, queued -> delivered transition, abort leaves QUEUED

5. submit_handover tool
   permissive TypeBox params, strict per-stage validation in execute
   persist task_runs.handover_json
   verify: valid persists, invalid returns tool error with field messages

6. Missing handover handling
   re-request once, then Review / RUN_FAILED with HANDOVER_FAILED
   verify: single retry then failure routing

7. Baseline UI
   task detail panel: description, comment timeline with delivery icons,
   composer, handover summary, steering input enabled only while RUNNING,
   live event log over the existing run events WebSocket
   verify: manual end-to-end comment + steer + handover preview
```

The UI here is intentionally minimal; Phase 12 replaces it with the full
session viewer.

---

# 8. Phase 6 — User-Directed Checkpoint Commit Model

A successful Implementation handover does **not** automatically create a commit.
It moves the task to Review with implementation changes uncommitted. In Review,
the user must choose what happens next:

```text
Commit current changes
Continue with Investigation
Continue with Implementation
```

This choice is presented whenever implementation changes reach Review, even
when there are no untracked files. Committing is an explicit user action, not
an automatic side effect of an agent handover.

When the user chooses to commit:

1. inspect task worktree status;
2. if untracked files exist, show their paths and prompt the user to confirm
   including them in the checkpoint;
3. if confirmed (or there are no untracked files), stage and commit all task
   worktree changes, including tracked modifications and confirmed untracked
   files;
4. record the resulting SHA in `task_runs.task_commit_sha` and
   `tasks.latest_task_commit_sha`;
5. return the task to Review with the checkpoint available for the user's next
   decision.

If the user declines inclusion of untracked files, cancel the entire checkpoint;
do not commit only a partial subset. If the worktree is empty or Git cannot
create the commit, report the problem and do not record a successful checkpoint.

The user can choose Investigation or Implementation instead of committing. Any
new agent run uses the existing task working session/worktree, and a subsequent
Review decision again offers all three choices. Interrupted, failed, and
user-stopped work is never automatically committed.

Update diff APIs to support explicit SHA-based diffs.

Add validation invalidation logic if task branch changes after a validated snapshot.

---

# 9. Phase 7 — Questionnaire / Requires Human

Only begin after questionnaire spikes pass.

Implement:

```text
working session
→ questionnaire
→ persist HumanRequest
→ Requires Human
→ release local scheduler slot
```

UI actions:

```text
Answer
Stop Run
```

Answer:

```text
Requires Human
→ In Progress / queued
→ same working session continues when scheduled
```

Stop:

```text
→ abort pending tool/turn
→ kill owned child processes if any
→ Review / Interrupted
```

Implement crash-recovery algorithm established by Phase 0, including incomplete tool-call reconciliation.

---

# 10. Phase 8 — Independent Validation + Validation Snapshots

On user click Validate:

1. require a checkpoint task commit;
2. capture current base SHA;
3. capture comment watermark;
4. create disposable validation worktree at candidate task SHA;
5. create fresh Review Agent session;
6. pass task + comments + handover + diff + SHAs;
7. build/test/review;
8. compare tracked Git state before/after;
9. clean validation worktree.

Outcomes:

```text
PASSED
ISSUES_FOUND
VALIDATION_FAILED
```

If passed, create:

```text
validation_snapshot
validated_task_sha
validated_base_sha
comments_watermark
```

and move to Ready to Merge.

If issues:

```text
Review / Validation Issues
```

If infrastructure/session/tool failure:

```text
Review / Validation Failed
```

Never resume a Validation AgentSession; Retry creates a fresh session.

---

# 11. Phase 9 — Diff + Merge / Approval Workflow

Implement:

- changed-file panel;
- side-by-side/unified diff;
- Open in IDE;
- merge-attempt persistence.

## 11.1 Approve — unchanged base/task

If validation snapshot still matches:

```text
task SHA == validated_task_sha
base SHA == validated_base_sha
```

perform final safety checks and fast-forward.

No extra LLM validation after successful fast-forward.

Perform deterministic post-integration verification only.

## 11.2 Approve — base moved

Persist approval intent.

Then:

```text
merge latest base into task branch
→ if clean, queue priority validation
→ fresh validation snapshot
→ re-check base/task SHAs
→ if still exact, auto fast-forward
```

Merge-prep validation enters queue at priority/front but does not pre-empt a running job.

## 11.3 Conflict

If sync conflicts:

```text
void approval
→ Review / Merge Conflict
```

Offer:

```text
Open in IDE
View Conflicts
Abort Merge
Retry Merge
Close Ticket & Remove Worktree
```

Never auto-resolve.

After manual resolution:

```text
new task commit
→ fresh validation
→ Ready to Merge
→ fresh approval
```

## 11.4 Base changes again

Stop the automatic attempt.

Drop approval.

Return:

```text
Review / Ready to Merge
```

with reason and require fresh approval.

## 11.5 Dirty primary checkout

Do not modify it.

Drop approval and return Ready to Merge with clear instructions.

## 11.6 Crash

Do not resume automatic approval after restart.

Reconcile Git state and require fresh approval.

---

# 12. Phase 10 — Inference Failure + Compaction

Implement inference classification.

### Retry

- connection refused;
- 502/503;
- temporary server failure.

Use bounded backoff.

### Generous timeout

Avoid false failures during slow shared-server generation.

### Do not blindly retry

- context-length exceeded.

Use Pi native compaction/recovery path.

### Streaming retry

Treat text deltas as provisional.

On failed attempt:

1. rollback partial live text;
2. show Retrying;
3. stream replacement cleanly.

### Proactive compaction

After every completed working-session response, capture context usage if available.

Before resuming Session 1 at >=60%:

```text
Compact before continuing?

[Continue Without Compact]
[Compact & Continue]
```

Use Pi native compaction.

---

# 13. Phase 11 — Restart Recovery + Git Reconciliation

Startup order:

1. acquire single-instance lock;
2. open SQLite;
3. inspect jobs/runs;
4. inspect worktrees;
5. inspect Git operation markers;
6. drop stale merge approval intent;
7. preserve queue ordering;
8. classify orphaned working runs as Interrupted;
9. classify orphaned Validation runs as Validation Failed;
10. rebuild Requires Human;
11. reopen persistent working-session references;
12. rebind event subscriptions;
13. expose authoritative board snapshot.

Git reconciliation:

```text
MERGE_HEAD
→ Merge Conflict

unexpected rebase/cherry-pick/revert
→ Run Failed with explanation
```

UI reconnect always begins with REST snapshot, then WebSocket.

## 13.1 Open Issue — Stranded QUEUED Steering Comments

Introduced by Phase 5 and must be addressed here.

Pi's steering queue is in-memory only. A steering comment is recorded as
`QUEUED` when `steer()` is accepted and only becomes `DELIVERED` when Pi emits
the matching user `message_start`. If the backend crashes, the run is stopped,
or the run otherwise ends between those two points, the comment is stranded:

```text
never delivered to the model
not resent, because prompt composition only selects PENDING
not editable, because mutation requires PENDING
```

The human guidance is therefore silently lost while the ticket still shows it
as queued. This includes user-initiated Stop: the Phase 5 implementation
currently leaves the comment `QUEUED`; it does not yet decide whether Stop
should discard that guidance or make it eligible for resend.

Recovery must handle this. The likely fix is to treat `QUEUED` as an
undelivered state at startup and on run termination, and reset it so the text
is resent:

```text
run ended or backend restarted
→ steering comment still QUEUED
→ reset to PENDING (clear delivery metadata)
→ included in the next working-session prompt as NEXT_PROMPT
```

### Delivery lifecycle invariant

The delivery lifecycle is one-way, and the authoritative test is whether the
comment exists in Pi conversation history, not which status column it currently
carries:

```text
in conversation history      -> permanent, never reset, resent, or edited
not in conversation history  -> may be returned to PENDING and sent again
```

`delivery_status` is a record of intent that can run slightly ahead of reality,
so two resets are legitimate. Both restore guidance that never reached the
model:

```text
QUEUED -> PENDING
  accepted into Pi's in-memory steering queue, but the run ended before Pi
  replayed it as a user message
  (this section; Phase 11)

DELIVERED -> PENDING
  NEXT_PROMPT comments are stamped delivered immediately before prompt() is
  awaited; if prompt() throws before the user message is appended, the stamp
  was premature
  (implemented in Phase 5, revertCommentsToPending)
```

The second reset is deliberately narrow: only `NEXT_PROMPT` comments, only
those stamped by the failing run, and only when no user `message_start` was
observed for that run. A comment the model actually saw is never reset, even if
the run later fails.

Related future capability: the user should be able to **delete** a steering
comment that is still undelivered. Deletion is currently blocked because
mutation requires `PENDING` and a live steer is `QUEUED`. Once queued steering
is resolvable (reset to `PENDING`, or made safely cancellable), retracting an
undelivered steering message should be allowed. A `DELIVERED` steering comment
remains permanent.

Decisions still required:

- whether the resend is automatic or surfaced to the user for confirmation;
- whether the timeline preserves the original queued attempt for audit rather
  than mutating the row in place;
- whether a user-initiated Stop should discard the queued guidance instead,
  since the user may have stopped the run precisely because that steer was
  wrong.

---

# 14. Phase 12 — Full Session Viewer + UI Polish

Implement:

- full conversation reconstruction from JSONL;
- reasoning collapsed;
- tool calls collapsed with short preview;
- per-response footer:
  `Model · Input Tokens · Output Tokens`;
- Live View steering;
- changed-files sidebar;
- diff viewer;
- project filter popover;
- Settings UI;
- toasts and recovery messaging.

---

# 15. Phase 13 — End-to-End Hardening

## Scenario A — Normal Flow

```text
Todo
→ Investigate
→ Review
→ Implement
→ checkpoint commit
→ Review
→ Validate
→ Ready to Merge
→ Approve
→ fast-forward
→ Done / Merged
```

## Scenario B — Direct Implementation

Verify warning + checkpoint + validation.

## Scenario C — Repeated Working Session

```text
Investigation #1
→ Implementation #1
→ user comments
→ Investigation #2
→ Implementation #2
```

all in Session 1.

## Scenario D — Live Steering

Send steering during tool execution and verify delivery/comment watermark.

## Scenario E — Questionnaire

Verify:

```text
Requires Human
→ scheduler slot released
→ other task runs
→ answer
→ requeue
→ same session continues
```

## Scenario F — Stop While Requires Human

Verify pending tool is safely aborted and task becomes Interrupted.

## Scenario G — Stop During Build

Verify whole Windows child process tree terminates.

## Scenario H — Crash Mid-Generation

Restart, rebuild UI, mark Interrupted, Continue Session 1.

## Scenario I — Crash During Questionnaire

Use tested unmatched-tool-call recovery.

## Scenario J — Validation Issues

Fresh Session 2 finds issue -> Session 1 fixes -> Session 3 validates.

## Scenario K — Validation Crash

Route to Validation Failed; Retry uses fresh session.

## Scenario L — Manual Merge Conflict

Conflict -> IDE -> manual fix -> fresh validation -> fresh approval.

## Scenario M — Base Moves During Merge Prep

Verify automatic loop stops and fresh approval is required.

## Scenario N — Dirty Primary Checkout

Verify no automatic modification.

## Scenario O — Validation Invalidated

Modify task branch after validation and ensure Ready to Merge is invalidated.

## Scenario P — vLLM 503

Verify retry/backoff.

## Scenario Q — vLLM Context Overflow

Verify no blind retry; compaction/recovery flow.

## Scenario R — Stream Failure

Verify provisional deltas disappear before retry.

## Scenario S — 60% Context Prompt

Verify compaction choice before working-session resume.

## Scenario T — Second Backend

Verify single-instance protection.

## Scenario U — LAN Access Attempt

Verify localhost binding/origin controls reject unintended access.

## Scenario V — Worktree Cleanup Lock

Verify Cleanup Pending rather than destructive deletion.

---

# 16. Recommended First Milestone

Build a technical vertical slice before full UI:

```text
Node/TypeScript
Pi SDK
SQLite
one repository
one task worktree
one persistent working session
one validation session
```

It should prove:

1. persistent session reopen;
2. structured events;
3. working-session context reuse;
4. live steering;
5. questionnaire wait/answer;
6. Stop Run;
7. process-tree cleanup;
8. checkpoint commit;
9. fresh validation worktree/session;
10. validation snapshot;
11. safe diff;
12. crash/restart reconstruction;
13. context compaction;
14. merge safety checks.

Only after these pass should the main workflow be considered technically validated.

---

# 17. Critical Engineering Principles

1. **Backend live state is disposable; durable state is not.**
2. **Browser state is never authoritative.**
3. **Pi JSONL owns conversation history.**
4. **SQLite owns workflow/application metadata.**
5. **Git owns code truth.**
6. **Successful Implementation creates a checkpoint commit.**
7. **Validation is pinned to exact task/base SHAs.**
8. **Interrupted partial work stays uncommitted.**
9. **No automatic conflict resolution.**
10. **No automatic rebase/squash for MVP.**
11. **Approval does not survive manual conflict resolution or backend crash.**
12. **Review sessions are fresh and disposable.**
13. **Working Session 1 preserves Investigation/Implementation context.**
14. **Stop Run must terminate owned child processes, not only Pi.**
15. **Context overflow is not a transient inference retry.**
16. **The local control backend must not be exposed to the LAN.**
17. **The MVP is not a hostile-code sandbox.**
