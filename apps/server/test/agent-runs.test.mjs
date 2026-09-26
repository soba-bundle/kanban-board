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
import { registerRunRoutes } from "../dist/agents/run-routes.js";
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
    db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
      VALUES (?, 'task-1', 'INVESTIGATION', ?, 'QUEUED')`).run(id, id === "run-1" ? 1 : 2);
  }
  const createdSessions = [];
  const createAgentManager = () => new AgentManager(db, sessionDir, async (_cwd, manager) => {
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
  return { db, agents, createAgentManager, createdSessions };
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
  const { db, agents, createAgentManager, createdSessions } = makeFixture(sessionDir);
  t.after(() => { agents.dispose("task-1"); db.close(); rmSync(sessionDir, { recursive: true, force: true }); });
  const runs = new RunManager(db, agents);

  await runs.start("run-1", "investigate");
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = 'run-1'").get().status === "COMPLETED");
  await runs.start("run-2", "implement");
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = 'run-2'").get().status === "COMPLETED");

  assert.equal(createdSessions.length, 1);
  assert.deepEqual(createdSessions[0].prompts, ["investigate", "implement"]);
  const sessionId = createdSessions[0].sessionId;
  assert.ok(createdSessions[0].sessionFile);
  assert.ok(existsSync(createdSessions[0].sessionFile));
  assert.equal(db.prepare("SELECT working_session_id FROM tasks WHERE id = 'task-1'").get().working_session_id, sessionId);
  assert.equal(db.prepare("SELECT session_id FROM task_runs WHERE id = 'run-2'").get().session_id, sessionId);

  agents.dispose("task-1");
  const restoredAgents = createAgentManager();
  await new RunManager(db, restoredAgents).start("run-3", "continue");
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = 'run-3'").get().status !== "RUNNING");
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'run-3'").get().status, "COMPLETED", db.prepare("SELECT error_message FROM task_runs WHERE id = 'run-3'").get().error_message);
  assert.equal(createdSessions.length, 2);
  assert.equal(createdSessions[1].sessionId, sessionId);
  assert.deepEqual(createdSessions[1].prompts, ["continue"]);
  restoredAgents.dispose("task-1");
});

test("run WebSocket receives normalized live events from its task session", async (t) => {
  const { db, agents } = makeFixture();
  const app = Fastify();
  const runs = new RunManager(db, agents);
  await registerLiveEventRoutes(app, db, agents);
  registerRunRoutes(app, runs);
  t.after(async () => { await app.close(); agents.dispose("task-1"); db.close(); });

  await app.ready();
  const socket = await app.injectWS("/api/runs/run-1/events");
  const received = new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())));
    socket.once("error", reject);
  });
  const response = await app.inject({ method: "POST", url: "/api/runs/run-1/start", payload: { prompt: "hello" } });
  assert.equal(response.statusCode, 202);
  const event = await received;

  assert.equal(event.taskId, "task-1");
  assert.equal(event.runId, "run-1");
  assert.equal(event.type, "message_update");
  assert.equal(event.data.delta, "hello");
  socket.terminate();
});
