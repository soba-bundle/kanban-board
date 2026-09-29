import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { AgentManager } from "../dist/agents/agent-manager.js";
import { registerLiveEventRoutes } from "../dist/agents/live-event-routes.js";
import { RunManager } from "../dist/agents/run-manager.js";
import { QueueManager } from "../dist/queue/queue-manager.js";
import { registerQueueRoutes } from "../dist/queue/queue-routes.js";
import { openDatabase } from "../dist/db.js";

class FakeSession {
  constructor(sessionManager) {
    this.sessionId = sessionManager.getSessionId();
    this.sessionFile = sessionManager.getSessionFile();
    this.listeners = new Set();
    this.prompts = [];
  }

  subscribe(handler) { this.listeners.add(handler); return () => this.listeners.delete(handler); }
  async prompt(text) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.prompts.push(text);
    for (const handler of this.listeners) {
      handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
    }
  }
  async steer() {}
  abort() {}
  dispose() {}
}

function makeFixture(sessionDir) {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', '', 'IN_PROGRESS', ?, ?)`).run(now, now);
  for (const id of ["run-1", "run-2", "run-3"]) {
    // Pre-seeded handover: this fixture exercises session reuse, not handover enforcement.
    db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, handover_json)
      VALUES (?, 'task-1', 'INVESTIGATION', ?, 'QUEUED', '{"stage":"INVESTIGATION"}')`)
      .run(id, id === "run-1" ? 1 : 2);
  }
  const createdSessions = [];
  const customToolsSeen = [];
  const createAgentManager = () => new AgentManager(db, sessionDir, async (_cwd, manager, customTools) => {
    customToolsSeen.push(customTools);
    const sessionFile = manager.getSessionFile();
    if (sessionFile && !existsSync(sessionFile)) {
      manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
      manager.appendMessage({
        role: "assistant", content: [{ type: "text", text: "seed" }], provider: "test", model: "test",
        api: "openai-completions", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop",
      });
    }
    const session = new FakeSession(manager);
    createdSessions.push(session);
    return session;
  });
  const agents = createAgentManager();
  return { db, agents, createAgentManager, createdSessions, customToolsSeen };
}

async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for run completion.");
}

test("successive runs reuse the persisted task session", async (t) => {
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-agent-test-"));
  const { db, agents, createAgentManager, createdSessions, customToolsSeen } = makeFixture(sessionDir);
  t.after(() => { agents.dispose("task-1"); db.close(); rmSync(sessionDir, { recursive: true, force: true }); });
  const runs = new RunManager(db, agents);

  await runs.start("run-1", { text: "investigate", inputIds: [] });
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = 'run-1'").get().status === "COMPLETED");
  await runs.start("run-2", { text: "implement", inputIds: [] });
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = 'run-2'").get().status === "COMPLETED");

  assert.equal(createdSessions.length, 1);
  assert.deepEqual(createdSessions[0].prompts, ["investigate", "implement"]);
  assert.deepEqual(customToolsSeen.map((tools) => tools.map((tool) => tool.name)), [["submit_handover"]]);
  const sessionId = createdSessions[0].sessionId;
  assert.ok(createdSessions[0].sessionFile);
  assert.ok(existsSync(createdSessions[0].sessionFile));
  assert.equal(db.prepare("SELECT working_session_id FROM tasks WHERE id = 'task-1'").get().working_session_id, sessionId);
  assert.equal(db.prepare("SELECT session_id FROM task_runs WHERE id = 'run-2'").get().session_id, sessionId);

  agents.dispose("task-1");
  const restoredAgents = createAgentManager();
  await new RunManager(db, restoredAgents).start("run-3", { text: "continue", inputIds: [] });
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = 'run-3'").get().status !== "RUNNING");
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'run-3'").get().status, "COMPLETED", db.prepare("SELECT error_message FROM task_runs WHERE id = 'run-3'").get().error_message);
  assert.equal(createdSessions.length, 2);
  assert.equal(createdSessions[1].sessionId, sessionId);
  assert.deepEqual(createdSessions[1].prompts, ["continue"]);
  // submit_handover is re-registered on restored sessions too.
  assert.deepEqual(customToolsSeen.map((tools) => tools.map((tool) => tool.name)),
    [["submit_handover"], ["submit_handover"]]);
  restoredAgents.dispose("task-1");
});

test("run WebSocket receives normalized live events from its task session", async (t) => {
  const { db, agents } = makeFixture();
  db.prepare("UPDATE tasks SET workflow_state = 'TODO' WHERE id = 'task-1'").run();
  const app = Fastify();
  const queue = new QueueManager(db, new RunManager(db, agents));
  queue.initialize();
  await registerLiveEventRoutes(app, db, agents);
  registerQueueRoutes(app, queue);
  let socket;
  t.after(async () => { socket?.terminate(); await app.close(); agents.dispose("task-1"); db.close(); });

  await app.ready();
  const response = await app.inject({ method: "POST", url: "/api/tasks/task-1/queue", payload: {
    task_id: "task-1", stage: "INVESTIGATION", prompt: "Investigate the issue", idempotency_key: "start-run-1",
  } });
  assert.equal(response.statusCode, 201);
  const runId = response.json().run_id;
  socket = await app.injectWS(`/api/tasks/task-1/runs/${runId}/events`);
  const received = new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())));
    socket.once("error", reject);
  });
  const event = await received;

  assert.equal(event.taskId, "task-1");
  assert.equal(event.runId, runId);
  assert.equal(event.type, "message_update");
  assert.match(event.data.delta, /^Investigate this task/);
  socket.terminate();
  // This run never submits a handover, so let the retry/failure path settle before teardown.
  await waitFor(() => !["QUEUED", "RUNNING"].includes(
    db.prepare("SELECT status FROM task_runs WHERE id = ?").get(runId).status));
});
