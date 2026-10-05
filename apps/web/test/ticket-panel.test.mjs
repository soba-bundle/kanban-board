import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const webRoot = fileURLToPath(new URL("../", import.meta.url));

test("ticket panel opens Live first with task context and no Timeline/comments surface", async (t) => {
  const vite = await createServer({
    root: webRoot,
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { TicketPanel, LiveMessageCard } = await vite.ssrLoadModule("/src/components/TicketPanel.tsx");
  const { adaptLiveToolCalls } = await vite.ssrLoadModule("/src/live-tool-adapter.ts");
  const { liveToolResult } = await vite.ssrLoadModule("/src/live-tool-result.tsx");
  const { HandoverCard } = await vite.ssrLoadModule("/src/components/HandoverCard.tsx");
  const { ToastProvider } = await vite.ssrLoadModule("/src/components/ToastContext.tsx");
  const task = {
    id: "task-1", project_id: "project-1", title: "Improve retries", description: "Avoid duplicate requests.",
    workflow_state: "TODO", review_tag: null, worktree_path: null, working_session_id: null, working_session_file: null,
    base_branch: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const markup = renderToStaticMarkup(createElement(ToastProvider, null,
    createElement(TicketPanel, { task, queue: null, onClose() {}, onChanged() {} })));

  assert.match(markup, /Improve retries/);
  assert.match(markup, /Avoid duplicate requests\./);
  assert.match(markup, /Live/);
  assert.match(markup, /Runs \(0\)/);
  assert.doesNotMatch(markup, /Timeline|Comments/);
  assert.doesNotMatch(markup, /composer-stage-picker|Investigation|Implementation/);
  assert.match(markup, /Start run/);

  const interruptedTaskMarkup = renderToStaticMarkup(createElement(ToastProvider, null,
    createElement(TicketPanel, {
      task: { ...task, workflow_state: "REVIEW", review_tag: "INTERRUPTED" },
      queue: null, onClose() {}, onChanged() {},
    })));
  assert.match(interruptedTaskMarkup, /Enter a prompt to start a run/);
  assert.doesNotMatch(interruptedTaskMarkup, /composer-stage-picker|Investigation|Implementation/);
  assert.match(interruptedTaskMarkup, /Start run/);

  const interruptedCard = renderToStaticMarkup(createElement(HandoverCard, { run: {
    id: "run-1", stage: "INVESTIGATION", sequence: 1, status: "INTERRUPTED", reason_code: "USER_STOPPED",
    error_message: "Run stopped by user.", handover: null,
  } }));
  assert.match(interruptedCard, /Run interrupted before the final handover/);
  assert.match(interruptedCard, /Enter a new prompt in Live to continue/);
  assert.doesNotMatch(interruptedCard, /Initial candidate/);

  const completedCard = renderToStaticMarkup(createElement(HandoverCard, { run: {
    id: "run-2", stage: "INVESTIGATION", sequence: 2, status: "COMPLETED", reason_code: null,
    error_message: null, handover: { summary: "Final handover" },
  } }));
  assert.match(completedCard, /Investigation #2/);
  assert.match(completedCard, /Final handover/);
  const workCard = renderToStaticMarkup(createElement(HandoverCard, { run: {
    id: "run-3", stage: "WORK", sequence: 3, status: "COMPLETED", reason_code: null,
    error_message: null, handover: null,
  } }));
  assert.match(workCard, /Work #3/);
  assert.doesNotMatch(workCard, /No handover recorded|final handover was recorded/i);

  const timestamp = new Date().toISOString();
  const messageCard = renderToStaticMarkup(createElement(LiveMessageCard, {
    entry: {
      id: "session:entry", entry_id: "entry", session_id: "session", run_id: "run-1", timestamp,
      role: "assistant", message: {
        role: "assistant", provider: "local", model: "coder", usage: { input: 14, output: 7 },
        content: [
          { type: "text", text: "Answer" },
          { type: "thinking", thinking: "reasoning details" },
          { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
        ],
      },
    },
    input: {
      id: "input-1", delivery_status: "DELIVERED", failure_reason: null,
    },
    showMetadata: true,
  }));
  assert.match(messageCard, /class="live-message live-message-assistant"/);
  assert.match(messageCard, /Delivered/);
  assert.match(messageCard, /reasoning details/);
  assert.match(messageCard, /local · coder · in 14 · out 7 tokens/);
  assert.match(messageCard, /<footer class="live-message-meta"><time dateTime=/);
  const messageHeader = messageCard.match(/<header[^>]*>.*?<\/header>/s)?.[0] ?? "";
  assert.doesNotMatch(messageHeader, /<time/);

  const userMessageCard = renderToStaticMarkup(createElement(LiveMessageCard, {
    entry: {
      id: "session:user-entry", entry_id: "user-entry", session_id: "session", run_id: "run-1", timestamp,
      role: "user", message: { role: "user", content: "Write a README." },
    },
  }));
  assert.match(userMessageCard, /class="live-message live-message-user"/);
  assert.doesNotMatch(userMessageCard, /<time/);

  const toolOnlyAssistantCard = renderToStaticMarkup(createElement(LiveMessageCard, {
    entry: {
      id: "session:tool-only", entry_id: "tool-only", session_id: "session", run_id: "run-1", timestamp,
      role: "assistant", message: {
        role: "assistant", stopReason: "toolUse",
        content: [{ type: "toolCall", name: "write", arguments: { path: "README.md" } }],
      },
    },
    showMetadata: true,
  }));
  assert.doesNotMatch(toolOnlyAssistantCard, /live-message-meta/);

  const callEntry = {
    id: "session:assistant-tools", entry_id: "assistant-tools", session_id: "session", run_id: "run-1", timestamp,
    role: "assistant", message: { role: "assistant", content: [
      { type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } },
      { type: "toolCall", id: "write-1", name: "write", arguments: { path: "README.md" } },
      { type: "toolCall", id: "missing-1", name: "bash", arguments: { command: "npm test" } },
    ] },
  };
  const readResult = {
    id: "session:read-result", entry_id: "read-result", session_id: "session", run_id: "run-1", timestamp,
    role: "tool", message: { role: "toolResult", toolCallId: "read-1", toolName: "read",
      content: [{ type: "text", text: "README contents" }], details: { source: "workspace" }, isError: false },
  };
  const writeResult = {
    id: "session:write-result", entry_id: "write-result", session_id: "session", run_id: "run-1", timestamp,
    role: "tool", message: { role: "toolResult", toolCallId: "write-1", toolName: "write",
      content: [{ type: "text", text: "Write blocked" }], isError: true },
  };
  const adapter = adaptLiveToolCalls([callEntry, readResult, writeResult]);
  const mappedCalls = adapter.callsByAssistantEntryId.get(callEntry.id) ?? [];
  assert.deepEqual(mappedCalls.map((call) => [call.name, call.status, call.target]), [
    ["read", "complete", "README.md"], ["write", "error", "README.md"],
  ]);
  assert.equal(mappedCalls[0].data.resultContent, "README contents");
  assert.deepEqual(mappedCalls[0].data.resultDetails, { source: "workspace" });
  assert.equal(mappedCalls[1].errorMessage, "Write blocked");
  assert.match(renderToStaticMarkup(liveToolResult(mappedCalls[1])), /Write blocked/);
  assert.deepEqual([...adapter.consumedResultEntryIds], [readResult.id, writeResult.id]);
  assert.equal(adapter.unmatchedByAssistantEntryId.get(callEntry.id)?.[0]?.id, "missing-1");
  const activeAdapter = adaptLiveToolCalls([callEntry, readResult, writeResult], "run-1");
  assert.equal(activeAdapter.callsByAssistantEntryId.get(callEntry.id)?.[2]?.status, "running");
  assert.equal(activeAdapter.unmatchedByAssistantEntryId.has(callEntry.id), false);

  const todoCall = { name: "todo", data: {
    resultContent: "Added todo #1: Inspect the project files.",
    resultDetails: { todos: [{ id: 1, text: "Inspect the project files.", status: "completed" }] },
  } };
  const todoDetail = renderToStaticMarkup(liveToolResult(todoCall));
  assert.match(todoDetail, /Added todo #1: Inspect the project files\./);
  assert.match(todoDetail, /Structured details/);
  assert.match(todoDetail, /<pre>[\s\S]*&quot;status&quot;: &quot;completed&quot;[\s\S]*<\/pre>/);

  const bashDetail = renderToStaticMarkup(liveToolResult({ name: "bash", data: {
    resultContent: "first line\nsecond line", resultDetails: undefined,
  } }));
  assert.match(bashDetail, /<pre class="live-tool-output">first line\nsecond line<\/pre>/);

  const customDetail = renderToStaticMarkup(liveToolResult({ name: "my_extension_tool", data: {
    resultContent: "Completed custom action", resultDetails: undefined,
  } }));
  assert.match(customDetail, /<p class="live-tool-result-text">Completed custom action<\/p>/);

  const adaptedCard = renderToStaticMarkup(createElement(LiveMessageCard, {
    entry: callEntry,
    toolCalls: mappedCalls,
    unmatchedToolCalls: adapter.unmatchedByAssistantEntryId.get(callEntry.id),
  }));
  assert.match(adaptedCard, /read/);
  assert.match(adaptedCard, /write/);
  assert.match(adaptedCard, /class="[^"]*live-tool-calls-grouped/);
  assert.match(adaptedCard, /Unmatched tool calls — review needed/);
  const singleCallCard = renderToStaticMarkup(createElement(LiveMessageCard, {
    entry: callEntry, toolCalls: [mappedCalls[0]], unmatchedToolCalls: [],
  }));
  assert.match(singleCallCard, /class="[^"]*live-tool-calls/);
  assert.doesNotMatch(singleCallCard, /live-tool-calls-grouped/);
});

test("the task board renders legacy Validation readiness tags as ordinary work completion", async (t) => {
  const vite = await createServer({
    root: webRoot,
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { TaskBoard } = await vite.ssrLoadModule("/src/components/TaskBoard.tsx");
  const baseTask = {
    id: "task-1", project_id: "project-1", title: "Validation task", description: "Context",
    workflow_state: "REVIEW", review_tag: "READY_TO_MERGE", active_validation_snapshot_id: "snapshot-1",
    latest_task_commit_sha: "c".repeat(40), validation_snapshot_current: false,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const renderBoard = (task) => renderToStaticMarkup(createElement(TaskBoard, {
    board: { columns: { TODO: [], IN_PROGRESS: [], REQUIRES_HUMAN: [], REVIEW: [task], DONE: [] } },
    queue: null, projects: [], projectId: "all", onStartTask() {}, onOpenTask() {}, onCreateTask() {}, onDeleteTask() {}, onCancelTask() {},
  }));
  const staleMarkup = renderBoard(baseTask);
  assert.match(staleMarkup, /WORK COMPLETE/);
  assert.doesNotMatch(staleMarkup, /READY TO MERGE/);
  const workMarkup = renderBoard({ ...baseTask, review_tag: "WORK_COMPLETE", active_validation_snapshot_id: null });
  assert.match(workMarkup, /WORK COMPLETE/);
  assert.match(workMarkup, /Worker/);
  assert.doesNotMatch(renderBoard({ ...baseTask, validation_snapshot_current: true }), /READY TO MERGE/);
});

test("legacy Validation tags are not rendered as active merge readiness", async (t) => {
  const vite = await createServer({
    root: webRoot,
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { TicketPanel } = await vite.ssrLoadModule("/src/components/TicketPanel.tsx");
  const { ToastProvider } = await vite.ssrLoadModule("/src/components/ToastContext.tsx");
  const staleTask = {
    id: "task-1", project_id: "project-1", title: "Validation task", description: "Context",
    workflow_state: "REVIEW", review_tag: "READY_TO_MERGE", active_validation_snapshot_id: null,
    validation_snapshot_current: false, latest_task_commit_sha: "c".repeat(40),
    worktree_path: "C:/work/task-1", working_session_id: null, working_session_file: null,
    base_branch: "main", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const markup = renderToStaticMarkup(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: staleTask, queue: null, onClose() {}, onChanged() {} })));
  assert.doesNotMatch(markup, /Ready to Merge/i,
    "historical Validation metadata must not be presented as current merge readiness");
  assert.doesNotMatch(markup, /Compact & Continue/i, "automatic compaction must not add a manual choice");
  assert.doesNotMatch(markup, /<button[^>]*>[^<]*Compact/i, "there must be no explicit compact button");
});
