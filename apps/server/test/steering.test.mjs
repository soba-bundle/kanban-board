import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { openDatabase } from "../dist/db.js";
import { buildRunPrompt } from "../dist/agents/prompt-builder.js";
import { AgentManager } from "../dist/agents/agent-manager.js";
import { RunManager } from "../dist/agents/run-manager.js";
import { registerRunRoutes } from "../dist/agents/run-routes.js";
import { registerTaskRunRoutes } from "../dist/task-runs.js";

function makeFixture(t) {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', 'Details', 'IN_PROGRESS', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, input_mode)
    VALUES ('run-1', 'task-1', 'WORK', 1, 'QUEUED', 'QUEUED')`).run();

  let session;
  const agents = new AgentManager(db, "/tmp/steer-test", async (_cwd, manager) => {
    session = {
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
      steered: [],
      prompts: [],
      handlers: [],
      promptStarted: false,
      emitPromptEntries: false,
      promptCount: 0,
      subscribe(handler) { session.handlers.push(handler); return () => {}; },
      prompt(text) {
        session.promptStarted = true;
        session.promptCount++;
        session.prompts.push(text);
        if (session.emitPromptEntries) session.deliver(text, `prompt-entry-${session.promptCount}`);
        return new Promise((resolve) => { session.finishPrompt = () => {
          for (const handler of session.handlers) handler({ type: "agent_settled" });
          resolve();
        }; });
      },
      steer: async (text) => { session.steered.push(text); },
      abort: async () => { session.finishPrompt?.(); },
      dispose() {},
      deliver(text, id = `entry-${session.handlers.length}-${session.steered.length}-${Date.now()}`) {
        const entry = {
          type: "message", id, parentId: null, timestamp: new Date().toISOString(),
          message: { role: "user", content: [{ type: "text", text }] },
        };
        for (const handler of session.handlers) {
          handler({ type: "entry_appended", entry });
          handler({ type: "message_start", message: entry.message });
        }
      },
    };
    return session;
  });
  const runs = new RunManager(db, agents);
  const app = Fastify();
  registerRunRoutes(app, runs);
  registerTaskRunRoutes(app, db);
  t.after(async () => { await app.close(); agents.dispose("task-1"); db.close(); });
  return { db, app, runs, getSession: () => session };
}

async function waitFor(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out.");
}

async function send(app, inputId, text, extra = {}) {
  return app.inject({ method: "POST", url: "/api/runs/run-1/inputs", payload: { input_id: inputId, text, ...extra } });
}

test("queued inputs are persisted and folded into the initial prompt before task description", async (t) => {
  const { db, app, runs, getSession } = makeFixture(t);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content,
    delivery_type, delivery_status, accepted_at)
    VALUES ('initial-1', 'task-1', 'run-1', 1, 'start-1', 'Inspect the parser', 'INITIAL_PROMPT', 'PENDING', ?)`).run(now);

  const accepted = await send(app, "queued-1", "Check the empty input path");
  assert.equal(accepted.statusCode, 201);
  assert.equal(accepted.json().delivery_type, "QUEUED_INPUT");
  assert.equal(accepted.json().delivery_status, "PENDING");

  db.prepare("UPDATE task_runs SET input_mode = 'STEERING'").run();
  const prompt = buildRunPrompt(db, "run-1");
  void runs.start("run-1", prompt);
  await waitFor(() => getSession()?.promptStarted);
  assert.match(prompt.text, /Inspect the parser/);
  assert.match(prompt.text, /Check the empty input path/);
  getSession().deliver("unrelated user entry", "unrelated-entry");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM run_inputs WHERE delivery_status = 'DELIVERED'").get().n, 0);
  getSession().deliver(prompt.text, "initial-transcript-entry");
  await waitFor(() => db.prepare("SELECT COUNT(*) n FROM run_inputs WHERE delivery_status = 'DELIVERED'").get().n === 2);
  assert.deepEqual(db.prepare("SELECT transcript_entry_id FROM run_inputs ORDER BY sequence").all(), [
    { transcript_entry_id: "initial-transcript-entry" },
    { transcript_entry_id: "initial-transcript-entry" },
  ]);
  await runs.stop("run-1");
});

test("steering uses stable IDs, serializes identical inputs, and records distinct Pi entries", async (t) => {
  const { db, app, runs, getSession } = makeFixture(t);
  db.prepare("UPDATE task_runs SET input_mode = 'STEERING'").run();
  void runs.start("run-1", { text: "investigate", inputIds: [] });
  await waitFor(() => getSession()?.promptStarted);

  assert.equal((await send(app, "", "  ")).statusCode, 400);
  const first = await send(app, "input-1", "same guidance");
  const retry = await send(app, "input-1", "same guidance");
  const second = await send(app, "input-2", "same guidance");
  assert.equal(first.statusCode, 201);
  assert.equal(retry.statusCode, 200);
  assert.equal(second.statusCode, 201);
  await waitFor(() => getSession().steered.length === 2);
  assert.deepEqual(getSession().steered, ["same guidance", "same guidance"]);

  getSession().deliver("same guidance", "steering-entry-1");
  getSession().deliver("same guidance", "steering-entry-2");
  const rows = db.prepare("SELECT id, delivery_status, transcript_entry_id FROM run_inputs ORDER BY sequence").all();
  assert.deepEqual(rows, [
    { id: "input-1", delivery_status: "DELIVERED", transcript_entry_id: "steering-entry-1" },
    { id: "input-2", delivery_status: "DELIVERED", transcript_entry_id: "steering-entry-2" },
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM run_inputs").get().n, 2);
  assert.deepEqual(db.prepare(`SELECT entry_id, run_id FROM run_transcript_entries
    WHERE run_id = 'run-1' ORDER BY sequence`).all(), [
    { entry_id: "steering-entry-1", run_id: "run-1" },
    { entry_id: "steering-entry-2", run_id: "run-1" },
  ]);
  await runs.stop("run-1");
});

test("explicitly reusing unresolved guidance creates a linked input", async (t) => {
  const { db, app, runs, getSession } = makeFixture(t);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content,
    delivery_type, delivery_status, accepted_at) VALUES ('source-1', 'task-1', 'run-1', 1,
    'source-1', 'try the null case', 'STEERING', 'DELIVERY_UNKNOWN', ?)`).run(now);
  db.prepare("UPDATE task_runs SET input_mode = 'STEERING'").run();
  void runs.start("run-1", { text: "investigate", inputIds: [] });
  await waitFor(() => getSession()?.promptStarted);

  const reused = await send(app, "input-2", "try the null case", { reused_from_input_id: "source-1" });
  assert.equal(reused.statusCode, 201);
  assert.equal(reused.json().reused_from_input_id, "source-1");
  const invalid = await send(app, "input-3", "different text", { reused_from_input_id: "source-1" });
  assert.equal(invalid.statusCode, 409);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM run_inputs").get().n, 2);
  await runs.stop("run-1");
});

test("Stop marks accepted-but-unconfirmed guidance delivery unknown", async (t) => {
  const { db, app, runs, getSession } = makeFixture(t);
  db.prepare("UPDATE task_runs SET input_mode = 'STEERING'").run();
  void runs.start("run-1", { text: "investigate", inputIds: [] });
  await waitFor(() => getSession()?.promptStarted);
  await send(app, "input-1", "do not lose this instruction");
  await waitFor(() => db.prepare("SELECT delivery_status FROM run_inputs WHERE id = 'input-1'").get()?.delivery_status === "ACCEPTED");
  await runs.stop("run-1");
  assert.equal(db.prepare("SELECT delivery_status FROM run_inputs WHERE id = 'input-1'").get().delivery_status, "DELIVERY_UNKNOWN");
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'run-1'").get().status, "INTERRUPTED");
});

test("an unrelated Pi user entry makes the next steering delivery unknown, not falsely delivered", async (t) => {
  const { db, app, runs, getSession } = makeFixture(t);
  db.prepare("UPDATE task_runs SET input_mode = 'STEERING'").run();
  void runs.start("run-1", { text: "investigate", inputIds: [] });
  await waitFor(() => getSession()?.promptStarted);
  await send(app, "input-1", "focus on parser");
  await waitFor(() => getSession().steered.length === 1);
  getSession().deliver("external user message", "external-entry");
  assert.equal(db.prepare("SELECT delivery_status FROM run_inputs WHERE id = 'input-1'").get().delivery_status, "DELIVERY_UNKNOWN");
  await runs.stop("run-1");
});

test("normal completion fails safely when accepted guidance is not confirmed in the transcript", async (t) => {
  const { db, app, runs, getSession } = makeFixture(t);
  db.prepare("UPDATE task_runs SET input_mode = 'STEERING'").run();
  const started = runs.start("run-1", { text: "work", inputIds: [] });
  await waitFor(() => getSession()?.promptStarted);

  await send(app, "input-1", "do not lose this instruction");
  await waitFor(() => db.prepare("SELECT delivery_status FROM run_inputs WHERE id = 'input-1'").get()?.delivery_status === "ACCEPTED");
  getSession().finishPrompt();
  await started;

  assert.equal(getSession().promptCount, 1, "delivery failure must not trigger a handover retry");
  assert.deepEqual(db.prepare("SELECT status, reason_code FROM task_runs WHERE id = 'run-1'").get(), {
    status: "FAILED", reason_code: "INPUT_DELIVERY_FAILED",
  });
  assert.equal(db.prepare("SELECT delivery_status FROM run_inputs WHERE id = 'input-1'").get().delivery_status, "DELIVERY_UNKNOWN");
  assert.deepEqual(db.prepare("SELECT workflow_state, review_tag FROM tasks WHERE id = 'task-1'").get(), {
    workflow_state: "REVIEW", review_tag: "RUN_FAILED",
  });
});

test("completed work waits for accepted guidance delivery but needs no handover", async (t) => {
  const { db, app, runs, getSession } = makeFixture(t);
  db.prepare("UPDATE task_runs SET input_mode = 'STEERING'").run();
  const started = runs.start("run-1", { text: "work", inputIds: [] });
  await waitFor(() => getSession()?.promptStarted);

  await send(app, "input-1", "include the null case");
  await waitFor(() => getSession().steered.length === 1);
  getSession().deliver("include the null case", "late-guidance-entry");
  await waitFor(() => db.prepare("SELECT delivery_status FROM run_inputs WHERE id = 'input-1'").get()?.delivery_status === "DELIVERED");
  getSession().finishPrompt();
  await started;

  const afterClosure = await send(app, "input-2", "accepted after completion?");
  assert.equal(afterClosure.statusCode, 409);
  assert.equal(getSession().promptCount, 1, "completion must not prompt for handover or its revision");
  assert.deepEqual(db.prepare("SELECT status, handover_json FROM task_runs WHERE id = 'run-1'").get(), {
    status: "COMPLETED", handover_json: null,
  });
  assert.deepEqual(db.prepare("SELECT workflow_state, review_tag FROM tasks WHERE id = 'task-1'").get(), {
    workflow_state: "REVIEW", review_tag: "WORK_COMPLETE",
  });
  const runsResponse = await app.inject({ method: "GET", url: "/api/tasks/task-1/runs" });
  assert.equal(runsResponse.statusCode, 200);
  assert.equal(runsResponse.json()[0].handover, null);
});

test("stopping active work preserves interruption status and accepted guidance history", async (t) => {
  const { db, app, runs, getSession } = makeFixture(t);
  db.prepare("UPDATE task_runs SET input_mode = 'STEERING'").run();
  const started = runs.start("run-1", { text: "work", inputIds: [] });
  await waitFor(() => getSession()?.promptStarted);

  await send(app, "input-1", "include the null case");
  await waitFor(() => getSession().steered.length === 1);
  getSession().deliver("include the null case", "late-guidance-entry");
  await waitFor(() => db.prepare("SELECT delivery_status FROM run_inputs WHERE id = 'input-1'").get()?.delivery_status === "DELIVERED");
  await runs.stop("run-1");
  await started;

  const run = db.prepare("SELECT status, reason_code, handover_json FROM task_runs WHERE id = 'run-1'").get();
  assert.equal(run.status, "INTERRUPTED");
  assert.equal(run.reason_code, "USER_STOPPED");
  assert.equal(run.handover_json, null);
  assert.equal(db.prepare("SELECT delivery_status FROM run_inputs WHERE id = 'input-1'").get().delivery_status, "DELIVERED");
  assert.deepEqual(db.prepare("SELECT workflow_state, review_tag FROM tasks WHERE id = 'task-1'").get(), {
    workflow_state: "REVIEW", review_tag: "INTERRUPTED",
  });
  const runsResponse = await app.inject({ method: "GET", url: "/api/tasks/task-1/runs" });
  assert.equal(runsResponse.statusCode, 200);
  assert.equal(runsResponse.json()[0].status, "INTERRUPTED");
  assert.equal(runsResponse.json()[0].handover, null);
});
