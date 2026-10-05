# Phase 12 — Session UI Polish Tracker

**Status:** IN PROGRESS

**Last updated:** 2026-10-05

**Scope:** Live conversation rendering and related Phase 12 UI polish. Keep the Kanban board primary. Do not reintroduce Timeline or ticket comments.

Update this file whenever a feature is completed: mark its row `DONE`, record what changed, and add the verification result. Add new work here before starting it. Project-local extension setup was previously deferred; the user requested an explicit allowlisted Pi extension port and pinned Live widget, implemented below.

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
| UI-17 | Stream tool calls as stable formatted rows | DONE | Refresh transcript history on each persisted `entry_appended` event so a tool-call row appears while its command is running. The row shimmers on its command target, has no result disclosure until a tool result arrives, then reveals the formatted output immediately (without waiting for the assistant turn). Removed the duplicate raw `[tool] ...` provisional log line. Added an event-driven running-to-completed UI test and error-result coverage. |
| UI-18 | Todo calls as concise status lines | DONE | Todo calls use a sanitized `ChatToolCalls` row whose target is only the checkmarked summary; original arguments/data and result disclosure are omitted. In-progress calls use a brief status target; unmatched todo arguments stay hidden for review. Non-todo tool results preserve their full output in the expanded result, including orphan results. Added Live transcript regression assertions. |
| UI-21 | Per-call edit diff summaries and previews | DONE | Successful `edit` results derive additions/deletions from Pi's unified patch for Astryx `ChatToolCalls` compact stats. Expanding the call shows before/after edited snippets in CodeBlocks with red/green tinted panels. Failed edits and `write` results do not invent diffs. Added adapter and Live interaction coverage. |
| UI-22 | Tool-result presentation | DONE | Todo results remain summary-only. Other matched and orphan results show full output in the expanded result; other structured details remain separately expandable. Successful edit results keep their dedicated diff preview from UI-21. |
| UI-30 | Pin the Pi todo list above the Live composer | DONE | Ported the installed `pi-todo-list` extension to `.pi/extensions/pi-todo-list`, derive the latest persisted `details.todos` snapshot for Live, and render it between the transcript body and composer with a compact, cardless five-row token-sized ScrollableArea and subtle top divider. StatusDot variants show waiting (neutral), in progress (pulsing accent), and completed (success). Server allowlist and extension startup are documented in `PI-EXTENSIONS.md`. Added history parsing, clear-state, widget, scroll-cap, and project-only loader assertions. |

**Verification to date:** after UI-07, UI-14, UI-15, UI-16, UI-17, the Live-summary/edit-diff work (UI-18, UI-21, UI-22), and UI-30, the full workspace build passes; shared tests (13), server tests (159), and web tests (61) pass. UI-30 uses an Astryx `ScrollableArea` with a token-based five-row max block size. `git diff --check` passes. Web tests emit non-fatal WebSocket port-in-use warnings.

## Remaining UI work

| ID | Work | Status | Acceptance / notes |
|---|---|---|---|
| UI-08 | Browser-check Live presentation | TODO | Inspect persisted history and perform a read-only live run. Check alignment, compact styling, latest-response metadata, stable tool rows while running, shimmer, arrow/result appearance on tool completion, long output, and narrow panel behavior. The user did not clearly see the current shimmer; use a deliberately longer read-only command to confirm visibility and tune it if needed. Automated SSR tests do not verify visual CSS behavior. |
| UI-09 | Review unmatched-call presentation against a real occurrence | TODO | The adapter has synthetic coverage, but the inspected ticket had no unmatched calls. If a real unmatched call appears, inspect its transcript and decide whether its cause is active execution, interrupted execution, or malformed pairing before changing classification. Never label an unknown call complete. |
| UI-10 | Changed-file sidebar | TODO | Add the Phase 12 changed-file sidebar in the existing task-detail frame, preserving the current checkpoint/diff behavior and board-first workflow. |
| UI-11 | Audit toast and recovery messaging | TODO | Toast infrastructure and several recovery messages already exist. Compare current behavior with Phase 12 recovery/toast needs; implement only concrete gaps and record the specific cases verified. |
| UI-12 | Confirm Project filter and final-response metadata behavior | TODO | Project filtering already exists. Verify the filter remains display-only. Browser-check that latest final assistant metadata appears after completion and does not appear prematurely while streaming; keep the user's latest-response-only timestamp preference. |
| UI-13 | Reference dashboard theme polish | DEFERRED / LOW | The reference is styling inspiration only. Consider after functional Live/UI work; do not replace the current board frame or prioritize ahead of the items above. |
| UI-19 | Emphasize tool names | TODO | Keep Astryx `ChatToolCalls` for layout/statuses; make the tool name bold and a distinct theme-token color. Prefer a stable public styling hook; if unavailable, assess a small swizzle rather than depending silently on generated internal class names. |
| UI-20 | One Agent label per assistant turn | TODO | Group consecutive assistant entries/tool activity into a turn-level response so “Agent” appears once at the top; start a new assistant label after the next user prompt. Preserve event ordering and result disclosure behavior. |
| UI-23 | Render assistant text as Markdown | TODO | Replace plain-text assistant response rendering with Astryx `Markdown` (and consider reasoning only if Markdown is appropriate there). This would render lists, links and fenced code consistently; keep streaming support and verify untrusted transcript content remains safely rendered. Astryx Markdown supports custom component overrides, including a CodeBlock renderer, for consistent code styling. |

| UI-24 | Adopt Astryx ChatComposer | TODO | Replace the custom Live textarea/send row with `ChatComposer` only after wiring its controlled draft and submit/stop contract to existing start-run, running-run guidance, queued-run guidance, and Human Request disabled states. Keep task-specific delivery/recovery status visible. |
| UI-25 | Use Astryx TabList and compaction progress | TODO | Replace custom Live/Runs tabs with an accessible `TabList` + `Tab` pair and linked panels. Replace the custom compaction shimmer with labeled `ProgressBar isIndeterminate` while compaction is active; retain error/completion feedback. |
| UI-26 | Pin richer task metadata in the ticket header | TODO | Keep the current header pinned and add concise description, working directory (`task.worktree_path` when present), and created time (`task.created_at`) using `MetadataList`/`MetadataListItem` and suitable text truncation. Avoid turning the header into a tall metadata dump. |
| UI-27 | Consolidate Git actions and status messaging | TODO | Review the crowded `review-actions` area. Consider a compact Git-actions menu using Popover on desktop and BottomSheet on touch/narrow layouts, while preserving preview and explicit confirmation for mutations. Check sync is read-only; sync/checkpoint/merge/recovery actions must keep their existing safety gates. Use Banner for persistent uncheckpointed changes or actionable Git state, Toast for brief success, and FieldStatus only for field validation—not general Git state. Keep destructive confirmations modal. |
| UI-28 | Standardize icon actions and dashboard counts | TODO | Use Astryx `IconButton` with meaningful labels/tooltips for genuinely icon-only controls. Replace custom count chips with Astryx `Badge` only for counts. Project guidance explicitly reserves Badge for counts; use `StatusDot`/`Token`/text for status rather than status badges. |
| UI-29 | Assess TreeList for changed-file browsing | TODO | Consider `TreeList` with file/folder icons for a hierarchical changed-file sidebar or genuinely hierarchical file listings. Do not tree-render flat `ls`/tool output; keep those results as concise text. |

**Astryx component viability audit** (source locations are current integration points, not a commitment to replace each one):

| Suggestion | Fit | Current integration point and recommendation |
|---|---|---|
| `ChatComposer` | Good, with behavior wiring | `apps/web/src/components/TicketPanel.tsx` composer near the Live footer. Supports controlled draft, submit, stop and status slots; preserve queued/running guidance, Human Request, Shift+Enter and delivery behavior. |
| `Badge` | Good for counts; not statuses here | `TaskBoard.tsx`, `BoardSidebar.tsx`, `QueuePanel.tsx` use custom `CountBadge` or status text. Could replace count chips; project rule says Badge is for counts only, so don't use it for task statuses. |
| `Banner` / `FieldStatus` | Banner good for persistent state; FieldStatus is not | `TicketPanel.tsx` Changes to review, Git statuses, and error banners; `ToastContext.tsx` handles transient notices. Persistent uncheckpointed changes fit Banner; checkpoint success is usually a Toast. FieldStatus belongs to form validation. |
| `IconButton — With Tooltips` | Good for icon-only actions | `AddIconButton.tsx`, `DeleteIcon.tsx`, `BoardSidebar.tsx`, `TaskBoard.tsx`, `TicketPanel.tsx`, `ProfileMenu.tsx`. Standardize labels/tooltips, but don't convert visible text actions to icons just for compactness. |
| `Popover` / `BottomSheet` | Conditional fit for action selection, not safety gates | `TicketPanel.tsx` review-actions currently crowds many Git actions. A responsive action menu can group them; BottomSheet is the mobile alternative. Keep checkpoint/merge previews and explicit confirmation flows. `Popover — Confirm Action` is only appropriate for simple, low-risk inline confirmation, not merge/checkpoint workflows or destructive deletes. |
| `MetadataListItem` | Good, keep compact | `TicketPanel.tsx` header is already outside the scrolling panel body. Add concise description, optional worktree path and created time; the task schema has `worktree_path` and `created_at`, not a separate `cwd` field. |
| `SideNav` | Poor fit for current information architecture | `BoardSidebar.tsx` primarily selects a board project filter; Astryx SideNav is for page destinations and explicitly not for filtering. Keep the current sidebar unless the app grows real destinations. |
| `ProgressBar — Indeterminate` | Good | `TicketPanel.tsx` already tracks `compactionActive` and uses a custom shimmer. Replace with labeled indeterminate progress; this is genuinely ongoing work. |
| `TabList` | Good | `TicketPanel.tsx` custom Live/Runs tabs are a direct controlled-tab fit; use `role="tablist"`/panel IDs and preserve count/selection behavior. |
| `TreeList — File Tree With Icons` | Conditional | `TicketPanel.tsx` changed-file lists/diff selectors and future UI-10 sidebar are candidates only when paths are grouped hierarchically. Flat command output stays text. |
| `Markdown` | Good for assistant transcript | `TicketPanel.tsx` currently renders assistant text and reasoning as plain text. Use Astryx Markdown for streamed assistant responses, with a CodeBlock override for fenced code; verify streaming and preserved plain-text line breaks. |
| `Code — Highlighted` | Partial fit for edits | The template uses CodeBlock `highlightLines` to emphasize one color of lines. It does not itself provide paired red/green old/new rendering. For edited snippets, use two labeled before/after blocks with changed-line highlights, plus a narrowly scoped red/green diff treatment if exact semantic colors are required. |

**Styling decision:** do not migrate to Tailwind. The project guidance explicitly says there is no Tailwind/StyleX compiler and requires Astryx components/tokens; the current web app has a large custom `apps/web/src/app.css` and no Tailwind dependency/config. Prefer incremental replacement of bespoke controls with Astryx components and theme/token-based CSS, not a styling-system rewrite.

**Suggested order:** UI-18/22 (minimal summaries), UI-21 (edit diffs), UI-20 (one Agent label per assistant turn), UI-23 (assistant Markdown), UI-24 (composer), UI-25 (tabs/progress), UI-26 (header metadata), UI-27 (Git actions/status surfaces), UI-28 (icon actions/count badges), UI-29 only if hierarchical changed-file browsing is needed, then UI-08 browser acceptance. UI-09–13 remain as listed. Verify `details.patch`/`details.diff` survive persisted history before wiring edit previews; do not add `write` diffs without preimage capture.

## Project-local Pi extension setup and future resource configuration

The user requested project-scoped extension loading before the remaining UI work is complete. The current implementation deliberately uses a fixed, repository-owned extension allowlist rather than a user-editable capability selector.

| ID | Work | Status | Acceptance / notes |
|---|---|---|---|
| RES-01 | Port and document Kanban-repo todo extension | DONE | Copied the installed todo-list extension into the Kanban repository's `.pi/extensions/pi-todo-list/index.ts` and documented loader scope and startup commands in `PI-EXTENSIONS.md`. |
| RES-02 | Define the Kanban extension allowlist | DONE | `.pi/extensions/package.json` is the source allowlist. The server resolves only the Kanban repository's `.pi/extensions` path and passes it with `noExtensions: true`; it retains the global Pi agent directory for credentials/settings but excludes global and task-project extensions. |
| RES-03 | Verify extension isolation | DONE | Server integration test confirms the allowlisted repo todo extension loads while global settings extensions and task-project extensions do not. Extensions still run with server-process permissions; the allowlist is not a sandbox. |

### Current resource-loading facts for the future setup

- The server creates each task session with Pi `DefaultResourceLoader`, passing the task worktree as `cwd` and `getAgentDir()` as the Pi agent directory (`PI_CODING_AGENT_DIR` overrides the default `~/.pi/agent`).
- `createKanbanResourceLoader()` sets `noExtensions: true` and explicitly adds `<Kanban repository>/.pi/extensions`, resolved from the server module path rather than the task `cwd`; its `package.json` is the allowlist. Global and task-project extension settings are not loaded as extensions.
- Pi's global agent directory remains in use for credentials and ordinary Pi settings; do not repoint it at the project merely to isolate extensions.
- Ship `.pi/extensions` alongside the Kanban server package. Task worktrees do not need copies of the extension sources. Restart the Kanban server after edits.
- Extensions execute with server-process permissions. Project-local loading and the manifest allowlist are not a sandbox.

## Out of scope here

Phase 13 end-to-end hardening remains tracked in the implementation plan. Do not treat this Phase 12 tracker as an acceptance report for Phase 13.
