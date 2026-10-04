import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../dist/db.js";
import { buildRunPrompt } from "../dist/agents/prompt-builder.js";

function makeDb(stage = "WORK") {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Fix retry', 'Retries drop the abort signal.', 'IN_PROGRESS', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('run-1', 'task-1', ?, 1, 'QUEUED'), ('run-2', 'task-1', ?, 2, 'QUEUED')`).run(stage, stage);
  return db;
}

function addInput(db, id, runId, sequence, content, deliveryType = "QUEUED_INPUT", status = "PENDING") {
  db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content,
    delivery_type, delivery_status, accepted_at) VALUES (?, 'task-1', ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, runId, sequence, id, content, deliveryType, status, new Date().toISOString());
}

test("prompt uses one Work directive and includes explicit instructions and task context", (t) => {
  const db = makeDb("INVESTIGATION");
  t.after(() => db.close());
  addInput(db, "initial", "run-1", 1, "Inspect the retry behavior", "INITIAL_PROMPT");
  const prompt = buildRunPrompt(db, "run-1");
  assert.equal(prompt.text, "Based on this task description:\nRetries drop the abort signal.\n\nInspect the retry behavior");
  assert.match(prompt.text, /Retries drop the abort signal\./);
  assert.deepEqual(prompt.inputIds, ["initial"]);
  assert.throws(() => buildRunPrompt(db, "missing"), /not found/);
});

test("WORK prompt does not pre-classify the request as investigation or implementation", (t) => {
  const db = makeDb("WORK");
  t.after(() => db.close());
  addInput(db, "initial", "run-1", 1, "Explain whether a fix is needed", "INITIAL_PROMPT");
  const prompt = buildRunPrompt(db, "run-1");
  assert.equal(prompt.text, "Based on this task description:\nRetries drop the abort signal.\n\nExplain whether a fix is needed");
  assert.equal(prompt.text.startsWith("Investigate this task.") || prompt.text.startsWith("Implement this task."), false);
  assert.match(prompt.text, /Explain whether a fix is needed/);
  assert.match(prompt.text, /Retries drop the abort signal\./);
});

test("prompt combines only that run's queued guidance once in accepted order", (t) => {
  const db = makeDb("WORK");
  t.after(() => db.close());
  addInput(db, "initial", "run-1", 1, "Implement the fix", "INITIAL_PROMPT");
  addInput(db, "queued-2", "run-1", 3, "second note");
  addInput(db, "queued-1", "run-1", 2, "first note");
  addInput(db, "other-run", "run-2", 1, "must not leak", "INITIAL_PROMPT");
  addInput(db, "delivered", "run-1", 4, "already delivered", "QUEUED_INPUT", "DELIVERED");
  addInput(db, "steering", "run-1", 5, "belongs to active steering", "STEERING");

  const prompt = buildRunPrompt(db, "run-1");
  assert.ok(prompt.text.startsWith("Based on this task description:\nRetries drop the abort signal.\n\nImplement the fix"));
  assert.match(prompt.text, /Additional queued guidance:\n- first note\n- second note/);
  assert.doesNotMatch(prompt.text, /must not leak|already delivered|belongs to active steering/);
  assert.deepEqual(prompt.inputIds, ["initial", "queued-1", "queued-2"]);
});

test("subsequent runs send only the exact user prompt even without a session", (t) => {
  const db = makeDb();
  t.after(() => db.close());
  addInput(db, "next", "run-2", 1, "Ignore the description. Write about Burger King.\nKeep this line.", "INITIAL_PROMPT");
  assert.equal(buildRunPrompt(db, "run-2").text, "Ignore the description. Write about Burger King.\nKeep this line.");
});

test("a run without an explicit initial prompt cannot dispatch", (t) => {
  const db = makeDb();
  t.after(() => db.close());
  assert.throws(() => buildRunPrompt(db, "run-1"), /no initial prompt/);
});
