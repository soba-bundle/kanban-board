import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

const kanbanExtensionRoot = fileURLToPath(new URL("../../../../.pi/extensions", import.meta.url));
const kanbanAgentDir = fileURLToPath(new URL("../../../../.pi/agent", import.meta.url));

export function createKanbanResourceLoader(cwd: string, agentDir = kanbanAgentDir) {
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [kanbanExtensionRoot],
    noExtensions: true,
  });
  return { agentDir, settingsManager, resourceLoader };
}
