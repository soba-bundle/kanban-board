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

  const socket = await app.injectWS("/api/runs/run-1/events");
  const incoming = collect(socket, 3);
  getSession().emitDelta("third");
  const events = await incoming;

  assert.deepEqual(events.map((event) => event.data.delta), ["first ", "second ", "third"]);
  assert.deepEqual([...new Set(events.map((event) => event.runId))], ["run-1"]);
  socket.terminate();
  getSession().finishPrompt();
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
