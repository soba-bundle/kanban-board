import { createAgentSession, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createKanbanResourceLoader } from "../pi/resource-loader.js";
import { createValidationReportTool } from "./validation-report-tool.js";
import { createStageToolPolicy, installStageToolCallGuard } from "../pi/stage-tool-policy.js";
import type { ValidationReport } from "@kanban-board/shared";

export interface ValidationSessionOptions {
  cwd: string;
  sessionDir: string;
  agentDir: string;
  stage: "VALIDATION_REVIEW";
  onReport?: (report: ValidationReport) => void | Promise<void>;
}

export async function createValidationSession(options: ValidationSessionOptions): Promise<AgentSession> {
  const { agentDir, settingsManager, resourceLoader } = createKanbanResourceLoader(options.cwd, options.agentDir);
  await resourceLoader.reload();
  const customTools = options.onReport ? [createValidationReportTool(options.onReport)] : [];
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.create(options.cwd, options.sessionDir),
    customTools,
  });
  const policy = createStageToolPolicy(() => options.stage);
  session.setActiveToolsByName(policy.filterActiveTools(session.getActiveToolNames()));
  installStageToolCallGuard(session.agent, policy);
  return session;
}
