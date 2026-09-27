import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBashTool } from "@earendil-works/pi-coding-agent";

if (process.platform !== "win32") throw new Error("This smoke test must run on Windows.");

const workerPath = fileURLToPath(new URL("./process-tree-worker.mjs", import.meta.url));
const tempDir = await mkdtemp(join(tmpdir(), "kanban-stop-tree-"));
const stateFile = join(tempDir, "pids.jsonl");
const controller = new AbortController();
const bashTool = createBashTool(process.cwd());
const command = `"${process.execPath}" "${workerPath}" root "${stateFile}"`;
const execution = bashTool.execute("windows-process-tree-smoke", { command, timeout: 30_000 }, controller.signal, () => {});

async function getProcesses() {
  try {
    return (await readFile(stateFile, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitFor(condition, description) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

try {
  await waitFor(async () => (await getProcesses()).length === 3, "nested child processes");
  const processes = await getProcesses();
  const root = processes.find((item) => item.role === "root");
  const compiler = processes.find((item) => item.role === "compiler");
  const testRunner = processes.find((item) => item.role === "test-runner");
  assert(root && compiler && testRunner);
  assert.equal(compiler.ppid, root.pid);
  assert.equal(testRunner.ppid, compiler.pid);

  controller.abort();
  await assert.rejects(execution, /abort/i);
  await waitFor(async () => processes.every(({ pid }) => !isAlive(pid)), "all owned descendant processes to exit");
  console.log(`[PASS] Windows Pi Bash abort terminated the owned process tree: ${processes.map(({ role, pid }) => `${role}=${pid}`).join(" ")}`);
} finally {
  if (!controller.signal.aborted) controller.abort();
  await execution.catch(() => {});
  await rm(tempDir, { recursive: true, force: true });
}
