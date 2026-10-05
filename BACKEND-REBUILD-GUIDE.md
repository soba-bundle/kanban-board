# Kanban Agent Board — Product Requirements Document

**Status:** Requirements baseline for a clean rewrite.  
**Scope:** Product behavior, frontend capabilities, backend contracts, persistence, Pi SDK integration, and local Git workflows.  
**Basis:** Current source behavior and the owner's clarified workflow, not historical implementation plans.

This document defines **what the product must do and the technical contracts it must satisfy**. It is not a source-file walkthrough or implementation plan. Separate frontend and backend implementation plans should be generated from these requirements. Historical stage-based Investigation/Implementation/Validation designs are not requirements.

## 1. Product objective

Provide a local Kanban board where a developer can attach tasks to existing Git projects, ask Pi coding agents to work in isolated task worktrees, interact with those agents, manually test their changes, commit the reviewed work, and safely merge it into the project's local primary branch.

The application coordinates work and preserves recoverable state. It does not replace human application testing, code review, or conflict resolution.

### 1.1 Core workflow

```text
Register local project → Create task → Prompt agent
    → Agent works in isolated task worktree
    ↔ User sends guidance / answers agent questions
    → Agent finishes → Review
    → Human tests app and reviews changes in task worktree
    → Explicit Commit to task branch
    → Attempt Merge back
        ├─ Primary branch already included → approved fast-forward integration
        └─ Primary branch advanced → merge local primary into task branch
            ├─ Clean merge → human reviews/retests → fresh Merge back confirmation
            └─ Conflicts → human resolves and commits in task worktree
                          → human retests → fresh Merge back confirmation
    → Done / Merged → safe worktree cleanup
```

Here, “main” means the task's recorded local primary branch; its actual name need not be `main`. “Pull” means incorporating commits from that **local branch**, not contacting a remote.

### 1.2 Non-goals

- Remote fetch/pull/push, GitHub/GitLab pull requests, or remote repository provisioning.
- Multi-user collaboration, hosted authentication, distributed workers, or cloud deployment.
- Automated validation agents or an app-enforced test-pass gate.
- Separate Investigation and Implementation stages or mandatory structured handovers.
- Automatic conflict resolution, automatic destructive rollback, or arbitrary board-state changes.
- Pixel-level frontend design or an implementation sequence.
- Automatic import/reset of existing development data. A fresh installation uses a fresh schema; any future importer requires a separate specification.

## 2. Technology and deployment requirements

| Concern | Requirement |
|---|---|
| Backend | Node.js and TypeScript, Fastify HTTP server, WebSocket live events |
| Frontend | React and TypeScript; prefer Astryx components where suitable; Tailwind CSS is permitted if configured intentionally |
| Database | Local SQLite using `better-sqlite3`; foreign keys enabled, WAL mode, versioned transactional migrations |
| Agents | In-process `@earendil-works/pi-coding-agent` SDK, not Pi CLI subprocess orchestration |
| Agent conversation storage | Pi-managed persistent session JSONL files, separate from SQLite metadata |
| Source control | Installed Git CLI, invoked with argument arrays without shell interpolation |
| Deployment | One local backend owns one application data directory; bind to loopback and validate HTTP/WebSocket Host and Origin |
| Platform | Preserve Windows support; Git/path/process behavior must also be portable to supported macOS/Linux installations |
| Configuration | Absolute application/data/session/worktree paths; configurable agent concurrency and inference retry count |

The SDK version must be pinned to a tested version. The inspected project uses Pi SDK 0.84.4; upgrades must verify session persistence, resource discovery, tool registration and event behavior before adoption.

The application must acquire exclusive state ownership before database migration or agent dispatch. Credentials belong in a gitignored app-owned auth file or supported environment configuration. Project prompts, source contents, credentials and transcript bodies must not be indiscriminately logged.

A task worktree provides source-control separation, **not an OS security sandbox**. Pi tools and extensions execute with backend permissions. The product is for trusted local projects and reviewed extensions.

## 3. Domain concepts and state

| Concept | Meaning |
|---|---|
| Project | Registered existing local Git repository and its settings |
| Task | A unit of developer work linked to exactly one project |
| Worktree | Isolated task checkout with its own task branch |
| Working session | Persistent Pi conversation owned by one task and reused across runs |
| Run | One explicitly requested unit of agent work within that session |
| Job | Durable scheduling record for a run and its human-wait continuations |
| Input | Persisted initial prompt, pre-dispatch guidance, or live steering message |
| Human request | Structured questions issued by an agent tool and answered by the developer |
| Checkpoint | An explicitly user-approved Git commit in the task branch; UI label: **Commit** |
| Sync | Merge captured local-primary commits into the task branch |
| Merge-back | Integrate an approved committed task candidate into the primary branch |

### 3.1 Task states

| State | Meaning and allowed transitions |
|---|---|
| `TODO` | No run has started. Queue an explicit prompt → `IN_PROGRESS`. |
| `IN_PROGRESS` | Work is queued or running. Human question → `REQUIRES_HUMAN`; finish/failure/stop → `REVIEW`. |
| `REQUIRES_HUMAN` | Agent is parked for questions. Answer queues continuation; capacity acquisition → `IN_PROGRESS`; stop → `REVIEW`. |
| `REVIEW` | Human can inspect/test, request further work, commit, sync, resolve conflicts, merge, or safely close. New prompt → `IN_PROGRESS`; verified merge/safe closure → `DONE`. |
| `DONE` | Terminal outcome `MERGED` or `CLOSED`. |

Review reason is `WORK_COMPLETE`, `RUN_FAILED`, or `INTERRUPTED`. Sync conflicts and cleanup are operation/resource states, not additional board columns.

Runs use `QUEUED`, `RUNNING`, `WAITING_FOR_HUMAN`, `COMPLETED`, `FAILED`, `INTERRUPTED`, `CANCELLED`. Jobs use `QUEUED`, `CLAIMED`, `WAITING_FOR_HUMAN`, `FINISHED`, `CANCELLED`.

An answered parked run returns to `QUEUED` while awaiting capacity; its task may remain `REQUIRES_HUMAN` until resumed. The UI must distinguish “awaiting answer” from “answer received, continuation queued.”

Run completion, Git commit, sync readiness and merge completion are separate facts. None proves that human testing occurred. Board state is server-authoritative; dragging cards cannot bypass domain operations.

## 4. Functional requirements

### PRJ — Projects

- **PRJ-01:** Register an existing local Git working repository with a display name. Validate and canonicalize its root and Git common-directory identity; reject duplicate aliases, unsupported/bare repositories and repositories without a commit.
- **PRJ-02:** Identify the primary branch explicitly. Default to the current named branch, require confirmation, and store it. Each task captures its own base branch/SHA when provisioned.
- **PRJ-03:** Support optional IDE launcher and worktree-root settings. Worktree roots must be outside the project checkout, with symlink-aware containment checks.
- **PRJ-04:** Allow display/settings changes, but block changes to repository identity or primary-branch configuration while existing task resources would become inconsistent.
- **PRJ-05:** Archiving a project must not hide unresolved work, human requests, conflicts, or cleanup obligations. Reject unsafe archive requests rather than silently abandoning resources.

### TSK — Tasks

- **TSK-01:** Create a task with project, nonempty title and description. Initial state is `TODO`.
- **TSK-02:** Permit title/description changes before agent work starts. Afterwards, use explicit prompts/guidance rather than rewriting original task context.
- **TSK-03:** Provision the task worktree before its first run; task creation itself need not allocate Git resources. Never start an agent in the primary checkout as a fallback.
- **TSK-04:** Support repeated work runs in the same task/session until completion. Require an explicit nonempty prompt for every new run.
- **TSK-05:** Preserve run history, prompts, transcript and committed SHAs after merge and worktree removal.
- **TSK-06:** Allow no-merge closure only from Review when no uncommitted or unintegrated task changes remain. Record `CLOSED`, distinct from `MERGED`.
- **TSK-07:** Unsafe task deletion/archive must be refused. Resource cleanup must preserve user files; an unsuccessful cleanup cannot silently delete the task's recovery interface.

### AGT — Agent work and queue

- **AGT-01:** New work has one generic run type. Agents can inspect/edit files and execute coding tools in their task worktree.
- **AGT-02:** Persist a run, initial input and queue job atomically before acknowledging enqueue. Repeated identical idempotency keys return the same result; conflicting reuse is rejected.
- **AGT-03:** Default global concurrency is one; allow a positive configurable limit. At most one active/queued/parked run may own a task.
- **AGT-04:** Support queue inspection, reordering and cancellation. Cancelling never-started work restores the task's preceding board state. Cancelling a queued human-answer continuation instead interrupts the already-started run into `REVIEW/INTERRUPTED`, preserves prior work/answers, and prevents further continuation; it must not restore the original pre-run state.
- **AGT-05:** Display ordinary final agent responses. A successful run enters Review without requiring a handover tool or automatically committing files.
- **AGT-06:** Support user Stop during setup, generation, tool execution and human wait. Preserve files and transcript; report interruption distinctly from successful completion.
- **AGT-07:** Allow queued guidance before dispatch and steering during active execution. Persist inputs before acknowledging them and expose delivery status.
- **AGT-08:** A Pi-accepted input is not necessarily delivered. Delivery requires attributable persisted transcript evidence; uncertain delivery must remain visible and must not be replayed automatically.
- **AGT-09:** Permit explicit reuse of undelivered/uncertain inputs with provenance. Reject automatic duplicate work after restart or HTTP retries.
- **AGT-10:** Git commit/sync/merge are application/user-owned actions. Unexpected agent or external ref changes must invalidate assumptions and require explicit review, not become silently approved commits.

### HUM — Human requests

- **HUM-01:** Agents can ask one or more structured questions with stable question IDs, prompts, labels, selectable options and optional custom answers.
- **HUM-02:** Persist requests by task/run/session/tool-call identity. Enforce unique question IDs and complete answer validation.
- **HUM-03:** Waiting releases global execution capacity without completing the run or allowing another run on the same task.
- **HUM-04:** Answering persists an idempotent answer and queues continuation. Only reacquiring capacity may resume inference.
- **HUM-05:** Pending questions remain answerable after backend restart. Answered dangling tool calls must be reconciled exactly once before continuation.
- **HUM-06:** A recovered continuation must be able to ask further questions, park and resume normally. Late answers cannot resurrect stopped runs.

### LIVE — Conversation and tool history

- **LIVE-01:** Display user inputs, assistant text, supported thinking output, tool activity/results, errors, retry/compaction activity and run settlement.
- **LIVE-02:** Durable conversation comes from the correct Pi session branch; SQLite associates session entries with runs.
- **LIVE-03:** Reload/reconnect restores durable history and an explicitly provisional live tail. Deduplicate by stable entry/event IDs.
- **LIVE-04:** Sequence live events and support cursor replay. Expired/reset cursors produce an explicit gap response and history reload, not silent loss.
- **LIVE-05:** Bound replay memory by count and bytes; handle disconnected and slow clients. A socket closing does not mean the run succeeded.
- **LIVE-06:** Render the app-owned todo extension's structured snapshots from tool results. Todo state must restore per session and never leak between tasks.

### REV — Human review and testing

- **REV-01:** From Review, the user can open the task worktree in their configured IDE, inspect paths/diffs and run their application/tests manually.
- **REV-02:** Human testing and code review occur before the explicit Commit action. The application provides reminders, not a required test-result field or attestation checkbox.
- **REV-03:** Human edits in the worktree are valid task changes and must be visible in preview.
- **REV-04:** A no-change run retains its ordinary response without a synthetic change summary. Changed work exposes the actual uncommitted diff and file list.
- **REV-05:** Synchronization that changes the candidate requires renewed human review/testing and a fresh merge confirmation. Prior approval cannot cover unseen post-sync code.

## 5. Git and worktree requirements

### GIT-01 — Provisioning and isolation

Each task has a distinct branch, such as `agent/task-<taskId>`, and an external linked worktree created from the captured primary SHA using `git worktree add -b`. Uncommitted primary changes are not copied.

Verify actual common-directory ownership, task branch and checkout path before agent/Git operations. Missing or mismatched state blocks execution. Provisioning must be recoverable if Git succeeds before metadata is saved; ambiguous resources must not be force-deleted.

### GIT-02 — Commit preview and confirmation

- Preview tracked staged/unstaged edits, additions, deletions, renames, file modes, supported symlinks, binary changes and nonignored untracked files.
- Preview must not mutate the real index or primary checkout. Report omitted/oversize content clearly rather than presenting a truncated diff as complete.
- MVP Commit includes the complete approved nonignored change set; partial-file staging is not required. Inclusion of untracked files must be explicit.
- Bind approval to task/branch, expected parent HEAD, full paths and immutable candidate contents/tree. Textual diff hashes alone are insufficient for binary content.
- Commit only that approved candidate. Concurrent changes must invalidate approval or remain visibly uncommitted; they must not slip into the commit.
- Respect Git hooks, but hook-induced changes outside the approved tree cannot be silently approved. Verify resulting branch, parent, tree and commit SHA.
- Preserve a concurrently changed user index. Cancellation/failure must not discard files or reset user work.
- Save successful commit SHA and operation outcome durably. Git success followed by database failure must expose the real SHA and recover without blindly recommitting.

A checkpoint is an ordinary task-branch Git commit, not an automated test result or Pi conversation checkpoint. Pinned committed diffs use exact SHAs rather than moving branch names.

### GIT-03 — Sync from local primary into task

When merge-back detects primary commits absent from the candidate, offer synchronization within that flow. Explain that it merges local primary into the task branch; it never invokes remote `git pull`.

Require idle task, expected branch/recorded HEAD, clean worktree/index, no active Git operation and no unresolved prior attempt. Capture both primary SHA and prior task SHA before merging. Merge the **captured SHA**, not a subsequently moving branch name.

Preserve ignored-file collisions using `--no-overwrite-ignore` or equivalent protection. On success, verify that the candidate contains both captured commits, and save the new candidate/synchronized base. Do not silently proceed to merge-back: return control for human review/retesting and new approval.

### GIT-04 — Conflicts

- Preserve conflict markers, index stages and user edits in the task worktree.
- Display conflicting files and provide Open IDE, inspect/continue and separately confirmed abort actions.
- Human resolves conflicts and completes the merge commit in the task worktree. The app verifies clean state, expected branch and ancestry of both captured commits before adopting it.
- Block unrelated agent runs, ordinary commits, merge-back and resource deletion while recovery is unresolved.
- Abort requires a fresh conflict-state confirmation. If manual work changed since that confirmation, refuse automatic abort rather than discard it.
- Restart must recognize unstarted, conflicted, resolved, aborted and uncertain attempts without blindly repeating a merge or abort.

### GIT-05 — Merge readiness and approval

Readiness is a point-in-time Git check returning exact task/base SHAs, check time and reasons:

| Result | Meaning |
|---|---|
| `IN_SYNC` | Expected clean task candidate contains current primary SHA; all prerequisites safe |
| `STALE` | Structurally safe but primary has commits absent from candidate; sync required |
| `BLOCKED` | Dirty/mismatched/busy/unavailable state, unresolved recovery, active run, or Git inspection failure |

A passing check does not imply application testing. Require explicit one-time merge approval bound to exact base/task refs and SHAs. Changed refs, candidate contents or repository state invalidate approval. Approval to sync does not approve a newly changed merge candidate.

### GIT-06 — Integration into primary

Merge-back is fast-forward-only after synchronization. Never create an unresolved merge in the primary checkout or automatically choose conflict resolutions there.

- Revalidate state under task and repository coordination immediately before integration.
- For an unchecked-out primary ref, use expected-old-SHA compare-and-swap (`git update-ref`).
- For primary checked out in the registered primary checkout, require clean/idle correct branch and perform a safe fast-forward checkout update with ignored-file protection. Verify both ref and checkout/index outcome.
- If primary is checked out in another linked worktree, refuse to mutate that checkout and provide actionable guidance.
- Do not use an unguarded ref update followed by reset as if those were atomic.
- Persist intent and final outcome. Uncertain partial integration must remain recoverable; never roll back external work automatically.

Application locks serialize its own workers, not external IDE/Git commands. The product must detect changed assumptions and preserve ambiguous state rather than promise cross-process atomicity across refs, index and files.

### GIT-07 — Completion and cleanup

After verified integration, mark task `DONE / MERGED`. Remove the worktree only through safe non-force Git cleanup. Preserve task branch, SHAs and conversation history.

Cleanup failure records `CLEANUP_PENDING` with a reason and retry action. It does not undo or misreport successful integration. Cleanup retry must not repeat integration. Preserve ignored/local files and refuse destructive cleanup; no automatic `git clean`, hard reset or force removal.

## 6. SQLite data requirements

### 6.1 Conventions

The following is the **target logical schema**, derived from current entities but excluding retired workflow fields. Physical indexes/migration code belong in the implementation plan.

- IDs: `TEXT` UUIDs; timestamps: UTC ISO-8601 `TEXT`; booleans: constrained `INTEGER` 0/1.
- Git object IDs: opaque validated `TEXT`, not hardcoded to 40-character SHA-1.
- `?` means nullable. Other listed columns are required, unless an explicit default is stated.
- JSON is `TEXT`, validated against shared schemas before writes. Use JSON only for naturally structured payloads, not opaque storage of all relational state.
- Foreign keys use restrictive deletion for durable history. Archiving uses `archived_at?`.
- No database transaction remains open while awaiting Git, filesystem or SDK work.

### 6.2 Tables

#### `projects`

| Fields | Purpose |
|---|---|
| `id`, `name`, `root_path`, `git_common_dir`, `primary_branch` | Stable project/repository identity and selected local primary |
| `ide_command?`, `worktree_root?` | Optional local launch/resource settings |
| `created_at`, `updated_at`, `archived_at?` | Lifecycle |

Require unique active canonical repository identity. Block identity-changing edits that invalidate existing resources.

#### `tasks`

| Fields | Purpose |
|---|---|
| `id`, `project_id` FK, `title`, `description` | Task identity/context |
| `workflow_state`, `review_reason?`, `resolution?` | Board state, review reason, `MERGED`/`CLOSED` outcome |
| `base_branch?`, `initial_base_sha?`, `synced_base_sha?` | Captured primary, original diff baseline, latest incorporated primary |
| `task_branch?`, `worktree_path?`, `candidate_sha?` | Task resource identity and last explicitly recorded committed candidate |
| `session_id?`, `session_file?` | One persistent working conversation |
| `cleanup_status?`, `cleanup_error?` | Visible recoverable resource cleanup |
| `created_at`, `updated_at`, `archived_at?` | Lifecycle |

Git/session fields are null before provisioning/first use. Keep original and synchronized bases distinct so task-wide diff history does not change meaning after synchronization. Live Git must be rechecked; recorded candidate is not proof that HEAD still matches.

#### `task_runs`

| Fields | Purpose |
|---|---|
| `id`, `task_id` FK, `sequence` | Run identity/order; unique task/sequence |
| `status`, `reason_code?`, `error_message?` | Run lifecycle/failure |
| `return_workflow_state`, `return_review_reason?` | Restore state after queued cancellation |
| `session_id?`, `session_file?` | Historical session attribution |
| `input_mode` | `QUEUED` or `STEERING` dispatch cutoff |
| `prompt_text?` | Exact rendered initial/restart prompt used for delivery correlation |
| `transcript_start_entry_id?`, `transcript_end_entry_id?` | Run boundaries in session tree |
| `created_at`, `started_at?`, `completed_at?` | Lifecycle times |

Terminal interruption time is `completed_at`; a separate `interrupted_at` is unnecessary. Reason codes include `USER_STOPPED`, `BACKEND_INTERRUPTED`, `INPUT_DELIVERY_FAILED`, `AGENT_ERROR`. All new runs are generic work, so no `stage` column is needed.

#### `agent_jobs`

`id`, `run_id` FK UNIQUE, `queue_position?`, `status`, `created_at`, `claimed_at?`, `completed_at?`.

One job is reused for human-wait continuations of the same run. Queue position applies only to queued jobs. No priority column is required: ordinary ordering/reordering is sufficient without retired priority-validation behavior.

#### `run_inputs`

`id`, `task_id` FK, `run_id` FK, `sequence`, `idempotency_key`, `content`, `delivery_type`, `delivery_status`, `accepted_at`, `delivery_intent_at?`, `delivered_at?`, `session_id?`, `session_sequence?`, `transcript_boundary_entry_id?`, `transcript_entry_id?`, `failure_reason?`, `reused_from_input_id?` FK.

- Types: `INITIAL_PROMPT`, `QUEUED_INPUT`, `STEERING`.
- States: `PENDING`, `ACCEPTED`, `DELIVERED`, `UNDELIVERED`, `DELIVERY_UNKNOWN`, `CANCELLED`.
- Unique task/idempotency key, run/sequence and non-null session/session-sequence. For the input endpoint, client-supplied `input_id` is both the globally unique row ID and its idempotency key. Reusing it for another run, different text or different reuse source is a conflict; an identical retry returns the existing input.
- `accepted_at` records API acceptance; `delivery_intent_at` records imminent SDK invocation. SDK acceptance and transcript-confirmed delivery remain distinct states.
- Bundled initial/queued inputs may reference the same transcript entry; do not impose uniqueness on that field alone.

#### `run_transcript_entries`

`session_id`, `entry_id`, `run_id` FK, `sequence`.

Primary key `(session_id, entry_id)`; unique `(run_id, sequence)`. Stores ownership/order, not duplicated transcript text.

#### `human_requests`

`id`, `task_id` FK, `run_id` FK, `session_id`, `tool_call_id`, `questions_json`, `answers_json?`, `status`, `created_at`, `answered_at?`.

Unique `(session_id, tool_call_id)`. Status: `PENDING`, `ANSWERED`, `CANCELLED`.

Question shape: `{id,label,prompt,options:[{value,label,description?}],allowOther}`. Answer shape: `{id,value,label,wasCustom}`. Remove duplicate legacy single-question/options/answer columns; these arrays support both one and many questions.

#### `checkpoint_attempts`

`id`, `task_id` FK, `status`, `expected_branch`, `expected_parent_sha`, `approved_tree_sha`, `snapshot_token`, `manifest_json`, `result_commit_sha?`, `error_message?`, `created_at`, `expires_at`, `confirmed_at?`, `completed_at?`.

States: `PREVIEWED`, `COMMITTING`, `COMPLETED`, `EXPIRED`, `FAILED`, `RECOVERY_REQUIRED`. Manifest captures approved paths, modes/content identities and relevant original index fingerprint. This target addition provides durable preview approval and recovery after commit succeeds but metadata persistence fails.

#### `sync_attempts`

`id`, `task_id` FK, `status`, `base_branch`, `base_sha`, `prior_task_sha`, `prior_synced_base_sha`, `candidate_sha?`, `conflict_snapshot_token?`, `error_message?`, `started_at`, `completed_at?`.

States: `PREPARED`, `MERGING`, `CONFLICT`, `ABORTING`, `SYNCED`, `ABORTED`, `FAILED`, `RECOVERY_REQUIRED`. Permit at most one unresolved attempt per task. Conflict token must cover meaningful contents/index/operation state, not only textual diff output.

#### `merge_attempts`

`id`, `task_id` FK, `status`, `base_branch`, `task_branch`, `approved_base_sha`, `approved_task_sha`, `error_message?`, `created_at`, `expires_at`, `confirmed_at?`, `completed_at?`.

States: `PREVIEWED`, `APPROVED`, `INTEGRATING`, `COMPLETED`, `REVOKED`, `FAILED`, `RECOVERY_REQUIRED`. Attempt ID is the one-time preview/approval ID. `approved_*` deliberately does not imply automated validation. Live observations determine whether uncertain integration can be finalized.

### 6.3 Deliberately excluded storage

Do not carry forward validation results/snapshots, active validation pointers, validation worktree fields, stage-specific handovers, handover input sequence, ticket comments, inference-wait workflow stages, merge priority-validation references, or duplicated single-question fields.

Do not create an app-test result/attestation table. Do not store every streaming token in SQLite. Ordinary run history already provides failure/stop timestamps; avoid redundant fields with identical meaning.

Schema-level uniqueness and application transactions must prevent concurrent active task ownership. Persist Git operation intent before side effects; use Git identity and expected refs to reconcile provisioning rather than deleting unknown resources.

## 7. Pi SDK integration contract

### 7.1 Core SDK APIs

These are the core APIs used by the current product and required capabilities for the rewrite. Exact signatures must match the pinned SDK.

| API | Required use |
|---|---|
| `SettingsManager.create(cwd, agentDir, {projectTrusted:false})` | Load app-owned settings without attached-project settings overriding them |
| `settingsManager.applyOverrides(...)` | Apply configured retry policy and native compaction without rewriting user settings |
| `DefaultResourceLoader(...)`, `await reload()` | Explicitly load reviewed app resources/extensions |
| `SessionManager.create(cwd, sessionDir)` | Create persistent task conversation |
| `SessionManager.open(savedFile, ..., cwd)` | Restore the task's exact saved conversation, not most-recent guessing |
| `createAgentSession({cwd,agentDir,settingsManager,resourceLoader,sessionManager,customTools})` | Host Pi directly with task cwd and hosted questionnaire tool |
| `session.subscribe(handler)` | Receive messages/tool events, retries/compaction and lifecycle notifications; retain unsubscribe |
| `session.prompt(text)` | Execute a run and await the complete SDK prompt lifecycle |
| `session.steer(text)` | Queue ordered live guidance; acceptance is not proof of persisted delivery |
| `session.abort()` | Stop active execution after cancelling app-owned tool waiters |
| `session.dispose()` | Release idle/closed task resources |
| Session-manager branch/entry access | Restore active history and correlate inputs/tool results; inspected SDK uses `getBranch`, `getLeafId`, `getLeafEntry` |
| Extension `pi.registerTool(...)` | Register app-owned extension tools such as todo |

Do not treat `agent_end` alone as successful completion: the SDK may retry or compact before `prompt()` settles. Compaction/model errors, exhausted token limits and unexpected aborts must not be labelled successful work.

Normal persisted-message events differ between SDK versions. Delivery confirmation must use verified durable entry evidence; a transient `message_end` event alone is insufficient. The adapter must expose stable application events regardless of SDK-specific append timing.

### 7.2 Session ownership

- One working conversation per task, reused across explicit runs; single-flight creation prevents duplicate sessions.
- Task cwd must be its verified worktree. Relative tool paths resolve there; this does not restrict absolute-path OS access.
- Persist exact session ID/file and run boundaries. Missing/corrupt/mismatched files require visible recovery, not silent empty sessions.
- Ordinary interrupted work is not automatically replayed after restart. Human-request continuation resumes only after matching durable answer/tool-call evidence.
- Use native Pi retries/compaction. Token budgets must be compatible with the configured model; no model/provider is hardcoded into product behavior.

### 7.3 Application-owned extensions

Required layout:

```text
<application>/.pi/agent/
  settings.json
  models.json
  auth.json                  # secret, gitignored
  extensions/
    package.json             # explicit pi.extensions allowlist
    pi-todo-list/index.ts
```

The resource loader resolves these paths from the application installation, not attached-project cwd. Disable automatic executable extension discovery and load the explicit allowlist using `additionalExtensionPaths`. Verify that allowlisted extensions load with `noExtensions: true` in the pinned SDK.

Global-user and attached-project extensions/packages must not execute implicitly. Required-extension errors and model fallbacks must be visible. Project `AGENTS.md` instructions may provide coding context; that does not authorize loading project executable extensions. Other resource discovery must have an explicit, tested scope.

The hosted questionnaire must not depend on terminal UI functions. Todo supports list/add/insert/edit/status/remove/clear, stores immutable complete snapshots in tool-result details, and restores state from session history. The frontend consumes those structured results rather than a Pi TUI widget.

## 8. Application API contract

Use shared runtime-validated request/response schemas. IDs in path/body must agree. Responses must distinguish durable acceptance, completed success and recovery-required outcomes.

Error shape: `{code,message,operation_id?,details?}`. Use 400 for invalid input, 404 for unavailable resources, 409 for state conflicts/stale approvals. A partial Git success must include known resulting SHA/operation identity rather than a misleading generic failure. If operations return 202, provide durable operation-status retrieval; otherwise return the completed result.

The following target endpoints represent core product capabilities; they need not preserve historical aliases.

| Method / endpoint | Request / response requirement |
|---|---|
| `GET /health` | Service/database health without secrets |
| `GET /api/projects` | Active projects/settings |
| `POST /api/projects/validate-git-root` | Path → canonical identity, branch information or validation error |
| `POST /api/projects` | Name, root, primary branch, optional settings → project |
| `PUT /api/projects/:id` | Validated safe settings update |
| `DELETE /api/projects/:id` | Safe archive, not destructive filesystem deletion |
| `GET /api/tasks?project_id=...` | Scoped task summaries |
| `POST /api/tasks` | Project/title/description → Todo task |
| `PATCH /api/tasks/:taskId` | Pre-work title/description update |
| `DELETE /api/tasks/:taskId` | Safe archive/resource cleanup or refusal |
| `GET /api/board` | Tasks grouped into five workflow columns |
| `GET /api/tasks/:taskId/runs` | Ordered run history/status/reasons |
| `POST /api/tasks/:taskId/queue` | `{prompt,idempotency_key,reused_from_input_id?}` → durable job/run identity |
| `GET /api/queue` | Jobs, positions, concurrency and active count |
| `PATCH /api/queue/:jobId` | `{position}` → reordered queue |
| `DELETE /api/queue/:jobId` | Cancel queued work coherently |
| `POST /api/runs/:runId/inputs` | `{input_id,text,reused_from_input_id?}` → input/delivery state |
| `POST /api/runs/:runId/stop` | Idempotent interruption result |
| `GET /api/tasks/:taskId/live/history` | Durable entries, inputs, active run, compaction summaries, provisional events/cursor |
| WS `/api/tasks/:taskId/runs/:runId/events` | Generation/cursor replay followed by live events; explicit gap notification |
| `GET /api/tasks/:taskId/human-requests` | Structured requests/answers/status |
| `POST /api/human-requests/:requestId/answer` | `{answers:[{id,value}]}` → normalized durable answer |
| `POST /api/human-requests/:requestId/stop` | Stop associated run |
| `POST /api/tasks/:taskId/open-in-ide` | Open verified worktree without requiring a conflict |
| `POST /api/tasks/:taskId/checkpoint-preview` | Create expiring immutable preview → preview ID, parent/branch, paths/diff |
| `POST /api/tasks/:taskId/checkpoint` | `{preview_id,confirmed:true}` → commit SHA/operation result |
| `GET /api/tasks/:taskId/checkpoint-diff` | Pinned base/candidate SHAs, file list/diff |
| `POST /api/tasks/:taskId/sync` | Explicit local-primary synchronization → outcome/captured SHAs/attempt |
| `GET /api/tasks/:taskId/sync-recovery` | Current attempt and safely available recovery actions |
| `POST /api/tasks/:taskId/sync/continue` | Verify/adopt human resolution or explicitly retry provably unstarted sync |
| `POST /api/tasks/:taskId/sync/abort` | `{confirmed:true,snapshot_token}` → guarded abort outcome |
| `GET /api/tasks/:taskId/check-sync` | Git-only `IN_SYNC`, `STALE`, `BLOCKED` snapshot |
| `POST /api/tasks/:taskId/merge-preview` | Create approval for exact refs or return sync/block requirement |
| `POST /api/tasks/:taskId/merge` | `{preview_id,confirmed:true}` → merged or stale/recovery outcome |
| `GET /api/tasks/:taskId/operations` | Commit/sync/merge attempts, known resulting SHAs, unresolved outcomes and available recovery actions, including after response loss/reload |
| `POST /api/tasks/:taskId/operations/:operationId/reconcile` | Explicitly inspect Git and reconcile an uncertain recorded outcome; never blindly repeat side effects; report manual recovery if unsafe |
| `POST /api/tasks/:taskId/cleanup` | Retry worktree cleanup only |
| `GET /api/tasks/:taskId/complete-preview` | Safe no-merge closure eligibility |
| `POST /api/tasks/:taskId/complete` | Explicit safe closure → `DONE/CLOSED` |

Preview creation uses POST because target previews are persisted approval records. Read-only diffs/readiness use GET. No legacy `/merge/abort` conflict mechanism is needed: conflicts belong to the single sync recovery workflow.

Live event envelope: `{event_id,task_id,run_id,generation,sequence,timestamp,type,data}`. New stream generations must not accidentally reuse a pre-restart cursor namespace. History is authoritative for durable content; transient deltas are not a substitute for it.

## 9. Frontend requirements

No visual layout is mandated. Prefer Astryx components for forms, dialogs, board/list surfaces, status, transcript/tool rendering and accessibility; Tailwind can supplement styling. The UI must provide:

| Surface | Required capabilities |
|---|---|
| Project management | Register/validate repo, confirm primary branch, configure IDE/worktree root, safe archive |
| Board | Five columns, project filtering, queued/running/waiting/review/outcome indicators |
| Task creation/details | Title/description/project, edit eligibility, resource paths and task history |
| Run composer | Explicit prompt, queued/live guidance, durable delivery status, reuse unresolved input |
| Queue | Capacity/active count, reorder/cancel queued work, stop active work |
| Live conversation | Streaming and persisted messages, tools/results, todos, retries/compaction, reconnect/gap/error states |
| Human questions | Multi-question choices/custom answers, validation, pending/answered/continuation-queued states |
| Review | Open IDE, human testing reminder, actual changed paths/diff, no-change behavior |
| Commit confirmation | Approved files including untracked inclusion, pinned snapshot, cancel, stale-preview refresh requiring renewed confirmation |
| Merge flow | Exact refs/candidate, human testing reminder, local sync when stale, pause after changed candidate, fresh final approval |
| Conflict recovery | Conflicting paths, Open IDE, resolution inspection/continue, guarded explicit abort |
| Completion | Merged versus closed outcome, cleanup-pending reason/retry, retained history |

Mutation controls should explain blocked prerequisites, but backend guards remain authoritative. Refresh/task switching must not leak another task's conversation or preview. User cancellation must not commit, merge or discard anything. Keyboard access and accessible labels/status/error announcements are required.

## 10. Reliability and recovery requirements

- **REL-01:** SQLite, Pi JSONL and Git are separate durable systems. Cross-system operations require intent, observed outcome and reconciliation; HTTP idempotency alone does not establish exactly-once side effects.
- **REL-02:** Serialize incompatible per-task mutations and repository-wide primary updates. Enforce a consistent lock order; reject active run/human-wait/sync conflicts across all command paths.
- **REL-03:** Startup reconciles Git operations, attempted input delivery, human requests and queue bookkeeping before dispatch. Never-dispatched queued inputs stay pending and executable.
- **REL-04:** Ordinary running work interrupted by restart becomes visible backend interruption. Uncertain delivered prompts are not resent. Pending questions remain usable; answered continuations resume only with matching transcript evidence.
- **REL-05:** Recovery is idempotent. A second startup or repeated user request must not duplicate a commit, tool result, merge or agent run.
- **REL-06:** Shutdown stops dispatch/mutations, cancels human waiters, boundedly aborts/drains sessions and child work, persists outcomes, disposes sessions, then closes storage/releases ownership.
- **REL-07:** Dispose idle/closed sessions and bound replay/resource usage. Report cancellation timeouts and unresolved operations instead of waiting forever or declaring success.
- **REL-08:** Git inspection failures fail closed. Handle spaces/Unicode/linked worktrees and supported object formats; explicitly report unsupported repository/path cases.
- **REL-09:** Preserve ignored files, external edits and ambiguous index/ref states. Never use silent destructive repair.
- **REL-10:** Backups/recovery guidance must account for SQLite, session files and Git/worktree state together. No startup operation resets user data.

## 11. Product acceptance criteria

These are outcome checks for future implementation plans, not implementation phases.

1. Two tasks in one project can run in distinct worktrees without modifying the primary checkout before merge-back.
2. A task can run, stop, receive follow-up work and restore the same conversation after restart.
3. Duplicate enqueue/input/answer requests do not duplicate work; conflicting idempotency reuse is rejected.
4. At concurrency one, a human-waiting task releases capacity for another task; its answer does not bypass the queue.
5. A request pending at restart can later be answered and resumed; that continuation can ask another question.
6. Never-dispatched queued work survives startup, while uncertain previously attempted inputs are not automatically replayed.
7. Live reconnect yields consistent durable history without duplicated final messages or silent event loss.
8. Human testing and manual edits are supported before Commit; no automated validation stage or mandatory handover appears.
9. Binary, untracked, renamed/deleted and concurrently changed files cannot bypass exact-content commit approval; cancellation preserves all work.
10. Local-primary advancement invokes task-side sync only; conflict state remains available for human resolution and retesting.
11. Successful sync changes invalidate old merge approval; stale/dirty/mismatched/linked-worktree states block unsafe integration.
12. Merge-back preserves primary and task ignored files, checks exact expected refs and never force-resets external work.
13. Crashes after Git success but before database finalization recover without repeating successful side effects; checked-out integration recovery verifies checkout as well as ref.
14. Successful merge with failed cleanup remains `DONE/MERGED` with visible retryable cleanup, not a false failure or silently lost directory.
15. Only app-allowlisted `.pi/agent/extensions` execute; missing required resources, model errors and unsupported Git conditions are visible.
16. Frontend actions expose these contracts without bypassing them, and frontend/backend implementation plans can be generated independently from this PRD.
