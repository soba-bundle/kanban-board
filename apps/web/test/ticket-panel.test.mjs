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
    server: { middlewareMode: true },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { TicketPanel, LiveMessageCard } = await vite.ssrLoadModule("/src/components/TicketPanel.tsx");
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
  }));
  assert.match(messageCard, /Delivered/);
  assert.match(messageCard, /reasoning details/);
  assert.match(messageCard, /Tool calls/);
  assert.match(messageCard, /local · coder · in 14 · out 7 tokens/);
});

test("the task board renders legacy Validation readiness tags as ordinary work completion", async (t) => {
  const vite = await createServer({
    root: webRoot,
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { middlewareMode: true },
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
    server: { middlewareMode: true },
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
