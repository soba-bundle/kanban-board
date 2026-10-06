import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("assistant responses use ghost bubbles without sender labels; user messages stay filled and Markdown stays safe", async (t) => {
  const vite = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { middlewareMode: true, hmr: false }, appType: "custom",
  });
  t.after(() => vite.close());
  const { LiveMessageCard } = await vite.ssrLoadModule("/src/components/TicketPanel.tsx");
  const entry = (id, role = "assistant") => ({
    id, entry_id: id, role, run_id: "run-1", session_id: "session-1", timestamp: "2026-01-01T00:00:00Z",
    message: { content: "**Answer**\nSecond line\n\n- item\n\n```ts\nconst x = 1;\n```\n\n[unsafe](javascript:alert(1))\n<script>alert(1)</script>" },
  });
  const assistant = renderToStaticMarkup(createElement(LiveMessageCard, { entry: entry("a") }));
  assert.match(assistant, /data-variant="ghost"/);
  assert.doesNotMatch(assistant, /live-message-header|>Agent</);
  assert.doesNotMatch(assistant, /href="javascript:|<script>/);
  assert.match(assistant, /<strong[^>]*>Answer<\/strong>/);
  assert.match(assistant, /<br/);
  assert.match(assistant, /<li/);
  assert.match(assistant, /const/);

  const user = renderToStaticMarkup(createElement(LiveMessageCard, { entry: entry("u", "user") }));
  assert.match(user, /data-variant="filled"/);
  assert.doesNotMatch(user, /live-message-header|>You</);
  assert.match(user, /\*\*Answer\*\*/);
});
