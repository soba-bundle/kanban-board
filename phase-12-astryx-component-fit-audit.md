# Astryx Component Fit Audit — Kanban Frontend

**Status:** Planning note; no implementation implied.  
**Scope:** Evaluate proposed Astryx components against the current UI and its safety/interaction needs.  
**Reviewed:** 2026-10-05

| Component / example | Fit | Current integration point | Recommendation / caveat |
|---|---|---|---|
| **ChatComposer** | Good, with behavior wiring | `apps/web/src/components/TicketPanel.tsx` — Live composer near the panel footer | Replace the custom textarea/send row only if controlled draft, start-run, running/queued guidance, Human Request disabled state, Shift+Enter and delivery/recovery status remain correct. |
| **Badge** | Good for counts; not statuses in this project | `apps/web/src/components/TaskBoard.tsx`, `BoardSidebar.tsx`, `QueuePanel.tsx`; custom `CountBadge` | Could replace custom count chips. Project guidance reserves Badge for counts; use `StatusDot`, `Token` or text for status labels. |
| **Banner** | Good for persistent, actionable state | `TicketPanel.tsx` — Changes to review, Git state and current error messaging | Consider a persistent Banner for uncheckpointed changes or actionable Git state. Use Toast for brief success rather than keeping a success banner mounted. |
| **FieldStatus** | Poor fit for Git notices | Forms such as project/task dialogs, if field validation needs standardization | FieldStatus is for form-field validation feedback, not general Git or run status. |
| **IconButton — With Tooltips** | Good for genuinely icon-only controls | `AddIconButton.tsx`, `DeleteIcon.tsx`, `BoardSidebar.tsx`, `TaskBoard.tsx`, `TicketPanel.tsx`, `ProfileMenu.tsx` | Use explicit accessible labels and visible tooltips. Keep text on actions whose meaning is not immediately obvious. |
| **Popover** | Conditional fit for action selection | `TicketPanel.tsx` — `review-actions` action cluster | Could group secondary Git actions and reduce panel clutter. Keep checkpoint/merge previews and existing mutation safety gates outside the menu. |
| **Popover — Bottom Sheet Alternative / BottomSheet** | Good responsive alternative for a compact action menu | Same Git-action cluster in `TicketPanel.tsx` | BottomSheet is intended for touch/narrow surfaces. Consider an adaptive menu/sheet only after the desktop action grouping is clear; do not split information users need to compare. |
| **Popover — Confirm Action** | Limited fit | Existing dialogs in `TicketPanel.tsx`, `App.tsx`, `ConfirmDialog.tsx`, `DangerConfirmDialog.tsx` | Suitable only for a simple inline confirmation. Preserve modal confirmation and preview flows for checkpoint, sync/merge and destructive delete operations. |
| **MetadataList / MetadataListItem** | Good if kept compact | `TicketPanel.tsx` — pinned `.ticket-panel-header`; task schema in `packages/shared/src/index.ts` | Add short description, working directory (`task.worktree_path`, when present) and created time (`task.created_at`). There is no separate task `cwd` field. Avoid making the pinned header too tall. |
| **SideNav** | Poor fit for current information architecture | `apps/web/src/components/BoardSidebar.tsx` | Current sidebar mainly selects a project filter, not a destination. SideNav is for page navigation and Astryx guidance says not to use it for filtering. Revisit only if the app gains real destinations. |
| **ProgressBar — Indeterminate** | Good | `TicketPanel.tsx` — `compactionActive` and current CSS shimmer | Replace the bespoke compaction shimmer with a labeled indeterminate progress indicator; retain completion/error feedback and reduced-motion accessibility. |
| **TabList / Tab** | Good | `TicketPanel.tsx` — custom Live/Runs tabs | Use controlled tabs with tab-panel IDs and preserve the run count and selected view. |
| **TreeList — File Tree With Icons** | Conditional | `TicketPanel.tsx` — changed-file review lists; potential UI-10 changed-file sidebar; `live-tool-result.tsx` | Use only when paths are grouped hierarchically. Do not render flat `ls` or stdout as a tree. |
| **Markdown** | Good for assistant transcript | `TicketPanel.tsx` — assistant text and reasoning currently render as plain text | Use for assistant responses, preserving streamed updates and meaningful line breaks. Consider Markdown's code component override for consistent fenced-code rendering. Reasoning can remain plain unless Markdown improves it. |
| **Code — Highlighted** (`CodeBlockHighlightedLines`) | Partial fit for edit diffs | `apps/web/src/live-tool-result.tsx`; Astryx `CodeBlock` in expanded tool details | `highlightLines` provides generic highlighted lines, not distinct red/green old/new line styles. Paired before/after snippets can use separate blocks; true semantic red/green diff styling needs a small, narrowly scoped diff renderer/style hook. |

## Specific Live-result decisions

- Todo operations only: render one concise, readable status summary; no raw JSON or per-call result dropdown.
- Other non-edit tool calls, including orphan results: preserve the full result content in the result disclosure. Shell output is scrollable; non-shell output preserves line breaks. Keep structured result details separately expandable. Edit calls use their dedicated before/after preview instead.
- Successful Pi `edit` calls: Pi returns `details.diff`, `details.patch`, and `firstChangedLine`; its call arguments include the requested `oldText`/`newText`. Confirm these details survive the application's persisted history before rendering them.
- Compact edit call: pass additions/deletions statistics to Astryx `ChatToolCalls` to show `+N −N`.
- Expanded edit call: show labeled before/after edited snippets; removed lines red, added lines green. The CodeBlock highlighted-lines example alone does not supply two semantic colors.
- Pi `write` results do not include a preimage/diff. Never infer or fabricate an overwrite diff; retain the task-level Changes to review view as authoritative.

## Styling recommendation

Do not migrate to Tailwind for this project: project guidance says there is no Tailwind/StyleX compiler and requires Astryx components and theme tokens. Prefer incremental replacement of custom controls and token-based CSS in `apps/web/src/app.css`; avoid a broad styling-system rewrite.

## Suggested order

1. Todo-only one-line summaries; full result content for other tools; per-call edit diff summary/expanded snippets. Verify and test persisted result details.
2. One Agent label per assistant turn; Markdown for streamed assistant replies.
3. ChatComposer; TabList and compaction ProgressBar.
4. Compact pinned task metadata; Git action grouping and persistent status notices.
5. IconButton tooltips and count Badge adoption; TreeList only if hierarchical file browsing is needed.
6. Browser acceptance after the interaction changes.
