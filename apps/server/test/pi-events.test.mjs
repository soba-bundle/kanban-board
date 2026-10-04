import assert from "node:assert/strict";
import test from "node:test";
import { normalizePiEvent } from "../dist/agents/pi-events.js";

test("normalizes appended transcript entry identity and user text", () => {
  const result = normalizePiEvent({
    type: "entry_appended",
    entry: { type: "message", id: "entry-7", parentId: "entry-6", message: {
      role: "user", content: [{ type: "text", text: "steering guidance" }],
    } },
  });
  assert.deepEqual(result, {
    type: "entry_appended",
    data: { entryId: "entry-7", parentId: "entry-6", entryType: "message", role: "user", text: "steering guidance" },
  });
});

test("normalizes Pi text deltas without exposing the raw event", () => {
  const normalized = normalizePiEvent({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hello" },
  });

  assert.deepEqual(normalized, {
    type: "message_update",
    data: { subtype: "text_delta", delta: "hello" },
  });
});

test("includes completed assistant text and usage metadata", () => {
  const normalized = normalizePiEvent({
    type: "message_end",
    message: {
      role: "assistant",
      model: "test-model",
      provider: "test-provider",
      stopReason: "stop",
      usage: { input: 2, output: 3 },
      content: [{ type: "text", text: "done" }, { type: "thinking", thinking: "hidden" }],
    },
  });

  assert.equal(normalized.data.text, "done");
  assert.equal(normalized.data.model, "test-model");
  assert.deepEqual(normalized.data.usage, { input: 2, output: 3 });
});

test("preserves tool update arguments and partial results", () => {
  const partialResult = { content: [{ type: "text", text: "Reading file..." }] };
  const normalized = normalizePiEvent({
    type: "tool_execution_update",
    toolCallId: "call-2",
    toolName: "read",
    args: { path: "README.md" },
    partialResult,
  });

  assert.deepEqual(normalized, {
    type: "tool_execution_update",
    data: {
      toolCallId: "call-2",
      toolName: "read",
      args: { path: "README.md" },
      partialResult,
    },
  });
});

test("normalizes compaction lifecycle and keeps the summary separate from assistant output", () => {
  const start = normalizePiEvent({ type: "compaction_start", reason: "threshold" });
  assert.deepEqual(start, { type: "compaction_start", data: { reason: "threshold" } });

  const end = normalizePiEvent({
    type: "compaction_end", reason: "overflow", result: {
      summary: "Sensitive task summary", tokensBefore: 90000, estimatedTokensAfter: 24000,
    }, aborted: false, willRetry: true,
  });
  assert.equal(end.type, "compaction_end");
  assert.equal(end.data.reason, "overflow");
  assert.equal(end.data.aborted, false);
  assert.equal(end.data.willRetry, true);
  assert.equal(end.data.tokensBefore, 90000);
  assert.equal(end.data.estimatedTokensAfter, 24000);
  assert.equal(end.data.summary, "Sensitive task summary", "the UI may show this only in its collapsed compaction disclosure");
  assert.equal(end.data.text, undefined, "compaction summary is not an assistant text delta");
});

test("preserves compaction failure details for the Live panel", () => {
  const end = normalizePiEvent({
    type: "compaction_end", reason: "overflow", result: undefined, aborted: false,
    willRetry: false, errorMessage: "Context overflow recovery failed: summary request exceeded the model context window.",
  });
  assert.equal(end.data.errorMessage, "Context overflow recovery failed: summary request exceeded the model context window.");
  assert.equal(end.data.summary, undefined);
});

test("preserves Pi retry attempt metadata for Live recovery", () => {
  const start = normalizePiEvent({
    type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "HTTP 503",
  });
  assert.deepEqual(start, {
    type: "auto_retry_start",
    data: { attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "HTTP 503" },
  });
  const end = normalizePiEvent({ type: "auto_retry_end", success: true, attempt: 1 });
  assert.deepEqual(end, { type: "auto_retry_end", data: { success: true, attempt: 1, finalError: undefined } });
  assert.equal(normalizePiEvent({ type: "agent_end", willRetry: true }).data.willRetry, true);
});

test("normalizes tool lifecycle identifiers", () => {
  const normalized = normalizePiEvent({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "read",
    isError: false,
  });

  assert.deepEqual(normalized, {
    type: "tool_execution_end",
    data: { toolCallId: "call-1", toolName: "read", isError: false },
  });
});
