import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

export interface KanbanConfig {
  inference: { maxRetries: number };
}

const defaultConfigPath = fileURLToPath(new URL("../../../kanban.config.json", import.meta.url));
const defaultMaxRetries = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadKanbanConfig(path = defaultConfigPath): KanbanConfig {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("Kanban config must be a JSON object.");
  if (parsed.inference !== undefined && !isRecord(parsed.inference)) {
    throw new Error("Kanban config inference must be an object.");
  }
  const inference = parsed.inference ?? {};
  const maxRetries = isRecord(inference) ? inference.maxRetries ?? defaultMaxRetries : defaultMaxRetries;
  if (!Number.isSafeInteger(maxRetries) || (maxRetries as number) < 0) {
    throw new Error("Kanban config inference.maxRetries must be a non-negative safe integer.");
  }
  return { inference: { maxRetries: maxRetries as number } };
}

export function applyKanbanSettings(settingsManager: SettingsManager, config: KanbanConfig): void {
  settingsManager.applyOverrides({
    retry: {
      enabled: config.inference.maxRetries > 0,
      maxRetries: config.inference.maxRetries,
    },
    compaction: { enabled: true },
  });
}
