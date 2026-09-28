import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { openDatabase } from "../dist/db.js";
import { AgentManager } from "../dist/agents/agent-manager.js";
import { RunManager } from "../dist/agents/run-manager.js";
import { registerLiveEventRoutes } from "../dist/agents/live-event-routes.js";

function makeFixture(t, replayLimit) {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', 'Details', 'IN_PROGRESS', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, handover_json)
    VALUES ('run-1', 'task-1', 'INVESTIGATION', 1, 'QUEUED', '{"stage":"INVESTIGATION"}')`).run();

  let session;
  const agents = new AgentManager(db, "/tmp/replay-test", async (_cwd, manager) => {
    session = {
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
      handlers: [],
      subscribe(handler) { session.handlers.push(handler); return () => {}; },
      promptStarted: false,
      prompt: () => new Promise((resolve) => {
        session.promptStarted = true;
        session.finishPrompt = resolve;
      }),
      steer: async () => {},
      abort: async () => { session.finishPrompt?.(); },
      dispose() {},
      emitDelta(text) {
        for (const handler of session.handlers) {
          handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
        }
      },
    };
    return session;
  }, replayLimit);
  const runs = new RunManager(db, agents);
  t.after(() => { agents.dispose("task-1"); db.close(); });
  return { db, agents, runs, getSession: () => session };
}

async function startApp(t, db, agents) {
  const app = Fastify();
  await registerLiveEventRoutes(app, db, agents);
  await app.ready();
  t.after(async () => { await app.close(); });
  return app;
}

async function waitFor(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out.");
}

function collect(socket, count) {
  const events = [];
  return new Promise((resolve, reject) => {
    socket.on("message", (data) => {
      events.push(JSON.parse(data.toString()));
      if (events.length >= count) resolve(events);
    });
    socket.on("error", reject);
  });
}

test("joining Live mid-run replays earlier output before streaming new events", async (t) => {
  const { db, agents, runs, getSession } = makeFixture(t);
  const app = await startApp(t, db, agents);
  void runs.start("run-1", { text: "investigate", commentIds: [] });
  await waitFor(() => getSession()?.promptStarted === true);

  // Output produced before anyone is watching.
  getSession().emitDelta("first ");
  getSession().emitDelta("second ");

  const socket = await app.injectWS("/api/tasks/task-1/runs/run-1/events");
  const incoming = collect(socket, 3);
  getSession().emitDelta("third");
  const events = await incoming;

  assert.deepEqual(events.map((event) => event.data.delta), ["first ", "second ", "third"]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  assert.deepEqual(events.map((event) => event.eventId), ["run-1:1", "run-1:2", "run-1:3"]);
  assert.deepEqual([...new Set(events.map((event) => event.runId))], ["run-1"]);
  socket.terminate();
  getSession().finishPrompt();
});

test("reconnect replays only events after the supplied sequence cursor", async (t) => {
  const { db, agents, runs, getSession } = makeFixture(t);
  const app = await startApp(t, db, agents);
  void runs.start("run-1", { text: "investigate", commentIds: [] });
  await waitFor(() => getSession()?.promptStarted === true);
  getSession().emitDelta("one");
  getSession().emitDelta("two");
  getSession().emitDelta("three");

  const socket = await app.injectWS("/api/tasks/task-1/runs/run-1/events?after=2");
  const events = await collect(socket, 1);
  assert.deepEqual(events.map((event) => [event.sequence, event.data.delta]), [[3, "three"]]);
  socket.terminate();
  getSession().finishPrompt();
});

test("an expired replay cursor signals a gap and sends the bounded tail", async (t) => {
  const { db, agents, runs, getSession } = makeFixture(t, 2);
  const app = await startApp(t, db, agents);
  void runs.start("run-1", { text: "investigate", commentIds: [] });
  await waitFor(() => getSession()?.promptStarted === true);
  for (const text of ["a", "b", "c", "d"]) getSession().emitDelta(text);

  const socket = await app.injectWS("/api/tasks/task-1/runs/run-1/events?after=0");
  const events = await collect(socket, 3);
  assert.equal(events[0].type, "replay_gap");
  assert.deepEqual(events.slice(1).map((event) => [event.sequence, event.data.delta]), [[3, "c"], [4, "d"]]);
  socket.terminate();
  getSession().finishPrompt();
});

test("a run socket receives only events scoped to its task and run", async (t) => {
  const { db, agents } = makeFixture(t);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-2', 'project-1', 'Other Task', '', 'IN_PROGRESS', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('run-2', 'task-2', 'INVESTIGATION', 1, 'RUNNING')`).run();
  const app = await startApp(t, db, agents);
  const socket1 = await app.injectWS("/api/tasks/task-1/runs/run-1/events");
  const socket2 = await app.injectWS("/api/tasks/task-2/runs/run-2/events");
  const event1 = collect(socket1, 1);
  const event2 = collect(socket2, 1);
  agents.publish("task-1", "run-1", "test_event", { value: "one" });
  agents.publish("task-2", "run-2", "test_event", { value: "two" });
  const [received1, received2] = await Promise.all([event1, event2]);
  assert.deepEqual(received1.map((event) => [event.taskId, event.runId, event.data.value]), [["task-1", "run-1", "one"]]);
  assert.deepEqual(received2.map((event) => [event.taskId, event.runId, event.data.value]), [["task-2", "run-2", "two"]]);
  socket1.terminate();
  socket2.terminate();
});

test("replay is bounded and dropped once the run finishes", async (t) => {
  const { agents, runs, getSession, db } = makeFixture(t, 3);
  void runs.start("run-1", { text: "investigate", commentIds: [] });
  await waitFor(() => getSession()?.promptStarted === true);

  for (const text of ["a", "b", "c", "d", "e"]) getSession().emitDelta(text);
  // Oldest events are discarded rather than growing without bound.
  assert.deepEqual(agents.replay("run-1").map((event) => event.data.delta), ["c", "d", "e"]);

  getSession().finishPrompt();
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = 'run-1'").get().status === "COMPLETED");
  assert.deepEqual(agents.replay("run-1"), []);
});

test("replay for an unknown run is empty rather than an error", (t) => {
  const { agents } = makeFixture(t);
  assert.deepEqual(agents.replay("nope"), []);
});
