import type { ReactNode } from "react";
import type { ChatToolCallItem } from "@astryxdesign/core/Chat";

type ToolResultData = { resultContent?: unknown; resultDetails?: unknown };
const terminalLikeTools = new Set(["bash", "powershell", "read", "grep", "find", "ls"]);

export function liveToolResult(call: ChatToolCallItem): ReactNode | undefined {
  const data = call.data as ToolResultData | undefined;
  const content = typeof data?.resultContent === "string" ? data.resultContent : "";
  const details = data?.resultDetails;
  if (!content && details === undefined) return undefined;
  const serializedDetails = details === undefined ? "" : JSON.stringify(details, null, 2) ?? String(details);

  return (
    <section className="live-tool-result">
      {content && (terminalLikeTools.has(call.name)
        ? <pre className="live-tool-output">{content}</pre>
        : <p className="live-tool-result-text">{content}</p>)}
      {serializedDetails && <details className="live-tool-structured-details">
        <summary>Structured details</summary><pre>{serializedDetails}</pre>
      </details>}
    </section>
  );
}
