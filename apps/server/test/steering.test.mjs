import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { openDatabase } from "../dist/db.js";
import { AgentManager } from "../dist/agents/agent-manager.js";
import { RunManager } from "../dist/agents/run-manager.js";
import { registerRunRoutes } from "../dist/agents/run-routes.js";

function makeFixture(t, options = {}) {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', 'Details', 'IN_PROGRESS', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('run-1', 'task-1', 'INVESTIGATION', 1, 'QUEUED')`).run();

  let session;
  const agents = new AgentManager(db, "/tmp/steer-test", async (_cwd, manager) => {
    session = {
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
      steered: [],
      handlers: [],
      promptStarted: false,
      subscribe(handler) { session.handlers.push(handler); return () => {}; },
      prompt(text) {
        session.promptStarted = true;
        if (options.promptFails) {
          if (options.emitUserMessageFirst) session.deliver(text);
          return Promise.reject(new Error("inference unavailable"));
        }
        return new Promise((resolve) => { session.finishPrompt = resolve; });
      },
      steer: async (text) => { session.steered.push(text); },
      abort: async () => { session.finishPrompt?.(); },
      dispose() {},
      // Simulate Pi replaying a queued steering message as a user message.
      deliver(text) {
        for (const handler of session.handlers) {
          handler({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
        }
      },
    };
    return session;
  });
  const runs = new RunManager(db, agents);
  const app = Fastify();
  registerRunRoutes(app, runs);
  t.after(async () => { await app.close(); agents.dispose("task-1"); db.close(); });
  return { db, app, runs, agents, getSession: () => session };
}

async function waitFor(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out.");
}

function comments(db) {
  return db.prepare("SELECT * FROM ticket_comments ORDER BY created_at, id").all();
}

test("steering is rejected unless the run is actively running", async (t) => {
  const { app } = makeFixture(t);
  assert.equal((await app.inject({ method: "POST", url: "/api/runs/run-1/steer", payload: { text: "  " } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/runs/missing/steer", payload: { text: "hi" } })).statusCode, 404);
  const queuedRun = await app.inject({ method: "POST", url: "/api/runs/run-1/steer", payload: { text: "too early" } });
  assert.equal(queuedRun.statusCode, 409);
});

test("accepted steering is queued then marked delivered when Pi replays it", async (t) => {
  const { db, app, runs, getSession } = makeFixture(t);
  void runs.start("run-1", { text: "investigate", commentIds: [] });
  await waitFor(() => getSession()?.promptStarted === true);

  const steered = await app.inject({ method: "POST", url: "/api/runs/run-1/steer", payload: { text: " focus on the parser " } });
  assert.equal(steered.statusCode, 201);
  const comment = steered.json();
  assert.equal(comment.content, "focus on the parser");
  assert.equal(comment.delivery_status, "QUEUED");
  assert.equal(comment.delivery_type, "STEERING");
  assert.equal(comment.run_id, "run-1");
  assert.equal(comment.delivered_at, null);
  assert.deepEqual(getSession().steered, ["focus on the parser"]);

  getSession().deliver("focus on the parser");
  const [row] = comments(db);
  assert.equal(row.delivery_status, "DELIVERED");
  assert.equal(row.delivery_type, "STEERING");
  assert.equal(row.delivered_run_id, "run-1");
  assert.equal(row.delivered_session_id, getSession().sessionId);
  assert.ok(row.delivered_at);

  getSession().finishPrompt();
});

test("duplicate steering texts are delivered one at a time in order", async (t) => {
  const { db, app, runs, getSession } = makeFixture(t);
  void runs.start("run-1", { text: "investigate", commentIds: [] });
  await waitFor(() => getSession()?.promptStarted === true);

  await app.inject({ method: "POST", url: "/api/runs/run-1/steer", payload: { text: "same text" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await app.inject({ method: "POST", url: "/api/runs/run-1/steer", payload: { text: "same text" } });
  assert.equal(comments(db).filter((c) => c.delivery_status === "QUEUED").length, 2);

  getSession().deliver("same text");
  const afterFirst = comments(db);
  assert.equal(afterFirst[0].delivery_status, "DELIVERED");
  assert.equal(afterFirst[1].delivery_status, "QUEUED");

  getSession().deliver("same text");
  assert.equal(comments(db).filter((c) => c.delivery_status === "DELIVERED").length, 2);
  getSession().finishPrompt();
});

test("unrelated user messages and stopped runs leave steering queued", async (t) => {
  const { db, app, runs, getSession } = makeFixture(t);
  void runs.start("run-1", { text: "investigate", commentIds: [] });
  await waitFor(() => getSession()?.promptStarted === true);
  await app.inject({ method: "POST", url: "/api/runs/run-1/steer", payload: { text: "never delivered" } });

  getSession().deliver("some other user message");
  assert.equal(comments(db)[0].delivery_status, "QUEUED");

  await runs.stop("run-1");
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = 'run-1'").get().status === "INTERRUPTED");
  // Stranded queued steering: plan section 13.1 covers recovery in Phase 11.
  assert.equal(comments(db)[0].delivery_status, "QUEUED");
  assert.equal((await app.inject({ method: "POST", url: "/api/runs/run-1/steer", payload: { text: "after stop" } })).statusCode, 409);
});

test("comments return to pending when the prompt fails before reaching the model", async (t) => {
  const { db, runs } = makeFixture(t, { promptFails: true });
  db.prepare(`INSERT INTO ticket_comments (id, task_id, author_type, content, delivery_status, created_at)
    VALUES ('c-1', 'task-1', 'USER', 'important context', 'PENDING', ?)`).run(new Date().toISOString());

  await runs.start("run-1", { text: "investigate", commentIds: ["c-1"] });
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = 'run-1'").get().status === "FAILED");

  const row = comments(db)[0];
  assert.equal(row.delivery_status, "PENDING");
  assert.equal(row.delivery_type, null);
  assert.equal(row.delivered_session_id, null);
  assert.equal(row.delivered_run_id, null);
  assert.equal(row.delivered_at, null);
});

test("comments stay delivered when the failure happens after the model saw them", async (t) => {
  const { db, runs, getSession } = makeFixture(t, { promptFails: true, emitUserMessageFirst: true });
  db.prepare(`INSERT INTO ticket_comments (id, task_id, author_type, content, delivery_status, created_at)
    VALUES ('c-1', 'task-1', 'USER', 'already seen', 'PENDING', ?)`).run(new Date().toISOString());

  await runs.start("run-1", { text: "investigate", commentIds: ["c-1"] });
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = 'run-1'").get().status === "FAILED");

  const row = comments(db)[0];
  assert.equal(row.delivery_status, "DELIVERED");
  assert.equal(row.delivery_type, "NEXT_PROMPT");
  assert.equal(row.delivered_session_id, getSession().sessionId);
});

test("live subscribers receive queued and delivered comment events", async (t) => {
  const { app, runs, agents, getSession } = makeFixture(t);
  void runs.start("run-1", { text: "investigate", commentIds: [] });
  await waitFor(() => getSession()?.promptStarted === true);

  const seen = [];
  agents.subscribe("task-1", "run-1", (event) => seen.push(event));
  await app.inject({ method: "POST", url: "/api/runs/run-1/steer", payload: { text: "watch me" } });
  getSession().deliver("watch me");
  await waitFor(() => seen.length === 3);

  // comment_delivered must follow the message_start that caused it.
  assert.deepEqual(seen.map((event) => event.type), ["comment_queued", "message_start", "comment_delivered"]);
  assert.equal(seen[0].data.content, "watch me");
  assert.equal(seen[2].data.commentId, seen[0].data.commentId);
  getSession().finishPrompt();
});
