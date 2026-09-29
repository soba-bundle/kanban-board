import { DefaultResourceLoader, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { resolve, sep } from "node:path";

export function createKanbanResourceLoader(cwd: string) {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const incompatibleExtensionPath = resolve(agentDir, "extensions", "pi-questions");
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionsOverride: (result) => ({
      ...result,
      extensions: result.extensions.filter((extension) => {
        const extensionPath = resolve(extension.path);
        return extensionPath !== incompatibleExtensionPath &&
          !extensionPath.startsWith(`${incompatibleExtensionPath}${sep}`);
      }),
    }),
  });
  return { agentDir, settingsManager, resourceLoader };
}
