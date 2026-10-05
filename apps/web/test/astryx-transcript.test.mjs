import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("assistant labels span tool loops, but reset for users, runs and sessions; Markdown stays safe", async (t) => {
  const vite = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { middlewareMode: true, hmr: false }, appType: "custom",
  });
  t.after(() => vite.close());
  const { assistantTurnLabels, LiveMessageCard } = await vite.ssrLoadModule("/src/components/TicketPanel.tsx");
  const entry = (id, role = "assistant", run_id = "run-1", session_id = "session-1") => ({
    id, entry_id: id, role, run_id, session_id, timestamp: "2026-01-01T00:00:00Z",
    message: { content: "**Answer**\nSecond line\n\n- item\n\n```ts\nconst x = 1;\n```\n\n[unsafe](javascript:alert(1))\n<script>alert(1)</script>" },
  });
  const entries = [entry("a"), entry("tool", "tool"), entry("b"), entry("u", "user"), entry("c"), entry("d", "assistant", "run-2"), entry("e", "assistant", "run-2", "session-2")];
  assert.deepEqual([...assistantTurnLabels(entries)], ["a", "c", "d", "e"]);
  const html = renderToStaticMarkup(createElement(LiveMessageCard, { entry: entries[0], showAgentLabel: false }));
  assert.doesNotMatch(html, /live-message-header|href="javascript:|<script>/);
  assert.match(html, /<strong[^>]*>Answer<\/strong>/);
  assert.match(html, /<br/);
  assert.match(html, /<li/);
  assert.match(html, /const/);
  const user = renderToStaticMarkup(createElement(LiveMessageCard, { entry: entry("u", "user") }));
  assert.match(user, /\*\*Answer\*\*/);
});
