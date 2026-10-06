import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const webRoot = fileURLToPath(new URL("../", import.meta.url));

async function loadComponents(t) {
  const vite = await createServer({
    root: webRoot,
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  return {
    ...(await vite.ssrLoadModule("/src/components/TicketPanel.tsx")),
    ...(await vite.ssrLoadModule("/src/components/ToastContext.tsx")),
  };
}

test("ticket title, status, and chevron disclosure use the approved Astryx components", async (t) => {
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const task = {
    id: "task-1", project_id: "project-1", title: "write a simple readme", description: "Review the project overview.",
    workflow_state: "REVIEW", review_tag: "WORK_COMPLETE", worktree_path: null,
    working_session_id: null, working_session_file: null, base_branch: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const markup = renderToStaticMarkup(createElement(ToastProvider, null,
    createElement(TicketPanel, { task, queue: null, onClose() {}, onChanged() {} })));
  const document = new JSDOM(markup).window.document;

  const status = document.querySelector('.ticket-panel-header .astryx-token[data-color="orange"]');
  assert.ok(status);
  assert.equal(status.textContent.trim(), "REVIEW");
  assert.equal(status.querySelector('[role="img"][aria-label="REVIEW"]') !== null, true);
  assert.equal(document.querySelector(".ticket-title-text")?.textContent, "Write a simple readme");
  const detailsTrigger = document.querySelector(".ticket-details-toggle");
  assert.ok(detailsTrigger);
  assert.equal(detailsTrigger.getAttribute("aria-expanded"), "false");
  assert.equal(document.querySelector(".ticket-details-content")?.hasAttribute("hidden"), true);
  assert.equal(document.querySelector(".ticket-panel-header")?.textContent.includes("Details"), false);
  assert.equal(document.querySelector('.ticket-panel-header .astryx-card'), null);
  assert.ok(document.querySelector(".ticket-composer .ticket-chat-composer.astryx-chat-composer"));
  assert.equal(document.querySelector('.ticket-composer-input[placeholder="What should the agent do?"]') !== null, true);
});

test("assistant responses become separate bubbles, with grouped tools in their originating bubble", async (t) => {
  const { LiveMessageCard } = await loadComponents(t);
  const timestamp = new Date().toISOString();
  const first = {
    id: "session:assistant-1", entry_id: "assistant-1", session_id: "session", run_id: "run-1", timestamp,
    role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I inspected the project." }] },
  };
  const second = {
    id: "session:assistant-2", entry_id: "assistant-2", session_id: "session", run_id: "run-1", timestamp,
    role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "The README is ready for review." }] },
  };
  const markup = renderToStaticMarkup(createElement(Fragment, null,
    createElement(LiveMessageCard, {
      key: first.id, entry: first,
      toolCalls: [
        { key: "read-1", name: "read", status: "complete", target: "README.md", stats: "12 lines read" },
        { key: "read-2", name: "read", status: "complete", target: "package.json", stats: "9 lines read" },
      ],
    }),
    createElement(LiveMessageCard, { key: second.id, entry: second }),
  ));
  const document = new JSDOM(markup).window.document;
  const messages = [...document.querySelectorAll(".live-message-assistant")];
  assert.equal(messages.length, 2);
  const firstBubble = messages[0].querySelector(".astryx-chat-message-bubble");
  const secondBubble = messages[1].querySelector(".astryx-chat-message-bubble");
  assert.ok(firstBubble);
  assert.ok(secondBubble);
  assert.match(firstBubble.textContent, /I inspected the project/);
  assert.match(firstBubble.textContent, /2 tool calls/);
  assert.match(firstBubble.textContent, /README\.md/);
  assert.match(firstBubble.textContent, /package\.json/);
  assert.equal(firstBubble.getAttribute("data-variant"), "ghost");
  assert.equal(firstBubble.querySelector('[class*="chat-tool-calls"]') !== null, true);
  assert.match(secondBubble.textContent, /The README is ready for review/);
  assert.equal(messages[0].querySelectorAll(".live-message-header").length, 0);
  assert.equal(messages[1].querySelectorAll(".live-message-header").length, 0);
  assert.equal(messages[1].querySelector(".astryx-chat-message-bubble")?.getAttribute("data-variant"), "ghost");
});

test("user delivery status remains attached to a filled user message without a sender label", async (t) => {
  const { LiveMessageCard } = await loadComponents(t);
  const markup = renderToStaticMarkup(createElement(LiveMessageCard, {
    entry: {
      id: "session:user", entry_id: "user", session_id: "session", run_id: "run-1",
      timestamp: new Date().toISOString(), role: "user", message: { role: "user", content: "Please keep this guidance." },
    },
    input: { delivery_status: "DELIVERED", failure_reason: null },
  }));
  const document = new JSDOM(markup).window.document;
  const message = document.querySelector(".live-message-user");
  assert.ok(message);
  assert.equal(message.querySelector(".astryx-chat-message-bubble")?.getAttribute("data-variant"), "filled");
  assert.equal(message.querySelector(".input-status-delivered")?.textContent, "Delivered");
  assert.equal(message.textContent.includes("You"), false);
});

test("an empty assistant entry does not render an empty chat bubble", async (t) => {
  const { LiveMessageCard } = await loadComponents(t);
  const markup = renderToStaticMarkup(createElement(LiveMessageCard, {
    entry: {
      id: "session:empty", entry_id: "empty", session_id: "session", run_id: "run-1",
      timestamp: new Date().toISOString(), role: "assistant", message: { role: "assistant", content: [] },
    },
  }));
  const document = new JSDOM(markup).window.document;
  assert.equal(document.querySelector(".astryx-chat-message-bubble"), null);
  assert.equal(document.querySelector(".live-message-header"), null);
});
