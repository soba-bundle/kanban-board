import type { ChatToolCallItem } from "@astryxdesign/core/Chat";
import type { LiveHistoryEntry } from "@kanban-board/shared";

type ToolCallPart = { type: "toolCall"; id?: string; name?: string; arguments?: unknown };

export type UnmatchedToolCall = {
  id: string | null;
  name: string;
  arguments: unknown;
  reason: string;
};

export type LiveToolCallAdapter = {
  callsByAssistantEntryId: Map<string, ChatToolCallItem[]>;
  unmatchedByAssistantEntryId: Map<string, UnmatchedToolCall[]>;
  consumedResultEntryIds: Set<string>;
};

function messageParts(entry: LiveHistoryEntry): Array<Record<string, unknown>> {
  const content = entry.message.content;
  return Array.isArray(content) ? content.filter((part): part is Record<string, unknown> =>
    !!part && typeof part === "object") : [];
}

function argumentTarget(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value ?? "");
  const args = value as Record<string, unknown>;
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  return JSON.stringify(args);
}

function resultContent(entry: LiveHistoryEntry): string {
  const content = entry.message.content;
  return typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((part): part is { type: string; text: string } =>
      !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string")
      .map((part) => part.text).join("\n")
    : "";
}

function resultDetails(entry: LiveHistoryEntry): unknown {
  const details = entry.message.details;
  if (details === undefined || details === null ||
    (typeof details === "object" && !Array.isArray(details) && Object.keys(details).length === 0)) return undefined;
  return details;
}

function editDiffStats(details: unknown): { additions: number; deletions: number } | undefined {
  if (typeof details !== "object" || details === null || typeof (details as { patch?: unknown }).patch !== "string") return undefined;
  const lines = (details as { patch: string }).patch.split(/\r?\n/);
  const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  return additions + deletions > 0 ? { additions, deletions } : undefined;
}

export function adaptLiveToolCalls(entries: LiveHistoryEntry[], activeRunId: string | null = null): LiveToolCallAdapter {
  const resultsByCallId = new Map<string, LiveHistoryEntry[]>();
  for (const entry of entries) {
    if (entry.role !== "tool") continue;
    const callId = entry.message.toolCallId;
    if (typeof callId !== "string") continue;
    const matches = resultsByCallId.get(callId) ?? [];
    matches.push(entry);
    resultsByCallId.set(callId, matches);
  }

  const callsByAssistantEntryId = new Map<string, ChatToolCallItem[]>();
  const unmatchedByAssistantEntryId = new Map<string, UnmatchedToolCall[]>();
  const consumedResultEntryIds = new Set<string>();
  const callCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.role !== "assistant") continue;
    for (const part of messageParts(entry)) {
      if (part.type !== "toolCall" || typeof part.id !== "string") continue;
      callCounts.set(part.id, (callCounts.get(part.id) ?? 0) + 1);
    }
  }

  const addUnmatched = (entryId: string, call: ToolCallPart, reason: string) => {
    const calls = unmatchedByAssistantEntryId.get(entryId) ?? [];
    calls.push({ id: call.id ?? null, name: call.name ?? "tool", arguments: call.arguments, reason });
    unmatchedByAssistantEntryId.set(entryId, calls);
  };

  for (const entry of entries) {
    if (entry.role !== "assistant") continue;
    const calls: ChatToolCallItem[] = [];
    for (const rawPart of messageParts(entry).filter((part) => part.type === "toolCall")) {
      const call = rawPart as ToolCallPart;
      const matches = call.id ? resultsByCallId.get(call.id) ?? [] : [];
      const baseCall = {
        key: call.id ?? `${entry.id}:${calls.length}`,
        name: call.name ?? "tool",
        target: argumentTarget(call.arguments),
        data: { callId: call.id, arguments: call.arguments },
      };
      if (!call.id || callCounts.get(call.id) !== 1 || matches.length !== 1) {
        if (call.id && callCounts.get(call.id) === 1 && matches.length === 0 && entry.run_id === activeRunId && activeRunId) {
          calls.push({ ...baseCall, status: "running" });
        } else {
          addUnmatched(entry.id, call, !call.id ? "Call has no ID; cannot match a result." :
            callCounts.get(call.id) !== 1 ? "Multiple tool calls share this ID." :
              matches.length === 0 ? "No tool result is recorded for this call." : "Multiple tool results match this call ID.");
        }
        continue;
      }

      const result = matches[0]!;
      const resultName = result.message.toolName;
      if (typeof resultName === "string" && call.name && resultName !== call.name) {
        addUnmatched(entry.id, call, `Result tool name ${resultName} does not match ${call.name}.`);
        continue;
      }

      const resultMessage = result.message;
      const isError = resultMessage.isError === true;
      const content = resultContent(result);
      const details = resultDetails(result);
      const diffStats = !isError && call.name === "edit" ? editDiffStats(details) : undefined;
      calls.push({
        ...baseCall,
        name: call.name ?? (typeof resultName === "string" ? resultName : "tool"),
        status: isError ? "error" : "complete",
        errorMessage: isError ? content || "Tool returned an error." : undefined,
        ...diffStats,
        data: { callId: call.id, arguments: call.arguments, resultContent: content, resultDetails: details },
      });
      consumedResultEntryIds.add(result.id);
    }
    if (calls.length > 0) callsByAssistantEntryId.set(entry.id, calls);
  }

  return { callsByAssistantEntryId, unmatchedByAssistantEntryId, consumedResultEntryIds };
}
