import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { applyKanbanSettings, loadKanbanConfig } from "../dist/kanban-config.js";

function withConfig(t, value) {
  const dir = mkdtempSync(join(tmpdir(), "kanban-config-test-"));
  const path = join(dir, "kanban.config.json");
  writeFileSync(path, JSON.stringify(value));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path;
}

test("the tracked root config supplies the bounded retry default", () => {
  assert.deepEqual(loadKanbanConfig(), { inference: { maxRetries: 3 } });
});

test("the single Kanban config loads retry count", (t) => {
  const config = loadKanbanConfig(withConfig(t, { inference: { maxRetries: 2 } }));
  assert.deepEqual(config, { inference: { maxRetries: 2 } });
});

test("Kanban config rejects invalid retry counts", (t) => {
  for (const inference of [{ maxRetries: -1 }, { maxRetries: 1.5 }, { maxRetries: "3" }]) {
    assert.throws(() => loadKanbanConfig(withConfig(t, { inference })), /maxRetries/i);
  }
});

test("SDK settings override retries and compaction in memory while preserving native reserves", () => {
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false, maxRetries: 9 },
    compaction: { enabled: false, reserveTokens: 1234, keepRecentTokens: 5678 },
  });
  applyKanbanSettings(settingsManager, { inference: { maxRetries: 2 } });
  assert.deepEqual(settingsManager.getRetrySettings(), {
    enabled: true, maxRetries: 2, baseDelayMs: 2000,
  });
  assert.deepEqual(settingsManager.getCompactionSettings(), {
    enabled: true, reserveTokens: 1234, keepRecentTokens: 5678,
  });
});

test("zero configured retries disables SDK retries", () => {
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 8 } });
  applyKanbanSettings(settingsManager, { inference: { maxRetries: 0 } });
  assert.deepEqual(settingsManager.getRetrySettings(), {
    enabled: false, maxRetries: 0, baseDelayMs: 2000,
  });
});

test("Kanban enables native compaction while preserving Pi reserve and keep-recent settings", () => {
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: 4321, keepRecentTokens: 8765 },
  });
  applyKanbanSettings(settingsManager, { inference: { maxRetries: 3 } });
  assert.deepEqual(settingsManager.getCompactionSettings(), {
    enabled: true, reserveTokens: 4321, keepRecentTokens: 8765,
  });
});
