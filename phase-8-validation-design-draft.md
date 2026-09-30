# Phase 8 — Independent Validation Design Draft

**Status:** Acceptance-test specification approved and implemented through the UI/result-presentation slice. Server and web validation flows, stale-readiness checks, and cleanup reconciliation are covered by tests. Remaining work is a real-provider end-to-end Validation run, independent review, and the integrated Phase 8 gate.

## Implementation log

### Slice 1 — Stage-aware Pi tools

- Added `apps/server/src/pi/stage-tool-policy.ts` and connected it to `AgentManager`.
- Investigation and Validation hide and pre-block `write`/`edit`; Validation also hides and blocks `kanban_questionnaire`. Implementation retains its configured tools. The policy follows the active run stage and restores configured tools after the run. User-global Pi extensions were not modified.
- Verification: stage-policy and hosted-session tests passed (5/5); typecheck/build and 38 AgentManager, queue, Human Request, handover, and steering regression tests passed.

### Slice 2 — Validation contracts and result persistence

- Added shared schemas for finding attribution, rationale, evidence, file/line locations, reports, and result categories.
- Added database migration 9 for per-attempt candidate/base SHAs, live-base tips, guidance watermark, implementation-worktree state, validation-worktree path/cleanup state, and failure details.
- Added transactional result/snapshot persistence. Completed structured reports retain historical snapshots; only current results without direct/uncertain findings activate readiness. Malformed reports, infrastructure failures, and validation-worktree mutations fail without a snapshot. Finalization rechecks live-base and candidate state; post-readiness base/task-worktree changes invalidate the active pointer without rewriting history. Late older attempts cannot override a newer attempt.
- Verification: validation result, migration, shared-contract, and stage-policy tests passed; all-workspace typecheck passed. The latest full server suite reported 117 passed / 13 failed; remaining failures are acceptance tests for not-yet-implemented context, eligibility, cleanup, prompt, route, restart, and session lifecycle slices.

### Slice 3 — Pinned context and isolated resources

- Added `buildValidationContext`, which copies the task description, completed Implementation handovers through the checkpoint-producing run, delivered guidance through the captured watermark, repository context, and pinned SHA/diff data. It excludes the task title, later/undelivered guidance, and assistant transcript.
- Added `WorktreeManager.getPinnedDiff` to compute changed files and diff from exact base/candidate SHAs in the repository, independent of later task-branch movement.
- Added `createValidationSession` to create a fresh Review session in the supplied detached-worktree cwd and session directory, using the Kanban resource loader and the read-only Validation tool policy.
- Verification: context, session isolation, real-Git worktree, stage-policy, AgentManager, and Human Request tests passed (21/21); all-workspace typecheck passed. At that point the remaining reds concerned lifecycle wiring and cleanup recovery.

### Slice 4 — Validation start, queue, and isolated execution

- Added eligibility checks and an explicit `POST /api/tasks/:taskId/validation` route. The route uses the shared task-operation coordinator; queue insertion rechecks task state/checkpoint and active work transactionally to prevent duplicate starts.
- Added queue persistence for pinned context and start metadata (migration 10). Validation Review dispatch uses a dedicated `ValidationManager`; it never replaces or prompts the implementation working session. It creates a fresh detached worktree/session per run, publishes events under the validation run ID, accepts one schema-checked `submit_validation_report`, audits tracked worktree mutations, persists the result/snapshot, and attempts cleanup. Live guidance is rejected for Validation runs.
- Stop aborts the exact isolated session and records Validation Failed; stopping before dispatch never creates a session. Active Validation runs found during restart are marked failed, not replayed. A queued-but-not-started attempt can dispatch from its persisted pinned context. `ValidationCleanupManager` retries persisted cleanup paths at startup without touching the implementation worktree.
- Verification at completion: all 134 server tests, 11 shared tests, and 29 web tests passed; all-workspace typecheck and full build passed. The root `npm test` command completed successfully. No real-provider end-to-end validation run was performed; that and independent review remain before the integrated Phase 8 gate.

### Slice 5 — Validation UI and result presentation

- Added the web `startValidation` API wrapper and extended task/run contracts with pinned-worktree and validation-result/readiness fields. Task-run history now returns structured findings and whether that report is the current active snapshot.
- Task and run reads recheck the active snapshot against the live base tip and task worktree; stale snapshots lose active readiness and are not shown as Ready to Merge.
- Added an eligibility-gated Validate action, queued feedback, Validation run status in Runs, structured findings with evidence/locations, and category-specific copy actions.
- Verification: the five previously failing Phase 8 web acceptance tests now pass; full shared/server/web suites pass (11/134/29), all-workspace typecheck and full build pass, and `git diff --check` passes.

## 1. Agreed product behavior

### Start conditions and pinned input

- Validation is explicitly started by the user; it is not automatically launched after Implementation.
- Offer it only for an **Implementation Complete** task in Review, with a checkpoint.
- For the first version, pin the task's existing `base_commit_sha` and the latest checkpoint (`latest_task_commit_sha`). The detached validation worktree must check out the exact candidate checkpoint, not a moving branch name. Validation is blocked if the task worktree has uncommitted edits after that checkpoint.
- Do not update/sync the implementation branch from main as part of Phase 8. If the base needs syncing, retain that as a separate operation followed by a new checkpoint and validation. This is consistent with the existing Phase 9 base-moved flow.
- Also capture the live base-branch tip at validation start for race detection. If that tip changes during validation, mark that attempt Stale. If it had already moved before validation began, Phase 8 still evaluates the recorded `base_commit_sha`/checkpoint pair; Phase 9 must sync/revalidate before integration.
- At validation start, capture a stable guidance watermark. Give the validator the task description, all completed Implementation handovers through the checkpoint-producing run (in run order), and confirmed-delivered user guidance up to that watermark. Do not pass the task title. Exclude pending, undelivered, cancelled, or delivery-unknown inputs, and do not include the full assistant transcript by default.

### Isolation and tool policy

- Every validation attempt uses a fresh Review session and a fresh detached validation worktree. Never reuse the implementation session or a previous validation session/worktree.
- Investigation and Validation sessions should hide and block Pi `write` and `edit` calls; Implementation must retain its normal write/edit capability. The policy is stage-specific and Kanban-owned, not a modification to user-global extensions.
- The reviewer is instructed not to change code. In Investigation and Validation, hide and pre-block `write`/`edit`; keep Implementation writable. Unexpected tracked code changes in the validation worktree fail validation; Investigation gets the tool block but no new mutation-audit behavior in this phase. Bash remains available for inspection/build/test but is not guaranteed read-only; investigate additional controls separately.
- Validation must not change the implementation worktree or source checkout. Cleanup of its own detached worktree is required; cleanup failure must remain visible and recoverable rather than silently disappearing.

### Findings, result, and merge readiness

- Classify each finding as:
  - **Direct:** in changed code or causally introduced by the implementation, including a defect exposed elsewhere because of the change.
  - **Indirect:** an independent pre-existing issue in unchanged code that the implementation references or exposes.
- Findings should include an explanation, evidence, and file/line references. If attribution is uncertain, explicitly mark it uncertain and gate it like a direct finding until a fresh review resolves attribution.
- Persist structured findings with the validation run/snapshot and display them in the validation result/handover. Every structurally valid completed review gets an immutable snapshot. Set `active_validation_snapshot_id` only when there are no direct or uncertain findings and the pinned inputs are still current; direct/mixed and stale snapshots remain historical/inactive. Infrastructure, malformed-report, and mutation failures persist as attempt results without an active snapshot. Provide separate copy actions for direct and indirect findings.
- No findings: `PASSED`, task becomes **Ready to Merge**.
- Indirect-only findings: result is `ISSUES_FOUND`, task still becomes **Ready to Merge**, and indirect findings remain visible and copyable.
- Any direct findings, including mixed direct+indirect: result is `ISSUES_FOUND`, task becomes **Validation Issues**, and merge is blocked. Preserve the immutable result snapshot, but do not activate it for merge readiness.
- Direct issues are not retried against the same candidate. After fixes are committed as a new checkpoint, allow a fresh validation. Only a result with no direct findings permits merge.
- Infrastructure, session, tool, malformed-result, or tracked-mutation failures become **Validation Failed**, never Ready to Merge.
- A candidate SHA or live base-branch tip change during validation makes that result **Stale**, not Ready to Merge. Preserve the report for history and clear active readiness; do not misreport staleness as an infrastructure failure.
- Retrying a validation failure uses a new Review session and new disposable worktree; never resume the failed validation session.
- Validation Review does not issue Human Requests in the first version. If it lacks information, it reports uncertainty or Validation Failed; after user clarification, validation starts fresh. Existing Investigation Human Request behavior remains unchanged.

## 2. Current implementation context and gaps

Existing scaffolding is partial:

- `packages/shared/src/index.ts` already declares `VALIDATION_REVIEW` and validation-related review tags.
- The database already has `validation_results`, `validation_snapshots`, `active_validation_snapshot_id`, `latest_task_commit_sha`, and a validation message-watermark column.
- `WorktreeManager.createValidationWorktree()` can create a detached worktree at a supplied commit, and `removeValidationWorktree()` can remove it.
- Stop handling has some validation-specific behavior.

At the time this draft was started, the end-to-end path was absent:

- `QueueManager` explicitly excludes `VALIDATION_REVIEW` from accepted run stages; no validation-start API/queue action exists.
- The current agent lifecycle opens the task's working session in its task worktree. Validation needs a distinct Review session and validation worktree.
- There is no validation result contract/tool, context builder, result persistence/snapshot lifecycle, stale-state workflow, or validation UI/copy interaction.
- Restart cleanup/reconciliation does not yet provide validation-specific failure and disposable-worktree recovery semantics.
- There was no real-provider end-to-end Phase 8 validation test; hosted session behavior is covered by focused policy tests.

Relevant existing files include `apps/server/src/queue/queue-manager.ts`, `apps/server/src/agents/agent-manager.ts`, `apps/server/src/agents/run-manager.ts`, `apps/server/src/git/worktree-manager.ts`, `apps/server/src/db.ts`, and `apps/web/src/components/TicketPanel.tsx`.

## 3. Candidate acceptance-test cases

These are the approved acceptance-test specifications. Executable tests include server tests `stage-tool-policy.test.mjs`, `stage-tool-policy-session.test.mjs`, `validation-policy.test.mjs`, `validation-context.test.mjs`, `validation-prompt.test.mjs`, `validation-results.test.mjs`, `validation-queue.test.mjs`, `validation-routes.test.mjs`, `validation-cleanup.test.mjs`, `validation-sessions.test.mjs`, and `validation-lifecycle.test.mjs`; web tests `validation-api.test.mjs`; plus extensions to `handover-completion.test.mjs`, `worktree-manager.test.mjs`, `ticket-panel-interactions.test.mjs`, and `ticket-panel.test.mjs`. Full hosted-provider execution and UI lifecycle presentation remain unverified.

### Eligibility, queue, and snapshot pinning

- **V8-EL-01:** Implementation Complete in Review with a saved checkpoint offers an explicit Validate action.
- **V8-EL-02:** Investigation Complete, Interrupted, TODO, and active tasks cannot start validation. Validation Failed may retry the same eligible candidate; Validation Issues may validate only after a new checkpoint.
- **V8-EL-03:** Missing checkpoint is rejected with a clear prerequisite; no validation run/worktree is created.
- **V8-EL-04:** A task with queued/running work or a conflicting task operation cannot start validation; concurrent duplicate starts do not create duplicate runs.
- **V8-SHA-01:** Validation records exact `base_commit_sha` and checkpoint SHA, and the detached worktree HEAD is exactly the checkpoint SHA.
- **V8-SHA-02:** The diff/files sent to the reviewer are pinned to the recorded base/candidate pair, not a later branch HEAD.
- **V8-SHA-03:** Uncommitted edits after the checkpoint block validation until the task is clean and the intended candidate has been checkpointed.

### Guidance, context, and isolated sessions

- **V8-CTX-01:** The context contains the task description (not its title), all completed Implementation handovers through the checkpoint-producing run in run order, exact confirmed-delivered user guidance through the captured watermark, changed files/diff, repository context, and exact SHAs.
- **V8-CTX-02:** Pending, cancelled, undelivered, and delivery-unknown guidance is excluded; later-delivered guidance cannot alter an already captured snapshot.
- **V8-CTX-03:** The validation prompt does not include the task title or full assistant transcript.
- **V8-CTX-04:** Multiple qualifying Implementation handovers are included in order; later handovers from runs after the checkpoint producer are excluded. If no completed Implementation handover exists for the checkpoint, validation is blocked.
- **V8-ISO-01:** Validation runs in a fresh Review session distinct from the Implementation session; a later attempt gets a different session again.
- **V8-ISO-02:** The detached validation worktree is distinct from the task worktree and primary checkout; validation cannot change their HEAD or contents.
- **V8-ISO-03:** The reviewer receives the exact pinned diff and context even after the task worktree moves, rather than reading a live/moving task checkout.

### Stage-aware tool restriction

- **V8-TOOL-01:** In an Investigation hosted session, `write` and `edit` are absent from active tools and a direct attempted call is blocked before the tool executes; the target file remains unchanged.
- **V8-TOOL-02:** The same pre-execution block applies in a Validation hosted session.
- **V8-TOOL-03:** An Implementation session can still use `write` and `edit`; policy for one stage does not leak into a later stage or another task/session.
- **V8-TOOL-04:** The system prompt instructs the reviewer not to modify source code. Bash remains available for review/build/test commands; unexpected tracked mutations in Validation fail validation. Validation cannot park on a Human Request; missing information is reported without waiting for the user.
- **V8-TOOL-05:** Investigation has the pre-execution `write`/`edit` block, without changing its existing Human Request or other workflow behavior.

### Results, finding categories, and copy behavior

- **V8-RESULT-01:** A valid report with no findings persists as `PASSED`, creates an immutable snapshot, and sets Ready to Merge.
- **V8-RESULT-02:** Indirect-only findings persist as `ISSUES_FOUND`, set Ready to Merge, and remain visible/copyable.
- **V8-RESULT-03:** Direct-only findings persist as `ISSUES_FOUND`, set Validation Issues, and retain an immutable but inactive snapshot.
- **V8-RESULT-04:** Mixed findings persist both categories as `ISSUES_FOUND`, set Validation Issues, retain an immutable but inactive snapshot, and block merge.
- **V8-RESULT-05:** Uncertain attribution is explicitly represented and blocks readiness like a direct finding until resolved.
- **V8-RESULT-06:** Findings include causal rationale, evidence, and file/line references; direct and indirect copy controls copy only their respective findings.
- **V8-RESULT-07:** Malformed or incomplete structured reports cannot accidentally create a passing snapshot; classify as Validation Failed and persist no validation snapshot.
- **V8-RESULT-08:** Infrastructure/session/tool errors create a failure record but no validation snapshot or Ready-to-Merge state.
- **V8-RESULT-09:** A complete report whose pinned inputs became stale retains an immutable inactive snapshot and cannot activate readiness.
- **V8-RESULT-10:** After direct findings are fixed and a new checkpoint is created, a fresh validation with no direct findings permits readiness; old reports remain in history but are not authoritative.

### Mutation, cleanup, retry, stale state, and interruption

- **V8-CLEAN-01:** Unexpected tracked changes in the validation worktree override a claimed pass and produce Validation Failed.
- **V8-CLEAN-02:** The validation worktree is removed after success, issues, failure, and Stop. If removal fails, persist cleanup-pending state and surface it; never remove or alter the implementation worktree.
- **V8-RETRY-01:** Validation Failed can be retried with the same eligible candidate, but uses a fresh session/worktree and cannot reuse results from the failed attempt.
- **V8-RETRY-02:** Validation Issues cannot be immediately retried on the same checkpoint; a changed checkpoint is required before fresh validation.
- **V8-STALE-01:** Candidate SHA change while queued/running makes the result stale and prevents readiness.
- **V8-STALE-02:** A change to the live base-branch tip after validation starts makes the result stale; preserve its report for history but clear active readiness. A base that moved before validation begins is handled by Phase 9 sync/revalidation.
- **V8-STALE-03:** Recheck candidate and live base tip after the report is submitted and immediately before readiness activation; a change in that interval cannot activate a stale snapshot.
- **V8-STALE-04:** If the live base tip changes after readiness was activated, the validation is no longer merge-ready; preserve its findings and require Phase 9 sync/revalidation.
- **V8-STALE-05:** If the implementation task's HEAD or working-tree status changes during validation, mark the result Stale and keep its snapshot inactive. Changes to tracked files in the detached validation worktree instead produce Validation Failed under V8-CLEAN-01.
- **V8-STOP-01:** Stop before dispatch and during active validation produce Validation Failed, never Ready to Merge; cleanup is attempted and remains recoverable if it fails.
- **V8-RECOVER-01:** Backend restart during validation produces Validation Failed, never resumes the old reviewer prompt, and reconciles the disposable worktree/cleanup marker.
- **V8-RECOVER-02:** A crash between result persistence, snapshot activation, task-state update, and worktree cleanup cannot leave a false Ready-to-Merge state.

### Integrated UI/queue gate

- **V8-UI-01:** Validate is explicit, disabled/hidden when ineligible or conflicting work exists, and shows queued/running/progress/final status.
- **V8-UI-02:** Validation outcomes and findings are shown in Runs/Live; Ready to Merge with indirect findings still displays them.
- **V8-UI-03:** Direct/indirect copy actions copy the intended category and provide feedback.
- **V8-UI-04:** A passing/indirect-only result is not shown as merge-ready if its snapshot is stale or invalidated.
- **V8-GATE-01:** Shared/server/web tests, typecheck, real-Git worktree tests, hosted Pi session tests, and the integrated suite cover the accepted behaviors.

## 4. Proposed implementation breakdown (after test cases are approved)

Each slice should begin with its tests, be reviewed with the user, then be implemented and verified before moving to the next slice.

1. **Approve the acceptance contract.** Review the cases and resolved policies in this draft; turn accepted cases into executable tests first and verify the intended red baseline. Keep Laya/Bash-policy research optional and separate.
2. **Stage-aware Pi tool policy (implemented).** The Kanban-owned policy is under `apps/server/src/pi/`; it hides and pre-blocks `write`/`edit` for Investigation and Validation, blocks Human Requests only in Validation, and preserves Implementation writes. Hosted `AgentSession` tests pass. User-global extensions remain untouched.
3. **Validation contracts and persistence (implemented).** Shared report/finding schemas, result metadata and cleanup fields, migration 9, stale/readiness gates, and transactional result/snapshot persistence are implemented. Historical snapshots are retained for completed structured reports; only current no-direct/no-uncertain results may become active for merge readiness.
4. **Pinned context and isolated resources (implemented and wired).** `buildValidationContext`, `createValidationSession`, `WorktreeManager.getPinnedDiff`, and the detached worktree factory are used by the explicit Validation start and isolated executor.
5. **Queue/API/run lifecycle (implemented; recovery coverage remains).** Explicit eligibility/start, validation queue dispatch, structured result submission, outcome transitions, retry rules, Stop behavior, and operation/concurrency protection are implemented. Startup cleanup recovery and the remaining crash-boundary tests stay in Slice 7.
6. **UI and result presentation (implemented).** The Validate action/status, findings, category copy controls, and active-snapshot readiness display are implemented.
7. **Staleness, cleanup, and recovery (core implemented).** Candidate/base races, cleanup pending/reconciliation, and no restart replay have focused coverage. Real-provider end-to-end Validation and remaining crash-boundary review are outstanding.
8. **Integrated Phase 8 gate (remaining).** Run independent review and any additional focused Git/Pi acceptance, then document the verified result. Do not start Phase 9 merge-back implementation as part of this phase.

## 5. Decisions recorded and follow-up research

- Validation is blocked until the task worktree is clean and the intended candidate is checkpointed.
- Use the recorded `base_commit_sha` as the Phase 8 diff baseline and checkpoint as the candidate. Separately capture the live base-branch tip at start; movement during the run makes the result Stale. A base already moved before validation is handled by Phase 9 sync/revalidation.
- Uncertain finding attribution blocks readiness like a direct finding until a fresh review resolves it.
- Validation Review does not issue Human Requests in the first version; missing information is reported without parking.
- The initial Phase 8 policy blocks `write`/`edit` and audits tracked changes; it does not claim arbitrary Bash is read-only. The correct project is [`receptron/laya`](https://github.com/receptron/laya), a typed decision/classification model. Treat it as optional follow-up research, not an authorization boundary. Assess false negatives on Windows shell commands, latency/dependency cost, and fail-closed behavior before any integration.
- **Cleanup persistence resolved:** persist the validation worktree path and cleanup status on each `validation_results` attempt row. Startup can retry cleanup and the UI can surface pending cleanup; keep task `cleanup_status` dedicated to the implementation worktree.
