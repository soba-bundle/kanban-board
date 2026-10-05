import type { ReactNode } from "react";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Text } from "@astryxdesign/core/Text";
import type { ChatToolCallItem } from "@astryxdesign/core/Chat";

type ToolResultData = { resultContent?: unknown; resultDetails?: unknown; arguments?: unknown };
type EditOperation = { oldText: string; newText: string };

function editOperations(value: unknown): EditOperation[] {
  if (typeof value !== "object" || value === null) return [];
  const args = value as Record<string, unknown>;
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    return [{ oldText: args.oldText, newText: args.newText }];
  }
  if (!Array.isArray(args.edits)) return [];
  return args.edits.filter((edit): edit is EditOperation => typeof edit === "object" && edit !== null &&
    typeof (edit as EditOperation).oldText === "string" && typeof (edit as EditOperation).newText === "string");
}

function editDiff(call: ChatToolCallItem, data: ToolResultData): ReactNode | undefined {
  const details = data.resultDetails;
  if (call.name !== "edit" || call.status === "error" || typeof details !== "object" || details === null ||
    typeof (details as { patch?: unknown }).patch !== "string") return undefined;
  const edits = editOperations(data.arguments);
  if (edits.length === 0) return undefined;

  return edits.map((edit, index) => (
    <section className="live-edit-diff" key={index}>
      <section className="live-edit-diff-before">
        <Text type="label" className="live-edit-diff-label">Before</Text>
        <CodeBlock code={edit.oldText} language="plaintext" hasLanguageLabel={false} hasCopyButton={false} size="sm" width="100%" container="section" />
      </section>
      <section className="live-edit-diff-after">
        <Text type="label" className="live-edit-diff-label">After</Text>
        <CodeBlock code={edit.newText} language="plaintext" hasLanguageLabel={false} hasCopyButton={false} size="sm" width="100%" container="section" />
      </section>
    </section>
  ));
}

export function todoToolSummary(content: string, isError = false): string {
  const firstLine = content.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return "";
  const summary = firstLine.length > 240 ? `${firstLine.slice(0, 239).trimEnd()}…` : firstLine;
  return isError ? `Error: ${summary}` : `✓ ${summary}`;
}

function fullResultContent(name: string, content: string): ReactNode | undefined {
  if (!content) return undefined;
  return name === "bash" || name === "powershell"
    ? <pre className="live-tool-output">{content}</pre>
    : <Text type="supporting" className="live-tool-result-text">{content}</Text>;
}

function structuredDetails(details: unknown): ReactNode | undefined {
  if (details === undefined || details === null) return undefined;
  return <details className="live-tool-structured-details">
    <summary>Structured details</summary>
    <pre>{JSON.stringify(details, null, 2)}</pre>
  </details>;
}

function fullToolResult(name: string, content: string, details?: unknown): ReactNode | undefined {
  const output = fullResultContent(name, content);
  const structured = structuredDetails(details);
  if (output === undefined && structured === undefined) return undefined;
  return <section className="live-tool-result">{output}{structured}</section>;
}

export function liveOrphanToolResult(name: string, content: string, details: unknown, isError = false): ReactNode | undefined {
  if (name === "todo") {
    const summary = todoToolSummary(content, isError);
    return summary ? <Text type="supporting" maxLines={1} hasTruncateTooltip={false} className="live-tool-result-summary">{summary}</Text> : undefined;
  }
  return fullToolResult(name, content, details);
}

export function liveToolResult(call: ChatToolCallItem): ReactNode | undefined {
  const data = call.data as ToolResultData | undefined;
  const content = typeof data?.resultContent === "string" ? data.resultContent : "";
  if (call.name === "todo") {
    const summary = todoToolSummary(content, call.status === "error");
    return summary ? <Text type="supporting" maxLines={1} hasTruncateTooltip={false} className="live-tool-result-summary">{summary}</Text> : undefined;
  }
  const diff = data ? editDiff(call, data) : undefined;
  const fullResult = fullToolResult(call.name, content, data?.resultDetails);
  if (diff !== undefined) return <section className="live-tool-result">{diff}{fullResultContent(call.name, content)}</section>;
  return fullResult;
}
