import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface NormalizedPiEvent {
  type: string;
  data: Record<string, unknown>;
}

export function normalizePiEvent(event: AgentSessionEvent): NormalizedPiEvent {
  const source = event as unknown as Record<string, unknown>;
  const data: Record<string, unknown> = {};

  if (event.type === "message_update") {
    const delta = source.assistantMessageEvent as Record<string, unknown> | undefined;
    if (delta) {
      data.subtype = delta.type;
      if (delta.type === "text_delta" || delta.type === "thinking_delta") data.delta = delta.delta;
    }
  } else if (event.type.startsWith("tool_execution_")) {
    data.toolCallId = source.toolCallId;
    data.toolName = source.toolName;
    if (event.type === "tool_execution_start") data.args = source.args;
    if (event.type === "tool_execution_update") {
      data.args = source.args;
      data.partialResult = source.partialResult;
    }
    if (event.type === "tool_execution_end") data.isError = source.isError;
  } else if (event.type === "message_start" || event.type === "message_end" || event.type === "turn_end") {
    const message = source.message as Record<string, unknown> | undefined;
    if (message) {
      data.role = message.role;
      if (message.role === "assistant") {
        data.model = message.model;
        data.provider = message.provider;
        data.stopReason = message.stopReason;
        data.usage = message.usage;
      }
      // User text is surfaced on message_start so steering delivery can be matched.
      const wantsText = event.type === "message_end" || (event.type === "message_start" && message.role === "user");
      if (wantsText && Array.isArray(message.content)) {
        data.text = (message.content as Array<Record<string, unknown>>)
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
      }
    }
  } else if (event.type === "queue_update") {
    data.steeringCount = (source.steering as unknown[] | undefined)?.length ?? 0;
    data.followUpCount = (source.followUp as unknown[] | undefined)?.length ?? 0;
  } else if (event.type === "agent_end") {
    data.willRetry = source.willRetry;
  } else if (event.type === "auto_retry_start") {
    data.attempt = source.attempt;
    data.maxAttempts = source.maxAttempts;
    data.delayMs = source.delayMs;
    data.errorMessage = source.errorMessage;
  } else if (event.type === "auto_retry_end") {
    data.success = source.success;
    data.attempt = source.attempt;
    data.finalError = source.finalError;
  }

  return { type: event.type, data };
}
