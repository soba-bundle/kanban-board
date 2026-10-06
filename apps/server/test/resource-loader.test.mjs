import assert from "node:assert/strict";
import test from "node:test";
import { createKanbanResourceLoader } from "../dist/pi/resource-loader.js";

test("Kanban appends its repo-owned system prompt through Pi's resource loader", async () => {
  const { resourceLoader } = createKanbanResourceLoader(process.cwd());
  await resourceLoader.reload();
  assert.ok(resourceLoader.getAppendSystemPrompt().some((prompt) =>
    prompt.includes("Kanban Markdown rendering guidance") && prompt.includes("outer fence longer than any fence inside it")));
});
