import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Kanban deliberately delegates summarization to Pi. Guard the installed SDK's native
// prompt contract so a Pi dependency update that changes it gets reviewed explicitly.
const sdkCompactionPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js",
);
const { DEFAULT_COMPACTION_SETTINGS, generateSummaryWithUsage, shouldCompact } = await import(pathToFileURL(sdkCompactionPath).href);

const model = {
  provider: "test-provider", id: "test-model", api: "openai-completions",
  name: "Test model", contextWindow: 32_000, maxTokens: 4_096, reasoning: false,
};
const retryDisabled = { enabled: false, maxRetries: 0, baseDelayMs: 2_000 };
const result = {
  content: [{ type: "text", text: "Structured continuation summary." }],
  usage: { input: 20, output: 10 }, stopReason: "stop",
};

async function captureSummaryPrompt(messages, previousSummary) {
  let captured;
  const streamFn = async (_model, context) => {
    captured = context.messages[0].content[0].text;
    return { result: async () => result };
  };
  const summary = await generateSummaryWithUsage(
    messages, model, 16_384, undefined, undefined, undefined, undefined,
    previousSummary, undefined, streamFn, undefined, retryDisabled, undefined, "test-session",
  );
  assert.equal(summary.text, "Structured continuation summary.");
  return captured;
}

test("Pi's native summary prompt retains task context and its structured continuation sections", async () => {
  const messages = [
    { role: "user", timestamp: 1, content: [{ type: "text", text: "Goal: add bounded retries. Constraint: never duplicate a prompt." }] },
    { role: "assistant", timestamp: 2, content: [{ type: "text", text: "Changed apps/server/src/agents/run-manager.ts; retries remain in progress." }] },
  ];
  const prompt = await captureSummaryPrompt(messages);
  for (const section of ["## Goal", "## Constraints & Preferences", "## Progress", "## Key Decisions", "## Next Steps", "## Critical Context"]) {
    assert.ok(prompt.includes(section), `native Pi prompt must include ${section}`);
  }
  assert.match(prompt, /Goal: add bounded retries/);
  assert.match(prompt, /never duplicate a prompt/);
  assert.match(prompt, /apps\/server\/src\/agents\/run-manager\.ts/);
  assert.match(prompt, /retries remain in progress/);
});

test("Pi's native reserve threshold starts compaction strictly above its default boundary", () => {
  const contextWindow = 100_000;
  const settings = { ...DEFAULT_COMPACTION_SETTINGS };
  const threshold = contextWindow - settings.reserveTokens;
  assert.equal(shouldCompact(threshold, contextWindow, settings), false);
  assert.equal(shouldCompact(threshold + 1, contextWindow, settings), true);
});

test("Pi's native update-summary prompt carries the previous checkpoint forward", async () => {
  const previousSummary = "## Goal\nPreserve the user's retry requirements.\n## Critical Context\nExact path: apps/server/src/agents/run-manager.ts";
  const messages = [{
    role: "user", timestamp: 3,
    content: [{ type: "text", text: "The retry implementation is now complete; run the regression tests." }],
  }];
  const prompt = await captureSummaryPrompt(messages, previousSummary);
  assert.match(prompt, /<previous-summary>/);
  assert.match(prompt, /Preserve the user's retry requirements/);
  assert.match(prompt, /apps\/server\/src\/agents\/run-manager\.ts/);
  assert.match(prompt, /PRESERVE all existing information from the previous summary/);
  assert.match(prompt, /The retry implementation is now complete/);
});
