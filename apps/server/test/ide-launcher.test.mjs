import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openInIde } from "../dist/ide/ide-launcher.js";

test("IDE launcher passes a spaced path to a Windows command shim", { skip: process.platform !== "win32" }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "kanban-ide-launcher-"));
  t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const executable = join(temp, "fake-ide.cmd");
  const target = join(temp, "project path with spaces");
  const resultFile = join(temp, "received.txt");
  writeFileSync(executable, `@echo off\r\n> "${resultFile}" echo %~1\r\n`);

  await openInIde(executable, target);
  let received;
  for (let i = 0; i < 40; i++) {
    try {
      received = readFileSync(resultFile, "utf8").trim();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.equal(received, target);
});
