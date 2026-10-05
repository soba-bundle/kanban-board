# Phase 12 — Session UI Polish Tracker

**Status:** IN PROGRESS

**Last updated:** 2026-10-05

**Scope:** Live conversation rendering and related Phase 12 UI polish. Keep the Kanban board primary. Do not reintroduce Timeline or ticket comments.

Update this file whenever a feature is completed: mark its row `DONE`, record what changed, and add the verification result. Add new work here before starting it. Resource setup/configuration is deliberately deferred until the UI work below is complete.

## Completed

| ID | Work | Status | Change and verification |
|---|---|---|---|
| UI-01 | Align conversation roles | DONE | User prompts align right; assistant responses and tool results align left. Role classes have focused panel test coverage. |
| UI-02 | Compact, borderless messages | DONE | Removed message borders; user prompts retain a subtle tint and assistant messages use a compact transparent treatment. |
| UI-03 | Latest-response metadata | DONE | Removed per-message header timestamps. Only the latest assistant response shows timestamp/model/token metadata in its footer, after the run is no longer active and the entry contains final text (not a tool-use-only message). |
| UI-04 | Correlate tool calls and results | DONE | Added `apps/web/src/live-tool-adapter.ts`; matches by `toolCallId`, maps success/error and result details to Astryx `ChatToolCalls`, suppresses duplicate matched result rows, and preserves unmatched calls for review. Calls still running in the active run are shown as running. |
| UI-05 | Use Astryx chat tool rendering | DONE | Integrated `ChatToolCalls` and added the required Astryx reset/core stylesheet imports. Updated the Human Request interaction test to expand collapsed tool details before asserting their content. |
| UI-06 | Adapter coverage | DONE | Tests cover matched success/error, structured details, active unresolved calls, completed unmatched calls, and rendered tool groups. The inspected README task had 17 calls/results, zero unmatched calls/orphan results/name mismatches, and two failed results. |
| UI-07 | Improve tool-result readability | DONE | Kept readable result content separate from structured details; structured details now have their own expandable JSON section. Bash/PowerShell and file/listing tools render output in a bounded monospace block with preserved line breaks; unfamiliar tools get a readable generic text fallback. Added todo, bash, and custom-tool rendering assertions. |
| UI-14 | Widen task detail side panel | DONE | Set panel width to 50vw with a 580px minimum when available and 100vw cap for narrow viewports. Web production build, focused TicketPanel tests (3), and `git diff --check` pass. |
| UI-15 | Consistent width for expanded Live sections | DONE | Assistant transcript rows now fill the Live panel, so collapsible tool groups, reasoning, and result sections share the same available width. User prompts remain content-sized and right-aligned. Web build, all 58 web tests, and `git diff --check` pass. |
| UI-16 | Place tool disclosure arrows beside calls | DONE | Added scoped CSS for Astryx `ChatToolCalls`: single-call and per-call arrows no longer float to the far edge; in collapsed groups, the arrow follows the tool name/target and precedes the call-count badge. Expanded content remains full-width. Tests cover single/group class application; web build, all 58 web tests, and `git diff --check` pass. |

**Verification to date:** after UI-07, UI-14, UI-15, and UI-16, web typecheck and production build pass; all 58 web tests pass. `git diff --check` passes. The full test run printed non-fatal WebSocket port-in-use warnings.

## Remaining UI work

| ID | Work | Status | Acceptance / notes |
|---|---|---|---|
| UI-08 | Browser-check Live presentation | TODO | Inspect the actual Kanban ticket in a browser after the Astryx CSS integration: user/assistant alignment, compact borderless styling, latest-response metadata timing, collapsed/expanded calls, long output, and narrow panel behavior. Automated SSR tests do not verify visual CSS behavior. |
| UI-09 | Review unmatched-call presentation against a real occurrence | TODO | The adapter has synthetic coverage, but the inspected ticket had no unmatched calls. If a real unmatched call appears, inspect its transcript and decide whether its cause is active execution, interrupted execution, or malformed pairing before changing classification. Never label an unknown call complete. |
| UI-10 | Changed-file sidebar | TODO | Add the Phase 12 changed-file sidebar in the existing task-detail frame, preserving the current checkpoint/diff behavior and board-first workflow. |
| UI-11 | Audit toast and recovery messaging | TODO | Toast infrastructure and several recovery messages already exist. Compare current behavior with Phase 12 recovery/toast needs; implement only concrete gaps and record the specific cases verified. |
| UI-12 | Confirm Project filter and final-response metadata behavior | TODO | Project filtering already exists. Verify the filter remains display-only. Browser-check that latest final assistant metadata appears after completion and does not appear prematurely while streaming; keep the user's latest-response-only timestamp preference. |
| UI-13 | Reference dashboard theme polish | DEFERRED / LOW | The reference is styling inspiration only. Consider after functional Live/UI work; do not replace the current board frame or prioritize ahead of the items above. |

## Deferred future work — local Pi resources and Kanban-only configuration

**Do not start until the UI items above are complete.** First guide the user through the available local Pi resource setup, then decide whether they need app-specific isolation/configuration.

| ID | Work | Status | Acceptance / notes |
|---|---|---|---|
| RES-01 | Guided local resource setup | DEFERRED | Walk through local extension/skill/package locations and verify one selected resource in a Kanban session. Explain that user-global resources and task-worktree project resources have different scopes. |
| RES-02 | Define Kanban-owned capability configuration | DEFERRED | If the user wants per-dashboard selection, specify an application-owned config schema/path, Work-profile mapping, extension/skill source resolution, and explicit trust rules. Do not mutate or duplicate `~/.pi/agent`; preserve mandatory exclusion of the incompatible `pi-questions` extension. |
| RES-03 | Test resource isolation and lifecycle | DEFERRED | Test config round-trip, selected resource/tool exposure, isolation between tasks/sessions, and what happens when configuration changes between runs. Extensions execute with the server process's permissions; this UI/config is not a sandbox. |

### Current resource-loading facts for the future setup

- The server creates each task session with Pi `DefaultResourceLoader`, passing the task worktree as `cwd` and `getAgentDir()` as the Pi agent directory (`PI_CODING_AGENT_DIR` overrides the default `~/.pi/agent`).
- Pi can discover user-global extensions/packages and project-local resources in the task worktree. The current server loader excludes the configured global `pi-questions` path and registers Kanban's own questionnaire tool.
- The current app has no Pi capability selector. Its Kanban config currently covers inference retry settings, not a resource allowlist.
- `SettingsManager.create()` defaults project resources to trusted, and the hosted loader does not run the interactive trust prompt. Review this behavior when designing app-owned resource settings; extensions run with server-process permissions.
- A separate `PI_CODING_AGENT_DIR` for the server is a coarse process-level option, not a per-extension Kanban settings UI, and requires resources/credentials to be configured in that directory.

## Out of scope here

Phase 13 end-to-end hardening remains tracked in the implementation plan. Do not treat this Phase 12 tracker as an acceptance report for Phase 13.
