# Product Requirements Document
# Local Agent Kanban

**Status:** Draft v1.1  
**Target:** MVP  
**Primary environment:** Windows developer workstations in an air-gapped LAN  
**Primary users:** Developers using Pi Coding Agent against local repositories and a shared vLLM inference server

---

## 1. Product Summary

Local Agent Kanban is a local-first web application for managing software-development tasks and orchestrating Pi Coding Agent sessions.

It combines:

- one compact Kanban board across multiple configured projects;
- persistent Pi AgentSessions;
- Git worktree isolation;
- structured Investigation, Implementation, and independent Validation/Review workflows;
- Jira-style ticket comments and live steering;
- live structured agent/tool activity;
- checkpoint commits and validation snapshots;
- Git diff inspection;
- explicit human approval before merge;
- restart and crash recovery.

Each developer runs an independent frontend/backend locally. All projects on that workstation share one local `maxConcurrentAgents` limit. The shared vLLM server is used only for inference.

---

## 2. Goals

The MVP should:

1. Provide one unified Kanban board with five visible columns:
   - Todo
   - In Progress
   - Requires Human
   - Review
   - Done
2. Allow Todo -> In Progress to start either Investigation or direct Implementation.
3. Preserve one long-lived working Pi session across Investigation and Implementation iterations.
4. Use a fresh isolated Pi session for every independent Validation pass.
5. Create one task-specific Git worktree when agent work first begins.
6. Make successful Implementation iterations produce orchestrator-owned checkpoint commits.
7. Validate exact Git commit SHAs rather than ambiguous working-tree state.
8. Stream Pi SDK events to the UI without scraping terminal output.
9. Rebuild the board and ticket UI from SQLite, Pi JSONL, and Git after restart.
10. Support questionnaire-driven Requires Human workflows while releasing local scheduler capacity.
11. Preserve dirty partial work after interruption.
12. Allow users to stop active runs and remove queued work.
13. Require explicit human approval before advancing a base branch.
14. Never auto-resolve merge conflicts.
15. Protect the developer's primary checkout from automatic destructive Git actions.
16. Keep the MVP local-only and bind its control API to localhost.

---

## 3. Non-Goals for MVP

The MVP will not:

- provide a centralized team-wide scheduler;
- coordinate inference fairness across different developers' local backends;
- provide strong OS/container sandboxing for agent shell commands;
- automatically resolve Git merge conflicts;
- automatically squash, rebase, or force-update task branches;
- automatically archive Done tasks;
- support project-specific agent profiles;
- automatically enforce turn/time/token budgets;
- guarantee restoration of an in-flight generation at the exact token;
- guarantee vLLM KV-cache residency while a task waits for human input;
- reopen Done tickets;
- provide authentication for LAN access because the service must not be exposed to the LAN in MVP.

---

# 4. Technology Stack

## 4.1 Frontend

- React
- TypeScript
- REST for authoritative state/actions
- WebSocket for live updates

## 4.2 Backend

- Node.js
- TypeScript
- Fastify preferred; Express acceptable
- Pi SDK
- SQLite

## 4.3 Agent Runtime

The backend owns Pi SDK `AgentSession` objects.

It is responsible for:

- creating/restoring sessions;
- sending prompts;
- steering active sessions;
- subscribing to events;
- associating sessions with tasks/runs;
- handling questionnaire state;
- recovering from process restart.

Pi JSONL remains the authoritative detailed conversation transcript.

## 4.4 Version Control

- Git
- one agent branch per task;
- one primary task worktree per task;
- optional disposable validation worktrees;
- orchestrator-owned checkpoint commits and merge operations.

---

# 5. High-Level Architecture

```text
Developer Workstation
│
├── React + TypeScript
│
├── Node.js + TypeScript Backend
│   ├── Workflow Service
│   ├── Global Local Queue
│   ├── Agent Manager
│   ├── Project Manager
│   ├── Git / Worktree Manager
│   ├── Validation Manager
│   ├── Session Parser
│   └── WebSocket Hub
│
├── SQLite
├── Pi JSONL Sessions
├── Local Repositories
├── Task Worktrees
└── Disposable Validation Worktrees
        │
        │ LAN
        ▼
   Shared vLLM Server
```

Closing or refreshing the browser must not terminate backend-owned AgentSessions.

---

# 6. Unified Board and Projects

## 6.1 One Board

The application has one board:

```text
TODO | IN PROGRESS | REQUIRES HUMAN | REVIEW | DONE
```

Tasks from all configured projects may appear together.

## 6.2 Project Registration

Projects are registered in Settings.

Required fields:

```text
id
name
root_path
created_at
updated_at
```

The root must resolve to a valid local Git repository.

## 6.3 Task Creation

Only these fields are required:

- Project
- Title
- Description

## 6.4 Project Filtering

The board toolbar contains a compact filter icon.

The filter popover contains:

- Select All;
- one toggle per project;
- a scrollable project list.

Filtering is UI-only and must not affect AgentSessions.

---

# 7. Settings and Agent Profiles

A compact profile control appears in the top-right and opens Settings.

Initial sections:

```text
Projects
Agents
General
Git / Worktrees
```

## 7.1 Global Agent Profiles

MVP defines:

```text
Investigation Agent
Implementation Agent
Review Agent
```

Agent profiles may eventually configure:

- model;
- prompt;
- tools;
- skills;
- extensions;
- reasoning level;
- provider options.

Project-specific overrides are future work.

---

# 8. Workflow Model

## 8.1 Visible Workflow States

```text
TODO
IN_PROGRESS
REQUIRES_HUMAN
REVIEW
DONE
```

## 8.2 Working Phases

```text
INVESTIGATION
IMPLEMENTATION
VALIDATION_REVIEW
```

"Re-investigation" is another Investigation iteration, not a new phase type.

## 8.3 Run Lifecycle

Typical run states:

```text
QUEUED
RUNNING
WAITING_FOR_HUMAN
COMPLETED
FAILED
INTERRUPTED
CANCELLED
WAITING_FOR_INFERENCE
```

Detailed failure/reason codes are stored separately rather than creating more Kanban columns.

Examples:

```text
USER_STOPPED
BACKEND_INTERRUPTED
INFERENCE_UNAVAILABLE
CONTEXT_OVERFLOW
HANDOVER_FAILED
TOOL_FAILED
GIT_ERROR
BUDGET_EXCEEDED   # reserved for future enforcement
```

---

# 9. Starting Work from Todo

Dragging Todo -> In Progress opens:

```text
Start Task

[Investigate]
[Implement Directly]
```

Investigation is recommended.

Direct Implementation displays:

```text
Skip investigation?

The implementation agent will begin directly from the task
description and current comments.

[Cancel] [Continue to Implementation]
```

---

# 10. Working Session Model

Each task has one persistent **working session** reused across Investigation and Implementation.

Example:

```text
Working Session 1
├── Investigation #1
├── Implementation #1
├── Investigation #2
├── Implementation #2
└── ...
```

This preserves context across iterations.

A run records:

```text
stage
sequence
session_id
session_file
```

Multiple working runs may reference the same session.

---

# 11. Commit Model

This is a required correctness boundary.

## 11.1 Successful Implementation

After an Implementation run:

```text
Implementation finishes
        ↓
valid submit_handover received
        ↓
orchestrator inspects Git state
        ↓
orchestrator creates checkpoint commit
        ↓
record task_commit_sha
        ↓
REVIEW / IMPLEMENTATION_COMPLETE
```

The orchestrator creates the checkpoint commit. The agent is not responsible for the authoritative commit boundary.

## 11.2 Interrupted or Failed Work

Do not automatically commit interrupted/failed partial work.

Instead:

- preserve uncommitted changes exactly;
- preserve JSONL;
- move task to Review;
- allow Continue or View Diff.

## 11.3 Repeated Implementations

Each successful Implementation iteration may add another checkpoint commit:

```text
Implementation #1 -> commit T1
Implementation #2 -> commit T2
```

The agent branch accumulates task history.

---

# 12. Independent Validation / Review

Every Validation pass uses a **fresh Review Agent session**.

Example:

```text
Working Session 1
├── Investigation
└── Implementation @ T1

Validation #1 -> Session 2
Validation #2 -> Session 3
Validation #3 -> Session 4
```

## 12.1 Validation Input Snapshot

A validation pass receives:

- original task title/description;
- all ticket comments up to a recorded comment watermark;
- latest structured handover;
- candidate task commit SHA;
- candidate base SHA;
- changed-file list;
- Git diff;
- worktree/repository context.

It does not receive the full working-session transcript by default.

## 12.2 Validation Worktree

To reduce contamination of the authoritative task worktree, Validation should preferably run in a temporary/disposable detached worktree checked out at the exact candidate task SHA.

The Review Agent may:

- read/search/list;
- inspect Git;
- build;
- run tests;
- run safe diagnostics.

It must not intentionally modify the authoritative task branch.

Because builds/tests/shells may write files, the guarantee is:

> Validation must not change the authoritative task branch or tracked task state.

Before and after Validation, inspect Git status/diff. If tracked files changed in the validation worktree unexpectedly, treat Validation as failed.

## 12.3 Validation Snapshot

A successful validation creates an immutable snapshot:

```text
validation_run_id
validated_task_sha
validated_base_sha
comments_watermark
result
created_at
```

Ready to Merge is valid only while the current task/base state still matches the applicable validated snapshot.

If the task branch changes after validation, Ready to Merge becomes invalid and revalidation is required.

---

# 13. Review Tags and Actions

Review uses a small set of reasons:

```text
INVESTIGATION_COMPLETE
IMPLEMENTATION_COMPLETE
VALIDATION_ISSUES
VALIDATION_FAILED
RUN_FAILED
INTERRUPTED
READY_TO_MERGE
MERGE_CONFLICT
```

## 13.1 Investigation Complete

Actions:

```text
Implement
Investigate Further
Close Ticket & Remove Worktree
```

## 13.2 Implementation Complete

Actions:

```text
Validate
Continue Implementation
Investigate
Close Ticket & Remove Worktree
```

Validation is explicitly started by the user in MVP.

## 13.3 Validation Issues

The review completed successfully and found code/design concerns.

Actions:

```text
Fix Issues
Investigate
View Findings
Close Ticket & Remove Worktree
```

Fix Issues resumes the working session and sends the structured validator findings.

A later Validation creates a fresh Review Agent session.

## 13.4 Validation Failed

Validation itself could not complete.

Examples:

- backend interruption;
- inference unavailable after retries;
- broken build environment;
- unexpected mutation of tracked files;
- review tool failure.

Actions:

```text
Retry Validation
Continue Implementation
View Details
Close Ticket & Remove Worktree
```

Retry Validation always creates a fresh Review Agent session.

## 13.5 Run Failed

Investigation/Implementation could not complete normally.

Actions:

```text
Retry
Continue
View Session
Close Ticket & Remove Worktree
```

The displayed action may depend on whether the working session is recoverable.

## 13.6 Interrupted

Used for stopped/crashed working-session activity.

Actions:

```text
Continue
View Diff
Close Ticket & Remove Worktree
```

Continue resumes the persistent working session.

If new comments were added, include them in the continuation prompt.

## 13.7 Ready to Merge

Actions:

```text
View Diff
Open Worktree
Approve & Merge
Continue Implementation
Close Ticket & Remove Worktree
```

`Close Ticket & Remove Worktree` requires confirmation and preserves the branch.

## 13.8 Merge Conflict

Actions:

```text
Open in IDE
View Conflicts
Abort Merge
Retry Merge
Close Ticket & Remove Worktree
```

Conflicts are always resolved manually by the user.

`Abort Merge` is orchestrator-owned and only offered when Git confirms that a merge is actually in progress.

---

# 14. Ticket Description and Comments

## 14.1 Immutability

Before the first agent run:

- title/description may be edited;
- user comments may be edited/deleted;
- a never-started Todo task may be deleted.

After the first agent run begins:

- title/description become immutable;
- existing comments become immutable;
- new comments may be appended;
- destructive task deletion is replaced by Close.

Done tasks cannot be reopened in MVP.

## 14.2 Comment Delivery

Each comment tracks delivery state to the working session.

Suggested fields:

```text
delivery_status = PENDING | DELIVERED
delivered_session_id
delivered_run_id
delivered_at
delivery_type = NEXT_PROMPT | STEERING
```

## 14.3 Todo / Review Comments

Comments entered while not actively running are included in the next working-session prompt and then marked delivered.

## 14.4 Comments During an Active Run

Ordinary comments added while a run is active are stored as pending context and are not injected mid-turn.

To interact with the active session immediately, the user must open Live View and explicitly send a steering message.

## 14.5 Live Steering

In Live View, the user may directly prompt the active working session.

The backend uses Pi's steering mechanism at its supported safe boundary.

After the steering message is accepted for delivery:

1. append the steering text to ticket comments;
2. mark it delivered;
3. record session/run/delivery metadata.

This ensures the ticket timeline reflects human guidance actually sent to the LLM.

---

# 15. Structured Handover

Agents should use schema-validated workflow tools rather than relying on free-form final JSON.

Conceptually:

```text
submit_handover(...)
```

## 15.1 Investigation Handover

Suggested:

```text
summary
confidence
outcome
root_cause
evidence[]
affected_files[]
recommended_changes[]
missing_information[]
human_verification_required
recommended_next_step
```

Suggested next-step enum:

```text
IMPLEMENT
INVESTIGATE
REQUEST_HUMAN
CLOSE
```

These values are advisory. They change UI emphasis but do not automatically transition workflow.

Only an actual questionnaire tool call automatically enters Requires Human.

## 15.2 Implementation Handover

Suggested:

```text
summary
files_changed[]
key_decisions[]
known_limitations[]
recommended_validation[]
recommended_next_step
```

## 15.3 Missing Handover

If a required run ends without a valid handover:

1. request the handover once more;
2. if it still fails, mark run Failed;
3. move to Review / RUN_FAILED with `HANDOVER_FAILED`.

---

# 16. Questionnaire / Requires Human

## 16.1 Normal Flow

When the working agent invokes questionnaire:

1. persist question/options;
2. move task to Requires Human;
3. set run `WAITING_FOR_HUMAN`;
4. release the task from the local `maxConcurrentAgents` count;
5. keep the same working AgentSession associated with the task while backend remains alive.

No active model generation is assumed while the local tool waits.

## 16.2 Answer

When user submits an answer:

1. persist answer;
2. append it to the timeline;
3. move task to In Progress;
4. enqueue it;
5. when scheduled, continue the same working session/tool flow where possible.

The resumed task does not pre-empt an already running task.

## 16.3 Stop While Waiting

Requires Human provides:

```text
[Answer]
[Stop Run]
```

Stop Run:

- rejects/aborts the pending workflow safely;
- aborts the active working turn if required;
- preserves JSONL;
- preserves worktree state;
- records `USER_STOPPED`;
- moves task to Review / Interrupted.

## 16.4 Backend Crash While Waiting

The in-memory pending tool Promise is not durable.

The pending human request must therefore exist independently in SQLite.

After restart:

- rebuild Requires Human from SQLite;
- reopen the persistent working session;
- reconcile incomplete tool history before the next model request;
- continue using the tested recovery mechanism.

The recovery layer must not send malformed history containing an unresolved tool call if the provider rejects it.

Exact session-repair behavior is a required Pi SDK technical spike.

---

# 17. Queue and Stop Controls

## 17.1 Global Local Queue

There is one queue across all configured projects on that backend.

Configuration:

```text
maxConcurrentAgents = 1
```

MVP keeps this as the only concurrency setting.

## 17.2 Remove from Queue

Queued work provides:

```text
Remove from Queue
```

This cancels the queue job and returns the task to its previous stable workflow/review state.

## 17.3 Stop Run

Running work provides:

```text
Stop Run
```

This:

- aborts the current agent turn;
- terminates child tool processes owned by the run;
- preserves session/worktree state;
- records a user-stop reason;
- moves working runs to Review / Interrupted;
- moves validation runs to Review / Validation Failed.

## 17.4 Windows Child Processes

Aborting Pi alone is insufficient if shell tools started processes such as:

- `msbuild.exe`;
- `cl.exe`;
- `dotnet.exe`;
- test runners;
- compilers.

Tool commands should be launched under an owned Windows process tree, preferably a Windows Job Object.

Fallback where necessary:

```text
taskkill /PID <pid> /T /F
```

Stop/cancel must attempt process-tree cleanup before worktree cleanup.

## 17.5 Budgets

Future versions may enforce:

```text
max_turns_per_run
max_runtime_minutes
max_token_budget
```

For MVP these are not hard limits.

Users terminate runaway work manually using Stop Run.

---

# 18. Worktree and Branch Model

## 18.1 Task Worktree Creation

Create the primary task worktree at the first agent action, including Investigation.

Record:

```text
base_branch
base_commit_sha
agent_branch
worktree_path
```

## 18.2 One Primary Worktree per Task

Investigation, Implementation, and interruption recovery use the same task worktree.

Successful checkpoint commits accumulate on the task branch.

## 18.3 Disposable Validation Worktrees

Validation may use a temporary detached worktree at the exact candidate task SHA.

Delete it after validation when possible.

## 18.4 Worktree Lifetime

Primary worktree remains until:

- successful merge and cleanup; or
- explicit Close Ticket & Remove Worktree.

Closing preserves the task branch.

## 18.5 Windows Path Length

Use a short configurable root such as:

```text
C:\ak\w\TASK-42
```

Preflight Git/Windows long-path support.

## 18.6 Cleanup Pending

Worktree deletion may fail due to file locks.

If cleanup fails:

- do not force-delete by default;
- set worktree cleanup metadata to pending;
- notify the user;
- allow retry.

`CLEANUP_PENDING` is not a Kanban state.

---

# 19. Agent Safety / Threat Model

Git worktrees provide repository/worktree isolation, not a security sandbox.

An agent shell running as the developer can potentially:

- mutate Git refs;
- access other local files;
- invoke arbitrary executables;
- affect other branches;
- write outside its cwd.

MVP assumes a trusted local developer environment and focuses on preventing accidental damage.

## 19.1 Mitigations

- edit/write tools must restrict paths to the task/validation worktree;
- destructive/ref-mutating Git operations should be orchestrator-owned;
- prefer allowlisted Git wrapper operations where feasible;
- Investigation/Review profiles should not receive unnecessary mutation tools;
- Review validation runs use a disposable worktree;
- base-SHA/task-SHA checks detect unexpected branch changes before merge.

Commands such as these should not be intentionally exposed as normal agent actions:

```text
git update-ref
git branch -f
git reset --hard
git rebase
git push
```

Because unrestricted shell access can bypass wrappers, the PRD must not claim strong sandboxing.

---

# 20. Git Diff and Changelog

Git is authoritative for code state.

The full ticket view contains a right-side changed-file list:

```text
DISDriver.cpp       +18 -6
EntityManager.cpp   +21 -8
```

Clicking a file opens a Git-style diff in the center:

- red removals;
- green additions;
- side-by-side preferred.

For committed implementation state, diffs should be based on explicit SHAs rather than unspecified working-tree state.

---

# 21. Merge and Approval Workflow

The final integration strategy is **fast-forward-only**.

No automatic rebase or squash is performed.

## 21.1 Ready-to-Merge Snapshot

Ready to Merge references a successful validation snapshot:

```text
validated_task_sha = T
validated_base_sha = B
```

Before any approval action, verify the task worktree/branch still corresponds to the validated task state.

## 21.2 Approve & Merge — Base Unchanged

If:

```text
current_task_sha == validated_task_sha
current_base_sha == validated_base_sha
```

no additional agent validation is required.

Proceed to final integration checks and fast-forward.

There is no post-merge LLM validation.

After fast-forward, only deterministic verification is needed:

```text
base HEAD == validated_task_sha
expected Git state is clean
```

## 21.3 Approve & Merge — Base Moved

If the base changed:

1. persist an approval intent linked to the validation snapshot;
2. integrate latest base into the task branch inside the task worktree;
3. if conflict-free, create/identify the resulting task commit;
4. queue one fresh merge-preparation Validation at the front of the local queue;
5. validate the resulting task commit against that exact current base;
6. immediately before integration, confirm base and task SHAs are still the validated pair;
7. if unchanged, carry the approval through and merge automatically.

Merge-preparation Validation gets priority over normal queued work but does not pre-empt an already running task.

## 21.4 Conflict During Base Sync

If integration produces conflicts:

- stop automation;
- void the current approval intent;
- move to Review / Merge Conflict;
- prompt the user to resolve conflicts manually;
- provide Open in IDE.

Human conflict resolution produces new code/state and therefore requires:

```text
fresh validation
→ Ready to Merge
→ fresh Approve & Merge
```

Approval never survives manual conflict resolution.

## 21.5 Manual Conflict Resolution

User flow:

1. click Open in IDE;
2. configured IDE opens the task worktree;
3. user resolves conflict markers;
4. user stages/completes Git merge as required;
5. user clicks Retry Merge.

The orchestrator verifies Git state and starts a fresh Validation before allowing Ready to Merge again.

## 21.6 Base Changes Again During Merge Preparation

Do not loop indefinitely.

If the base changes again after merge-preparation validation started/completed:

- stop automatic integration;
- drop approval intent;
- return to Review / Ready to Merge;
- explain that the base changed;
- require another user approval.

## 21.7 Dirty Primary Checkout

If the recorded base branch is checked out in the developer's primary worktree:

- verify it is clean;
- verify HEAD matches the expected validated base SHA.

If dirty:

- do not merge;
- drop approval intent;
- remain Review / Ready to Merge;
- display the reason;
- ask user to commit/stash/discard their unrelated work and retry.

## 21.8 Base Not Checked Out

If the base branch is not checked out:

- prove fast-forward ancestry;
- update the ref using Git's safe compare-and-swap mechanism with expected old SHA.

Do not manipulate ref files manually.

## 21.9 Crash During Merge Preparation

Persist enough merge-preparation metadata for reconciliation, but do not automatically resume approval after backend restart.

On restart:

- drop approval intent;
- inspect Git operation state;
- return to Ready to Merge if clean;
- route an in-progress merge to Merge Conflict;
- require fresh approval for eventual integration.

## 21.10 Unexpected Git Operation State

If startup detects an orchestrator-created merge in progress:

```text
MERGE_CONFLICT
```

If it detects unexpected rebase/cherry-pick/revert state that the orchestrator did not intentionally start:

```text
RUN_FAILED
```

with instructions to resolve/abort it manually.

---

# 22. Done and Close Semantics

Done resolution is intentionally minimal:

```text
MERGED
CLOSED
```

`MERGED` means successfully integrated into the recorded base.

`CLOSED` means intentionally completed without merge.

Any destructive close action must say:

```text
Close Ticket & Remove Worktree
```

and request confirmation.

The agent branch is preserved by default.

Done tasks remain visible in MVP.

---

# 23. Interrupted Runs and Recovery

## 23.1 Working Run Interrupted

On backend crash/user stop/unexpected working-session termination:

- preserve JSONL;
- preserve worktree;
- preserve uncommitted changes;
- move to Review / Interrupted.

Continue behavior:

```text
No new comments:
"Continue the interrupted task. Inspect the current worktree
and conversation state and continue from where appropriate."

New comments:
include undelivered comments in the continuation prompt.
```

## 23.2 Validation Interrupted

Validation is never resumed.

A crashed/stopped Validation becomes:

```text
REVIEW / VALIDATION_FAILED
```

with reason stored on the run.

Retry creates a fresh Review Agent session.

---

# 24. Inference Availability and Context Management

## 24.1 Transient Inference Errors

Examples:

```text
connection refused
HTTP 502 / 503
temporary server unavailable
```

Use bounded automatic retry/backoff.

Keep generation/read timeouts generous enough for a busy shared vLLM server.

During retry, task may display:

```text
Waiting for inference
```

without creating a new Kanban column.

## 24.2 Context Length Exceeded

A provider/context-length 400 is not transient.

Do not resend the identical request automatically.

Attempt/use Pi's supported compaction behavior, or return to user-visible recovery if compaction cannot resolve the issue.

## 24.3 Streaming Retry

Live text deltas are provisional until a completed authoritative message event is received.

If a stream fails and the turn is retried:

- discard/rollback provisional text from the failed attempt in the live UI;
- show Retrying if useful;
- stream the replacement attempt cleanly.

## 24.4 Proactive Compaction Prompt

After each completed working-session response, record context usage when available.

If the previous response indicates context usage >= 60%, then before transitions that resume working Session 1, prompt:

```text
Session context: 67%

This session is becoming large.
Compact before continuing?

[Continue Without Compact]
[Compact & Continue]
```

Apply this before actions such as:

```text
Implement
Investigate Further
Continue Implementation
Fix Issues
Continue
```

60% is a proactive UX threshold, not an automatic hard limit.

Use Pi's native compaction mechanism rather than implementing a separate summarizer.

---

# 25. Backend Restart and UI Reconstruction

Backend reliability is critical, but correctness must not assume the backend never crashes.

## 25.1 Durable Sources

### SQLite

- workflow/task state;
- queue;
- comments/delivery watermarks;
- human requests;
- session references;
- validation snapshots;
- approval intent;
- worktree metadata.

### Pi JSONL

- conversation history;
- tool calls/results;
- usage/model metadata;
- Pi session context/compaction history.

### Git

- commits;
- branch state;
- uncommitted changes;
- merge state;
- diffs.

## 25.2 Startup Reconciliation

On startup:

1. acquire the application single-instance lock;
2. open SQLite;
3. inspect active/queued jobs;
4. inspect worktree Git-operation state;
5. mark orphaned working runs Interrupted;
6. mark orphaned validation runs Validation Failed;
7. preserve queued jobs/order;
8. rebuild Requires Human requests;
9. drop stale merge approval intent;
10. restore persistent working-session references;
11. rebind Pi event subscriptions when sessions are reopened;
12. expose authoritative REST snapshot.

## 25.3 In-Flight Generation

Exact in-flight token generation cannot be recreated.

Persist what exists, classify interruption, and continue later through a new turn using session/worktree state.

## 25.4 UI Rebuild

After backend reconnect/restart:

```text
REST board snapshot
      ↓
render authoritative state
      ↓
connect board WebSocket
      ↓
connect run WebSocket as needed
```

Opening a historical ticket reconstructs detail from SQLite + Pi JSONL + Git.

---

# 26. WebSocket Design

## 26.1 Board Channel

Carries:

- task state changes;
- queue changes;
- toasts;
- human requests;
- review transitions;
- merge/inference status.

## 26.2 Run Channel

Carries:

- assistant text deltas;
- message completion;
- tool start/update/end;
- lifecycle events.

## 26.3 Reconnect

WebSockets are transient.

After reconnect, fetch authoritative REST state first, then resume live events.

---

# 27. Pi Event and Tool Rendering

Normalize Pi SDK events into application events.

Tool-specific rendering:

```text
list / ls      -> directory tree
find           -> file list
grep           -> search results
read           -> source preview
edit           -> diff/activity
write          -> file summary
bash           -> terminal
powershell     -> terminal
questionnaire  -> structured human-input UI
```

Tool views are collapsed by default and show approximately the first five lines before expansion.

---

# 28. Ticket and Full Session UI

## 28.1 Kanban Card

Compact example:

```text
Fix DIS timeout

[Implementing]
Queued #2

SimulationEngine
```

## 28.2 Expanded Ticket

Show:

- immutable task description;
- comments;
- handover summary;
- current phase/status;
- live assistant summary;
- relevant actions.

## 28.3 Live View

During active working-session execution, Live View allows explicit user steering.

Ordinary ticket comments do not automatically steer the running turn.

## 28.4 Full Read-Only Session View

Show:

- user messages;
- assistant messages;
- collapsed reasoning when available;
- tool calls/results;
- Git diff;
- response metadata.

Footer:

```text
Model · Input Tokens · Output Tokens
```

Values are per assistant response.

---

# 29. Validation Result UI

Validation results are appended as ticket comments.

Success:

```text
Review Agent
Validation passed.

Build: Passed
Tests: 15 passed
No blocking issues found.
```

Failure due to code findings:

```text
Review Agent
Validation completed with issues.

1. Possible race...
2. Missing null check...
```

Infrastructure/tool failure is not reported as code issues; it uses Validation Failed.

---

# 30. Suggested Persistence Model

Exact schema may evolve, but responsibilities must remain separated.

## 30.1 projects

```text
id
name
root_path
created_at
updated_at
```

## 30.2 tasks

```text
id
project_id
title
description

workflow_state
review_tag

working_session_id
working_session_file

base_branch
base_commit_sha
agent_branch
worktree_path
cleanup_status

latest_task_commit_sha
active_validation_snapshot_id

resolution

created_at
updated_at
```

Avoid storing duplicated transient run/job status here.

## 30.3 task_runs

```text
id
task_id
stage
sequence
session_id
session_file

status
reason_code

return_workflow_state
return_review_tag

handover_json
task_commit_sha

started_at
completed_at
interrupted_at
error_message
```

## 30.4 agent_jobs

```text
id
task_run_id
queue_position
priority
status
created_at
started_at
completed_at
```

Scheduler status should stay small:

```text
QUEUED
CLAIMED
FINISHED
CANCELLED
```

## 30.5 ticket_comments

```text
id
task_id
run_id
author_type
content

delivery_status
delivery_type
delivered_session_id
delivered_run_id
delivered_at

created_at
updated_at
```

## 30.6 human_requests

```text
id
task_id
run_id
session_id
tool_call_id

question
options_json
answer

status
created_at
answered_at
```

## 30.7 validation_results

```text
id
task_id
run_id
result
findings_json
build_result_json
test_result_json
created_at
```

## 30.8 validation_snapshots

```text
id
task_id
validation_run_id
validated_task_sha
validated_base_sha
comments_watermark
result
created_at
```

## 30.9 merge_attempts

```text
id
task_id
validation_snapshot_id
approval_status
validated_base_sha
validated_task_sha
status
started_at
completed_at
error_reason
```

Approval state must be persisted, but automatically dropped after backend crash/reconciliation.

## 30.10 task_events

Optional lightweight workflow audit trail.

Do not duplicate Pi transcript content.

---

# 31. Local Security and Single-Instance Requirements

The backend can ultimately cause local shell execution, so MVP must not expose it broadly.

## 31.1 Localhost Only

Bind HTTP/WebSocket server to:

```text
127.0.0.1
::1
```

Do not bind to `0.0.0.0`.

## 31.2 Origin / Host Validation

Validate expected local WebSocket Origin and reject unexpected origins.

Apply equivalent local Host/Origin protections to mutating REST endpoints where practical.

## 31.3 Single Backend Instance

Prevent two backend schedulers from using the same app state simultaneously.

Use:

- a Windows named mutex or equivalent application lock;
- optionally a lock file;
- SQLite locking as defense in depth.

If another live instance owns the lock, refuse startup with a clear message.

---

# 32. Reliability and Safety Requirements

The application must:

- prevent duplicate active jobs for one run;
- preserve global queue order;
- checkpoint successful Implementation state before validation;
- validate exact task/base SHAs;
- invalidate validation when candidate task state changes;
- preserve dirty partial work on interruption;
- kill owned Windows child process trees on Stop;
- preserve Pi session references;
- recover UI from durable state;
- never silently discard work;
- never auto-resolve merge conflicts;
- never automatically rebase/squash;
- never alter a dirty developer primary checkout;
- never carry approval through manual conflict resolution;
- never auto-resume an approval/merge after backend crash;
- never treat context overflow as a transient retry;
- never report infrastructure validation failure as code validation issues;
- keep the backend local-only;
- prevent multiple schedulers for one SQLite state.

---

# 33. MVP Acceptance Criteria

A developer can:

1. configure multiple projects;
2. use one unified board and filter by project;
3. create tasks with Project, Title, Description;
4. edit task/comments only before first agent work, then append immutable comments;
5. choose Investigate or Implement Directly from Todo;
6. receive a skip-investigation warning;
7. run a single global local agent queue;
8. remove queued work;
9. stop running work, including Requires Human;
10. terminate owned Windows child processes on Stop;
11. create a task worktree at first agent execution;
12. reuse one working session across Investigation/Implementation iterations;
13. use Live View steering and record steering as delivered comments;
14. receive schema-validated handovers;
15. create an orchestrator checkpoint commit after each successful Implementation handover;
16. preserve uncommitted partial work after failure/interruption;
17. create fresh Validation sessions;
18. validate an exact task/base SHA pair;
19. use a disposable validation worktree where applicable;
20. append validation outcomes to comments;
21. distinguish Validation Issues from Validation Failed;
22. move successful validation to Ready to Merge;
23. invalidate Ready to Merge if task state changes;
24. view changed files and Git diffs;
25. move questionnaire tasks to Requires Human;
26. release local scheduler capacity while waiting;
27. requeue and resume the same working session after answer;
28. recover pending questionnaire state after backend restart using tested session repair;
29. retry transient vLLM failures;
30. avoid retrying identical context-overflow requests;
31. prompt for compaction at >=60% context before resuming working Session 1;
32. rebuild the board/UI after backend restart;
33. mark crashed working runs Interrupted;
34. mark crashed validation runs Validation Failed;
35. manually resolve merge conflicts through configured IDE;
36. invalidate approval after manual conflict resolution;
37. run fresh validation after conflict resolution;
38. carry approval through one conflict-free base-sync/revalidation cycle;
39. prioritize merge-prep validation at the front of the queue;
40. stop and require fresh approval if base changes again;
41. refuse final integration into a dirty primary checkout;
42. fast-forward only the exact validated task commit;
43. perform deterministic post-merge SHA/status verification only;
44. close tasks with confirmation while preserving branches;
45. keep Done tasks visible;
46. bind backend to localhost and validate WebSocket Origin;
47. refuse a second backend instance for the same application state.

---

# 34. Future Considerations

- centralized team backend and queue;
- project-specific agent profiles;
- automatic validation;
- hard run/time/token budgets;
- stronger sandboxing/containerization;
- separate build concurrency;
- archives;
- authentication if remote access is ever added;
- configurable workflows;
- issue tracker integration;
- richer validation adapters.

---

# 35. Required Technical Spikes / Open Implementation Details

Before depending on them, verify:

1. Persistent Pi AgentSession reopen/continuation.
2. Event subscription and rebinding after session restore.
3. Live steering event/order semantics.
4. Questionnaire waiting while releasing scheduler capacity.
5. Questionnaire Stop behavior.
6. Crash while questionnaire tool is unresolved.
7. Safe reconciliation/repair of JSONL with an unmatched tool call/result.
8. Crash during model streaming and what Pi persists.
9. Pi native compaction invocation and context-usage APIs.
10. Review Agent tool restriction configuration.
11. Windows Job Object integration for shell tool process trees.
12. Git worktree long-path and lock behavior.
13. Disposable validation worktree behavior for builds/tests.
14. Safe checkpoint commit creation.
15. Safe merge/ref compare-and-swap behavior.
16. Startup detection of merge/rebase/cherry-pick/revert state.
17. vLLM transient error classification/retry behavior.

These are implementation-validation tasks, not optional product behavior where the PRD already defines the required outcome.
