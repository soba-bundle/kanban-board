# Phase 9 — Merge Back and Diff Polish (Acceptance-Test Draft)

**Status:** Historical Phase 9 design/implementation record. Current merge-back/readiness behavior is superseded by W-12–W-14.
**Current source of truth:** [Workflow Simplification, Sync, and Checkpoint Plan](workflow-simplification-sync-and-checkpoint-plan.md).

> Current readiness uses Git-only Check sync; no priority Validation or automatic Validation is run. Sync with main is explicit and separate from Merge back. Merge-back requires a current preview/explicit approval and final safety checks; non-primary linked-worktree refusal remains. Developers own application testing and code review.

**Historical sources:** `local-agent-kanban-prd-v2.md` and `local-agent-kanban-implementation-plan-v2.md` as they stood during Phase 9. Their earlier Validation-gated merge behavior is superseded; current behavior is in the linked workflow plan above.

## 1. Goal and safety boundaries

Add an explicit, validation-gated “Merge back to working branch” flow that integrates only the exact validated task/base state, plus polish the SHA-pinned checkpoint diff viewer. A checkpoint alone is never approval or validation. Do not modify a dirty primary checkout, automatically resolve conflicts, silently discard work, or resume an approval after backend restart. Preserve the task branch and make successful/closed outcomes explicit (`MERGED` or `CLOSED`).

A base movement requires a persisted explicit approval intent, syncing the new base into the task branch, a fresh priority Validation (priority must not preempt active work), and final exact-SHA checks before integration. A second base movement, conflict, restart, or uncertain Git state stops automation and clears approval as required by the source requirements.

## 2. Test-first implementation plan (completed)

The acceptance suite was authored before production behavior. Its temporary-Git fixtures are isolated from the user repository and database. Implementation proceeded after the acceptance cases and remaining gaps were reviewed.

### Slice A — Eligibility, approval intent, and persistence

Tests: P9-EL-01–05, P9-APP-01–03.
Implement persisted merge-attempt/approval lifecycle and server-authoritative eligibility. Verify UI prerequisites and same-task operation locking.

### Slice B — Unchanged-base integration

Tests: P9-MERGE-01–06, P9-REF-01–03.
Test clean final checks, fast-forward, deterministic post-integration verification, checked-out and unchecked-out base behavior, and expected-old-SHA ref updates. No merge action may mutate the primary checkout unless its supported safety checks pass.

### Slice C — Moved base, sync, and priority validation

Tests: P9-BASE-01–06, P9-QUEUE-01–02.
Test approval intent, base sync into the task branch, fresh priority validation without preemption, and exact-SHA rechecks. A second move terminates the flow and drops approval.

### Slice D — Conflict, restart, and manual recovery

Tests: P9-CONFLICT-01–05, P9-RECOVER-01–04.
Conflicts and unexpected Git operations stop automation. Cover Abort / Retry / View Conflicts, restart boundaries, approval expiry, and recovery after a ref update whose DB completion record was interrupted.

### Slice E — Completion, cleanup, and diff polish

Tests: P9-DONE-01–04, P9-DIFF-01–06.
Only clean worktrees may be removed; cleanup failures remain visible. Diff views retain explicit SHA pinning while adding changed-file navigation and unified/side-by-side presentation, subject to the scope decision below.

### Final gate

Run focused acceptance tests, real temporary-Git integration tests, web interaction tests, typecheck/build, and the full `npm test` suite. Review the complete diff and run `git diff --check`. Record each case's final test, implementation, and verification status below; Phase 9 is not passed merely because all tests compile.

## 3. Acceptance cases and status tracker

Status vocabulary: `GREEN` = focused acceptance test passes; `VERIFIED` = included in the final full gate. All Phase 9 rows below are `GREEN` and `VERIFIED`.

| ID | Acceptance case | Test status | Implementation | Verification |
|---|---|---|---|---|
| P9-EL-01 | Merge is unavailable unless task is in Review and its active snapshot is current, passed/indirect-only, and matches exact task/base SHAs. | GREEN | IMPLEMENTED | VERIFIED |
| P9-EL-02 | Missing, stale, inactive, issue-blocked, or failed Validation cannot be merged; show the unmet prerequisite. | GREEN | IMPLEMENTED | VERIFIED |
| P9-EL-03 | A clean current checkpoint shows the Merge Back action; a checkpoint by itself never integrates or implies approval. | GREEN | IMPLEMENTED | VERIFIED |
| P9-EL-04 | Dirty worktree, candidate/head mismatch, active task work, in-progress Git operation, or unavailable Git state blocks merge fail-closed. | GREEN | IMPLEMENTED | VERIFIED |
| P9-EL-05 | Merge, checkpoint, queue start, completion, and worktree removal serialize through the same task-operation boundary. | GREEN | IMPLEMENTED | VERIFIED |
| P9-APP-01 | User must explicitly confirm merge intent; cancel has no Git, task, queue, or approval side effects. | GREEN | IMPLEMENTED | VERIFIED |
| P9-APP-02 | Persist approval intent with its exact validation snapshot/base/task SHAs and merge attempt; duplicate requests are idempotent or rejected without duplicate integration. | GREEN | IMPLEMENTED | VERIFIED |
| P9-APP-03 | Approval is cleared on conflict, second base movement, or restart; no approval silently survives an unsafe state. | GREEN | IMPLEMENTED | VERIFIED |
| P9-MERGE-01 | With unchanged exact base and task SHAs, final checks precede a fast-forward of only the recorded base branch to the validated candidate. | GREEN | IMPLEMENTED | VERIFIED |
| P9-MERGE-02 | Post-integration verification proves the base ref/HEAD equals the candidate and records an immutable successful attempt and `MERGED` resolution. | GREEN | IMPLEMENTED | VERIFIED |
| P9-MERGE-03 | A concurrent base/task SHA change between preview/confirmation and integration prevents update; never overwrite newer work. | GREEN | IMPLEMENTED | VERIFIED |
| P9-MERGE-04 | Repeating a completed merge request cannot create another merge or corrupt the completed state. | GREEN | IMPLEMENTED | VERIFIED |
| P9-MERGE-05 | New delivered user guidance beyond the validation watermark is not silently treated as validated; merge requires the specified fresh-validation path. | GREEN | IMPLEMENTED | VERIFIED |
| P9-MERGE-06 | A validation pass does not auto-merge; integration only follows explicit user intent. | GREEN | IMPLEMENTED | VERIFIED |
| P9-BASE-01 | If the recorded base moved, require explicit approval intent before syncing; never silently rebase/sync or integrate. | GREEN | IMPLEMENTED | VERIFIED |
| P9-BASE-02 | Sync the captured current base into the task branch without changing the primary checkout; persist the resulting base/candidate SHAs and invalidate the old snapshot. | GREEN | IMPLEMENTED | VERIFIED |
| P9-BASE-03 | A sync conflict stops automation, marks Merge Conflict, preserves files/markers, and clears approval; no automatic resolution. | GREEN | IMPLEMENTED | VERIFIED |
| P9-BASE-04 | Successful sync queues fresh priority Validation; priority does not preempt active work and task/run state remains coherent while waiting. | GREEN | IMPLEMENTED | VERIFIED |
| P9-BASE-05 | After the fresh Validation passes, recheck the exact synced base and candidate SHAs immediately before fast-forward. | GREEN | IMPLEMENTED | VERIFIED |
| P9-BASE-06 | If base moves a second time, stop the loop, clear approval, and require a new user decision; do not keep syncing automatically. | GREEN | IMPLEMENTED | VERIFIED |
| P9-QUEUE-01 | Priority Validation is ordered ahead of ordinary queued work where safe, but never preempts an active job. | GREEN | IMPLEMENTED | VERIFIED |
| P9-QUEUE-02 | Stopping/removing priority Validation or restarting during sync/validation revokes approval; preserve the synced branch and require fresh Validation plus new merge confirmation. | GREEN | IMPLEMENTED | VERIFIED |
| P9-CONFLICT-01 | Detect merge conflicts (`MERGE_HEAD`) and unexpected rebase/cherry-pick/revert state; block merge and preserve manual recovery state. | GREEN | IMPLEMENTED | VERIFIED |
| P9-CONFLICT-02 | Abort safely returns to a known task state without deleting user changes; approval is void. | GREEN | IMPLEMENTED | VERIFIED |
| P9-CONFLICT-03 | View Conflicts opens the task worktree in the configured IDE or presents a clear error without changing Git state. | GREEN | IMPLEMENTED | VERIFIED |
| P9-CONFLICT-04 | After manual resolution is committed, Retry records that commit as the new checkpoint and queues fresh Validation; a new explicit merge approval is required before integration. | GREEN | IMPLEMENTED | VERIFIED |
| P9-CONFLICT-05 | Retry never blindly repeats a failed/ambiguous Git operation; it first rechecks markers, branch, HEAD, and attempt state. | GREEN | IMPLEMENTED | VERIFIED |
| P9-REF-01 | A dirty primary checkout is never modified; merge is blocked with a clear reason and all user files remain unchanged. | GREEN | IMPLEMENTED | VERIFIED |
| P9-REF-02 | If the base is not checked out, prove candidate ancestry and update the base ref with expected-old-SHA compare-and-swap. | GREEN | IMPLEMENTED | VERIFIED |
| P9-REF-03 | A CAS failure caused by a concurrent ref movement preserves the new ref and drops approval for a fresh decision. | GREEN | IMPLEMENTED | VERIFIED |
| P9-REF-04 | If the base branch is checked out in a non-primary linked worktree, block without changing any checkout/ref and explain safe resolution; support for integrating through that worktree is future scope. | GREEN | IMPLEMENTED | VERIFIED |
| P9-RECOVER-01 | Restart before Git mutation drops approval and does not resume the merge automatically. | GREEN | IMPLEMENTED | VERIFIED |
| P9-RECOVER-02 | Restart during conflict/sync detects Git markers, preserves the worktree, and exposes manual recovery; no destructive repair. | GREEN | IMPLEMENTED | VERIFIED |
| P9-RECOVER-03 | Crash after the base ref changed but before DB completion is reconciled from exact recorded old/new SHAs without repeating Git mutation. | GREEN | IMPLEMENTED | VERIFIED |
| P9-RECOVER-04 | Crash before/after cleanup cannot mark an unmerged task `MERGED` or delete a dirty worktree; cleanup is retryable and visible. | GREEN | IMPLEMENTED | VERIFIED |
| P9-DONE-01 | Successful merge closes the task as Done / `MERGED`, preserves the task branch, and removes only a clean task worktree. | GREEN | IMPLEMENTED | VERIFIED |
| P9-DONE-02 | Mark as done without merge remains a distinct `CLOSED` resolution and only applies when the clean task branch equals its recorded base. | GREEN | IMPLEMENTED | VERIFIED |
| P9-DONE-03 | Dirty changes are never silently discarded; the UI blocks Done/cleanup and offers explicit checkpointing, with no app-provided Discard action; backend refuses dirty cleanup. | GREEN | IMPLEMENTED | VERIFIED |
| P9-DONE-04 | Worktree cleanup failure records `CLEANUP_PENDING`, retains task/history/branch, and permits safe retry. | GREEN | IMPLEMENTED | VERIFIED |
| P9-DIFF-01 | Changed-file list is derived from explicit base/checkpoint SHAs and is navigable; selecting a file shows only its patch. | GREEN | IMPLEMENTED | VERIFIED |
| P9-DIFF-02 | Unified and side-by-side views render additions/deletions/renames and binary/empty diffs safely, with no HTML interpretation of source text. | GREEN | IMPLEMENTED | VERIFIED |
| P9-DIFF-03 | Later uncommitted edits or branch movement do not change an already selected checkpoint comparison. | GREEN | IMPLEMENTED | VERIFIED |
| P9-DIFF-04 | Diff API handles unusual filenames, large/empty patches, missing objects, and invalid SHA inputs safely. | GREEN | IMPLEMENTED | VERIFIED |
| P9-DIFF-05 | Switching files/views and closing/reopening the viewer does not leak another task's diff or stale response. | GREEN | IMPLEMENTED | VERIFIED |
| P9-DIFF-06 | Merge/validation state remains accurately presented beside the diff; diff polish never implies approval or merge completion. | GREEN | IMPLEMENTED | VERIFIED |

## 4. Resolved scope and behavior

- **Diff scope:** Phase 9 owns checkpoint-diff changed-file navigation and unified/side-by-side rendering. Phase 12 remains broader Live/session/tool rendering polish.
- **Approval after base sync:** one explicit user intent authorizes one base sync and its fresh priority Validation. If that Validation passes, integrate only after exact-SHA rechecks. Drop approval on conflict, restart, a second base movement, or any failed safety check; do not ask for a second confirmation in the normal successful path.
- **Base branch in a non-primary linked worktree:** block safely for now with an actionable message explaining how to resolve it (make the recorded base branch available in the primary checkout or remove the extra checkout before retrying). Add safe integration into a separate linked worktree as explicit future work, not as a hidden limitation.
- **Manual conflict resolution:** when the user resolves and commits in their IDE, Retry records the clean resulting HEAD as a new checkpoint and queues fresh Validation. That old approval stays revoked; the user must explicitly approve a new merge after Validation passes.
- **Stopped priority Validation:** stopping or removing it revokes the merge approval but preserves the already-synced task branch. A later merge requires a fresh passing Validation and new explicit merge approval; no late completion event may merge it.
- **Dirty-worktree discard:** Kanban will not offer a Discard action. It blocks Done/cleanup and offers explicit checkpointing; user changes remain until resolved outside that flow.
- **CAS race testing:** use a narrow internal callback immediately before the compare-and-swap ref update to inject a competing writer deterministically. This is test-only plumbing, not a user-facing setting; preserve the competing commit and revoke the pending approval on failure.

## 5. Test coverage ledger — final

- Server acceptance: temporary-real-Git merge-manager tests cover explicit approval, current snapshot eligibility, unchanged-base integration, ref CAS, base sync and revalidation, linked-worktree safety, conflicts, retry/abort, stop/removal revocation, restart recovery, and cleanup. Route tests cover explicit approval and conflict action delegation.
- Queue coverage verifies priority ordering without preemption, removal notification after cancellation, and stop behavior; app wiring connects both cancellation paths and Validation completion to the merge lifecycle.
- Web interactions cover explicit merge confirmation/cancel, ineligible/stale/base-moved states, conflict recovery actions, checkpoint file navigation, unified/side-by-side views, safe text rendering, empty diffs, and stale-response isolation.
- Checkpoint diffs remain pinned to recorded base/candidate SHAs and use the repository root, so viewing remains possible after the task worktree is removed.
- Final gate: `npm test` passed (shared 11, server 165, web 40); `npm run typecheck` passed; `git diff --check` passed.

## 6. Current baseline and scope notes

- Phase 8 is committed and passed; Validation snapshots pin task/base SHAs and guidance watermark. Phase 9 enforces these values at merge time and does not treat old readiness as authorization.
- The additive database migration stores merge-sync and priority-Validation linkage without resetting existing databases.
- Existing completion logic closes a clean unchanged task as `CLOSED`; successful merge is a distinct `MERGED` resolution.
- **Future feature:** safely integrate when the recorded base branch is checked out in a non-primary linked worktree. Phase 9 blocks that layout with actionable guidance and does not mutate it.
- Preserve the three pre-existing Phase 6A document deletions; they are outside Phase 9.
