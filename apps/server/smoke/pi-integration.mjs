import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../dist/agents/agent-manager.js";
import { registerLiveEventRoutes } from "../dist/agents/live-event-routes.js";
import { registerRunRoutes } from "../dist/agents/run-routes.js";
import { RunManager } from "../dist/agents/run-manager.js";
import { QueueManager } from "../dist/queue/queue-manager.js";
import { registerQueueRoutes } from "../dist/queue/queue-routes.js";
import { openDatabase } from "../dist/db.js";

const marker = "maple-914";
const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), "kanban-pi-smoke-"));
const db = openDatabase(join(temp, "smoke.sqlite"));
const sessionDir = join(temp, "sessions");
const timeoutMs = 120_000;
let agents;

function createAgentManager() {
  return new AgentManager(db, sessionDir, async (cwd, sessionManager, customTools) => {
    const { session } = await createAgentSession({ cwd, sessionManager, customTools, noTools: "builtin" });
    return session;
  });
}

function withTimeout(promise, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

function seedDatabase() {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('smoke-project', 'Pi smoke test', ?, ?, ?)`).run(root, now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('smoke-task', 'smoke-project', 'Pi session smoke test', '', 'IN_PROGRESS', ?, ?)`).run(now, now);
  const insertRun = db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES (?, 'smoke-task', ?, ?, 'QUEUED')`);
  insertRun.run("smoke-investigation-1", "INVESTIGATION", 1);
  insertRun.run("smoke-implementation-1", "IMPLEMENTATION", 2);
  insertRun.run("smoke-investigation-2", "INVESTIGATION", 3);
  insertRun.run("smoke-restore", "INVESTIGATION", 4);
}

function readAssistantText(sessionFile) {
  return readFileSync(sessionFile, "utf8").trim().split(/\r?\n/).flatMap((line) => {
    const entry = JSON.parse(line);
    if (entry.type !== "message" || entry.message?.role !== "assistant") return [];
    return [entry.message.content?.filter((part) => part.type === "text").map((part) => part.text).join("") ?? ""];
  });
}

async function waitForRun(runId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = db.prepare("SELECT status, error_message FROM task_runs WHERE id = ?").get(runId);
    if (run.status === "COMPLETED") return;
    if (run.status === "FAILED") throw new Error(`Run ${runId} failed: ${run.error_message}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for run ${runId}.`);
}

async function verifyRepeatedSessionAndRestore() {
  agents = createAgentManager();
  const runs = new RunManager(db, agents);
  const prompts = [
    ["smoke-investigation-1", `Remember this exact marker for our smoke test: ${marker}. Reply only "Remembered."`],
    ["smoke-implementation-1", "What exact marker did I ask you to remember? Reply with only the marker."],
    ["smoke-investigation-2", "Repeat the exact marker from our earlier exchange. Reply with only the marker."],
  ];
  let expectedSessionId;
  let expectedSessionFile;
  for (const [runId, prompt] of prompts) {
    await runs.start(runId, { text: prompt, commentIds: [], inputIds: [] });
    await waitForRun(runId);
    const run = db.prepare("SELECT session_id, session_file FROM task_runs WHERE id = ?").get(runId);
    expectedSessionId ??= run.session_id;
    expectedSessionFile ??= run.session_file;
    assert.equal(run.session_id, expectedSessionId, "runs should reuse one working session ID");
    assert.equal(run.session_file, expectedSessionFile, "runs should reuse one working session file");
  }
  assert.ok(readAssistantText(expectedSessionFile).some((text) => text.trim() === marker), "working session should retain the marker");
  agents.dispose("smoke-task");

  agents = createAgentManager();
  await new RunManager(db, agents).start("smoke-restore", {
    text: "After restarting, what exact marker did I ask you to remember? Reply with only the marker.",
    commentIds: [], inputIds: [],
  });
  await waitForRun("smoke-restore");
  const restoredRun = db.prepare("SELECT session_id, session_file FROM task_runs WHERE id = 'smoke-restore'").get();
  assert.equal(restoredRun.session_id, expectedSessionId, "restored session should keep the same ID");
  assert.equal(restoredRun.session_file, expectedSessionFile, "restored session should keep the same file");
  assert.ok(readAssistantText(expectedSessionFile).some((text) => text.trim() === marker), "restored session should recall prior context");
  const history = agents.historySnapshot("smoke-task");
  assert.ok(history.entries.some((entry) => entry.message.content?.some((part) => part.text?.includes(marker))),
    "restored Live history should reconstruct the real Pi transcript");
  assert.ok(history.entries.some((entry) => entry.run_id === "smoke-restore"),
    "reconstructed transcript entries should retain run ownership");
  console.log("PASS successive runs and fresh-manager restore reused one persistent session and reconstructed Live history");
}

async function verifyWebSocketSteeringAndAbort() {
  db.prepare(`UPDATE tasks SET workflow_state = 'TODO', description = ? WHERE id = 'smoke-task'`)
    .run("Write a long explanation (about 700 words) of why persistent working sessions are useful.");
  const app = Fastify();
  const runs = new RunManager(db, agents);
  const queue = new QueueManager(db, runs);
  queue.initialize();
  await registerLiveEventRoutes(app, db, agents);
  registerQueueRoutes(app, queue);
  registerRunRoutes(app, runs);
  await app.ready();
  const socketEvents = [];

  let runId;
  let steering;
  const steeringInputId = "smoke-steering-input";
  const steeringText = "Steering smoke instruction: after your current response, reply exactly STEERING_RECEIVED.";
  const response = await app.inject({
    method: "POST",
    url: "/api/tasks/smoke-task/queue",
    payload: {
      task_id: "smoke-task", stage: "IMPLEMENTATION", prompt: "Explain why persistent working sessions are useful.",
      idempotency_key: "smoke-websocket-start",
    },
  });
  assert.equal(response.statusCode, 201);
  runId = response.json().run_id;
  const unsubscribe = agents.subscribe("smoke-task", runId, (event) => {
    if (!steering && event.type === "message_update" && event.data.subtype === "text_delta") {
      steering = runs.steer(runId, steeringInputId, steeringText);
    }
  });
  const socket = await app.injectWS(`/api/tasks/smoke-task/runs/${runId}/events`);
  socket.on("message", (data) => socketEvents.push(JSON.parse(data.toString())));
  await waitForRun(runId);
  await steering;
  const inputDeadline = Date.now() + timeoutMs;
  while (Date.now() < inputDeadline && db.prepare("SELECT delivery_status FROM run_inputs WHERE id = ?")
    .get(steeringInputId)?.delivery_status !== "DELIVERED") await new Promise((resolve) => setTimeout(resolve, 100));
  const steeringInput = db.prepare("SELECT delivery_status, transcript_entry_id FROM run_inputs WHERE id = ?")
    .get(steeringInputId);
  assert.equal(steeringInput?.delivery_status, "DELIVERED");
  assert.ok(steeringInput.transcript_entry_id, "steering should correlate to a unique Pi transcript entry");
  const refreshedHistory = await app.inject({ method: "GET", url: "/api/tasks/smoke-task/live/history" });
  assert.equal(refreshedHistory.statusCode, 200);
  assert.ok(refreshedHistory.json().entries.some((entry) =>
    entry.entry_id === steeringInput.transcript_entry_id && entry.run_id === runId),
  "refreshed history should expose the delivered steering entry under its run");
  unsubscribe();
  socket.terminate();
  await app.close();

  assert.ok(socketEvents.some((event) => event.type === "message_update" && event.data.subtype === "text_delta"), "WebSocket should deliver Pi text deltas");
  assert.ok(socketEvents.some((event) => event.type === "message_end"), "WebSocket should deliver completed Pi messages");
  const sessionFile = db.prepare("SELECT working_session_file FROM tasks WHERE id = 'smoke-task'").get().working_session_file;
  assert.ok(readFileSync(sessionFile, "utf8").includes(steeringText), "accepted steering should appear in session history");
  console.log("PASS real Pi events arrived through the run WebSocket and steering was delivered");

  let abortIssued = false;
  let abortSettled = false;
  let abortError;
  const unsubscribeAbort = agents.subscribe("smoke-task", "smoke-abort", (event) => {
    if (!abortIssued && event.type === "message_update" && event.data.subtype === "text_delta") {
      abortIssued = true;
      void agents.abort("smoke-task").catch((error) => { abortError = error; });
    }
    if (event.type === "agent_settled") abortSettled = true;
  });
  await withTimeout(
    agents.prompt("smoke-task", "smoke-abort", "Write a long, detailed guide to organizing software projects into sections."),
    "Abort prompt timed out.",
  );
  unsubscribeAbort();
  assert.ok(abortIssued, "abort should be requested during streamed generation");
  assert.ok(abortSettled, "Pi should report the aborted turn settled");
  assert.equal(abortError, undefined, "Pi abort should complete successfully");
  console.log("PASS abort during real Pi streaming settles the working session");
}

try {
  seedDatabase();
  await verifyRepeatedSessionAndRestore();
  await verifyWebSocketSteeringAndAbort();
} finally {
  agents?.dispose("smoke-task");
  db.close();
  rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
