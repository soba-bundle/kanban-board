import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("read tool results show a non-expandable line count instead of file contents", async (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const vite = await createServer({
    root, configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { middlewareMode: true, hmr: false }, appType: "custom",
  });
  t.after(() => vite.close());
  const { LiveMessageCard } = await vite.ssrLoadModule("/src/components/TicketPanel.tsx");
  const html = renderToStaticMarkup(createElement(LiveMessageCard, {
    entry: {
      id: "assistant-entry", entry_id: "assistant-entry", role: "assistant", run_id: "run-1",
      session_id: "session-1", timestamp: "2026-01-01T00:00:00Z",
      message: { content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "large.txt" } }] },
    },
    toolCalls: [
      { name: "read", status: "complete", target: "large.txt", data: { resultContent: "first\nsecond\nthird\n" } },
      { name: "bash", status: "complete", target: "npm test" },
    ],
  }));
  assert.match(html, /3 lines read/);
  assert.match(html, /aria-expanded="true"/);
  assert.doesNotMatch(html, /first|second|third/);
});
