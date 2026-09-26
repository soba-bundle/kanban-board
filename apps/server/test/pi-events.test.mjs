import assert from "node:assert/strict";
import test from "node:test";
import { normalizePiEvent } from "../dist/agents/pi-events.js";

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
