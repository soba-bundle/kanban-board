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
  assert.match(markup, /composer-stage-picker/);
  assert.match(markup, /Start run/);

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
