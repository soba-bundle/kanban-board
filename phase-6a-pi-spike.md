# Phase 6A — Step 2 Pi delivery/history spike

Recorded 2026-09-28. All real-agent checks used isolated temporary session directories;
they did not use or modify the demo database, existing session files, or worktrees.
Temporary test data was removed afterward. Inference requests succeeded against the
currently configured Pi provider.

## Findings

### Durable, branch-aware session history

Installed SDK is `@earendil-works/pi-coding-agent` `^0.84.4` (installed package
resolved from repository lock/install). Its typings expose:

- `SessionManager.getEntries()`, `getBranch()`, `buildContextEntries()` and
  `getTree()` for session entry/history inspection.
- Message entries with stable entry IDs and parent IDs in the append-only session
  tree; `getBranch()` represents the active path. History should be read from the
  session manager's active branch/context rather than naïvely concatenating every
  line in JSONL, because the session can contain branched paths and compaction.
- `SessionManager.open(path, sessionDir?, cwdOverride?)` and
  `createAgentSession(...)` restore a persisted session.

Real inference check confirmed prompt user and assistant messages were appended to
the temporary session history. After disposal and restore, the session ID remained
the same, prior entries were present, and a newly attached event listener saw the
restored session's new user/assistant `message_end` events. Thus restoring and
subscribing before prompting works in this installation.

### Steering delivery evidence

SDK `steer()` documentation says it queues steering during an active run, to be
delivered after current assistant turn/tool execution before the next LLM call.
A real run accepted two identical steering strings while streaming. Both appeared
as separate user message entries after the initial prompt, each followed by an
assistant response. This confirms queued accepted steering can become distinct
conversation messages and text matching can disambiguate duplicates only by order,
not by an intrinsic request identity.

Pi session user entries expose stable entry IDs, but inspection of the public
`steer(text, images?)` API and emitted user `message_start` event shows no caller
input ID is accepted or echoed. `entry_appended` provides the persisted entry; a
correlation method must therefore bind a particular queued input to the exact
resulting entry using serialized per-session send order and a carefully defined
matching rule. Same-text concurrent sends make content-only matching ambiguous.
Stable app input IDs belong in SQLite; they cannot be assumed to be Pi entry IDs.

### Existing smoke harness is currently stale

`npm run smoke:pi` builds successfully but the checked-in smoke harness fails
before completing its intended verification. It calls `RunManager.start(runId,
string)` while current `RunManager.start` expects a `RunPrompt` object; its old
`run-manager` contract causes `revertCommentsToPending` to receive an undefined
comment ID list. The harness has not passed as-is and must be updated as part of
future smoke coverage. Its temporary directory cleanup ran; no demo state was used.

The probe also shows the current `Pi SessionManager` is synchronous for entry
inspection and the agent session supports fresh event subscription after restore.
It does not yet prove race-safe history+WebSocket cursor handoff or matching of
concurrent same-text steering accepted from distinct HTTP requests.

## Implementation implications

1. Use Pi's session manager/JSONL as the source of transcript content and entry
   identity; SQLite stores workflow/run boundaries and stable app input identity.
2. Scope/serialize dispatch and steering per task session. Correlate delivery to
   the next expected appended user entry in the same ordered session operation;
   persist the Pi entry ID with the input. Do not claim Pi receives an idempotency
   key, and do not correlate by arbitrary earliest matching text across tasks/runs.
3. On session restore, load active-branch history and rebind listeners before
   exposing the live snapshot/subscription.
4. Repair the real-Pi smoke harness contract and add explicit assertions for the
   transcript entry IDs/order, duplicate identical steering, restored subscription,
   and stop-before-delivery behavior.
5. Further design/test is required for the critical acceptance-to-delivery window:
   after SQLite records accepted intent but before `steer()` is invoked or the
   user entry is appended, a crash may leave delivery uncertain. Do not automatically
   resend this ambiguous input; expose it for user-directed reuse unless future
   transcript reconciliation proves receipt.

## Limits / unresolved risks

- This was a local run against the current inference configuration and SDK version,
  not proof for every provider, SDK update, tool-execution boundary, network retry,
  process crash, or simultaneous HTTP race.
- Real identical messages were delivered distinctly and in order in one run, but
  their entries did not contain an application input ID. Exact durable attribution
  under a crash at every boundary remains to be designed/tested.
- The smoke harness did not verify authoritative handover replacement after late
  steering. That behavior remains Phase 6A implementation work.
- Existing `npm run smoke:pi` failure is a concrete issue to repair before relying
  on the scripted integration acceptance gate.

## Gate result

SDK behavior needed for durable, append-only transcript reading and restored-session
event rebinding is confirmed. Active steering acceptance leads to ordered transcript
user entries under the observed conditions. However, exact crash-safe delivery
correlation cannot rely on SDK-level message IDs because none are passed through
`steer()`; implement serialized per-session correlation and an explicit ambiguous
undelivered state. The existing smoke script also needs repair. This is sufficient
to proceed with contract/schema design, but those limitations must be addressed in
Phase 6A tests rather than treated as already solved.
