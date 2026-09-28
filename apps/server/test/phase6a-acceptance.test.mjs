import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { openDatabase } from "../dist/db.js";
import { AgentManager } from "../dist/agents/agent-manager.js";
import { registerLiveEventRoutes } from "../dist/agents/live-event-routes.js";
import { registerRunRoutes } from "../dist/agents/run-routes.js";
import { RunManager } from "../dist/agents/run-manager.js";
import { QueueManager } from "../dist/queue/queue-manager.js";
import { registerQueueRoutes } from "../dist/queue/queue-routes.js";

const waitFor = async (check) => {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for the two-ticket acceptance flow.");
};

function collectUntil(socket, predicate) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => reject(new Error("Timed out waiting for a Live event.")), 5000);
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      events.push(event);
      if (predicate(event)) {
        clearTimeout(timer);
        resolve(events);
      }
    });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

class ControlledSession {
  constructor(manager, tools, taskId) {
    this.sessionId = manager.getSessionId();
    this.sessionFile = manager.getSessionFile();
    this.sessionManager = manager;
    this.tools = tools;
    this.taskId = taskId;
    this.handlers = new Set();
    this.started = false;
    this.disposed = false;
  }

  subscribe(handler) { this.handlers.add(handler); return () => this.handlers.delete(handler); }

  prompt(text) {
    this.started = true;
    this.appendUser(text);
    this.emitDelta(`started:${this.taskId}`);
    return new Promise((resolve, reject) => { this.finishPrompt = async () => {
      try {
        await this.tools[0].execute("handover-call", {
          stage: "INVESTIGATION",
          summary: `Completed ${this.taskId}`,
          confidence: "HIGH",
          outcome: `Outcome for ${this.taskId}`,
          recommended_next_step: "CLOSE",
        }, undefined, undefined, {});
        this.appendAssistant(`completed:${this.taskId}`);
        resolve();
      } catch (error) { reject(error); }
    }; });
  }

  async steer(text) { this.appendUser(text); }
  async abort() { this.finishPrompt?.(); }
  dispose() { this.disposed = true; }

  emitDelta(text) {
    for (const handler of this.handlers) {
      handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
    }
  }

  appendUser(text) {
    const message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
    for (const handler of this.handlers) handler({ type: "message_start", message });
    for (const handler of this.handlers) handler({ type: "message_end", message });
    this.sessionManager.appendMessage(message);
  }

  appendAssistant(text) {
    const message = {
      role: "assistant", content: [{ type: "text", text }], provider: "acceptance", model: "fake",
      api: "openai-completions", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop",
    };
    for (const handler of this.handlers) handler({ type: "message_start", message });
    for (const handler of this.handlers) handler({ type: "message_end", message });
    this.sessionManager.appendMessage(message);
  }
}

test("two concurrent tickets survive refresh, reconnect, steering, and completion without cross-talk", async (t) => {
  const db = openDatabase(":memory:");
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-phase6a-acceptance-"));
  const now = new Date().toISOString();
  for (const taskId of ["ticket-1", "ticket-2"]) {
    db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(`project-${taskId}`, taskId, join(tmpdir(), taskId), now, now);
    db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
      VALUES (?, ?, ?, '', 'TODO', ?, ?)`).run(taskId, `project-${taskId}`, taskId, now, now);
  }

  const sessions = new Map();
  const agents = new AgentManager(db, sessionDir, async (cwd, manager, tools) => {
    const taskId = cwd.endsWith("ticket-1") ? "ticket-1" : "ticket-2";
    const session = new ControlledSession(manager, tools, taskId);
    sessions.set(taskId, session);
    return session;
  });
  const runs = new RunManager(db, agents);
  const queue = new QueueManager(db, runs, 2);
  queue.initialize();
  const app = Fastify();
  let sockets = [];
  await registerLiveEventRoutes(app, db, agents);
  registerQueueRoutes(app, queue);
  registerRunRoutes(app, runs);
  await app.ready();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
    agents.dispose("ticket-1");
    agents.dispose("ticket-2");
    db.close();
    rmSync(sessionDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const starts = await Promise.all(["ticket-1", "ticket-2"].map((taskId) => app.inject({
    method: "POST", url: `/api/tasks/${taskId}/queue`,
    payload: { task_id: taskId, stage: "INVESTIGATION", prompt: `Investigate ${taskId}`, idempotency_key: `start-${taskId}` },
  })));
  assert.deepEqual(starts.map((response) => response.statusCode), [201, 201]);
  const runIds = Object.fromEntries(starts.map((response, index) => [["ticket-1", "ticket-2"][index], response.json().run_id]));
  await waitFor(() => sessions.size === 2 && [...sessions.values()].every((session) => session.started));

  const socket1 = await app.injectWS(`/api/tasks/ticket-1/runs/${runIds["ticket-1"]}/events`);
  const socket2 = await app.injectWS(`/api/tasks/ticket-2/runs/${runIds["ticket-2"]}/events`);
  sockets.push(socket1, socket2);
  const [firstEvents, secondEvents] = await Promise.all([
    collectUntil(socket1, (event) => event.type === "message_update" && event.data.delta === "started:ticket-1"),
    collectUntil(socket2, (event) => event.type === "message_update" && event.data.delta === "started:ticket-2"),
  ]);
  assert.ok(firstEvents.every((event) => event.taskId === "ticket-1" && event.runId === runIds["ticket-1"]));
  assert.ok(secondEvents.every((event) => event.taskId === "ticket-2" && event.runId === runIds["ticket-2"]));
  assert.ok(firstEvents.every((event) => !JSON.stringify(event).includes("ticket-2")));
  assert.ok(secondEvents.every((event) => !JSON.stringify(event).includes("ticket-1")));

  const cursors = [firstEvents.at(-1).sequence, secondEvents.at(-1).sequence];
  socket1.terminate();
  socket2.terminate();
  sessions.get("ticket-1").emitDelta("while-disconnected:ticket-1");
  sessions.get("ticket-2").emitDelta("while-disconnected:ticket-2");
  const resumed1 = await app.injectWS(`/api/tasks/ticket-1/runs/${runIds["ticket-1"]}/events?after=${cursors[0]}`);
  const resumed2 = await app.injectWS(`/api/tasks/ticket-2/runs/${runIds["ticket-2"]}/events?after=${cursors[1]}`);
  sockets.push(resumed1, resumed2);
  const [replayed1, replayed2] = await Promise.all([
    collectUntil(resumed1, (event) => event.data.delta === "while-disconnected:ticket-1"),
    collectUntil(resumed2, (event) => event.data.delta === "while-disconnected:ticket-2"),
  ]);
  assert.deepEqual(replayed1.map((event) => event.data.delta), ["while-disconnected:ticket-1"]);
  assert.deepEqual(replayed2.map((event) => event.data.delta), ["while-disconnected:ticket-2"]);

  for (const taskId of ["ticket-1", "ticket-2"]) {
    const response = await app.inject({
      method: "POST", url: `/api/runs/${runIds[taskId]}/inputs`,
      payload: { input_id: `steer-${taskId}`, text: `Steering for ${taskId}` },
    });
    assert.equal(response.statusCode, 201);
  }
  await waitFor(() => ["ticket-1", "ticket-2"].every((taskId) =>
    db.prepare("SELECT delivery_status FROM run_inputs WHERE id = ?").get(`steer-${taskId}`)?.delivery_status === "DELIVERED"));

  // A refreshed panel reloads the durable transcript for each task from the history endpoint.
  const [history1, history2] = await Promise.all(["ticket-1", "ticket-2"].map((taskId) =>
    app.inject({ method: "GET", url: `/api/tasks/${taskId}/live/history` })));
  assert.equal(history1.statusCode, 200);
  assert.equal(history2.statusCode, 200);
  for (const [taskId, history] of [["ticket-1", history1.json()], ["ticket-2", history2.json()]]) {
    const texts = history.entries.map((entry) => entry.message.content?.map((part) => part.text ?? "").join("") ?? "");
    assert.ok(texts.some((text) => text.includes(`Investigate ${taskId}`)));
    assert.ok(texts.includes(`Steering for ${taskId}`));
    assert.ok(texts.every((text) => !text.includes(taskId === "ticket-1" ? "ticket-2" : "ticket-1")));
    assert.equal(history.active_run_id, runIds[taskId]);
  }

  await Promise.all(["ticket-1", "ticket-2"].map((taskId) => sessions.get(taskId).finishPrompt()));
  await waitFor(() => ["ticket-1", "ticket-2"].every((taskId) =>
    db.prepare("SELECT status FROM task_runs WHERE id = ?").get(runIds[taskId]).status === "COMPLETED"));
  assert.deepEqual(["ticket-1", "ticket-2"].map((taskId) =>
    db.prepare("SELECT workflow_state FROM tasks WHERE id = ?").get(taskId).workflow_state), ["REVIEW", "REVIEW"]);
  for (const taskId of ["ticket-1", "ticket-2"]) {
    const row = db.prepare("SELECT delivery_status, transcript_entry_id FROM run_inputs WHERE id = ?").get(`steer-${taskId}`);
    assert.equal(row.delivery_status, "DELIVERED");
    assert.ok(row.transcript_entry_id);
  }
});
