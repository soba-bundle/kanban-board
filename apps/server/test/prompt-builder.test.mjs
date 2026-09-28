import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../dist/db.js";
import { buildRunPrompt } from "../dist/agents/prompt-builder.js";

function makeDb(stage = "INVESTIGATION") {
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

test("prompt puts explicit user instructions before task description and carries stage/title context", (t) => {
  const db = makeDb();
  t.after(() => db.close());
  addInput(db, "initial", "run-1", 1, "Inspect the retry behavior", "INITIAL_PROMPT");
  const prompt = buildRunPrompt(db, "run-1");
  assert.match(prompt.text, /^Investigate this task\./);
  assert.match(prompt.text, /Title: Fix retry/);
  assert.ok(prompt.text.indexOf("Inspect the retry behavior") < prompt.text.indexOf("Task description:"));
  assert.match(prompt.text, /Retries drop the abort signal\./);
  assert.deepEqual(prompt.commentIds, []);
  assert.throws(() => buildRunPrompt(db, "missing"), /not found/);
});

test("prompt combines only that run's queued guidance once in accepted order", (t) => {
  const db = makeDb("IMPLEMENTATION");
  t.after(() => db.close());
  addInput(db, "initial", "run-1", 1, "Implement the fix", "INITIAL_PROMPT");
  addInput(db, "queued-2", "run-1", 3, "second note");
  addInput(db, "queued-1", "run-1", 2, "first note");
  addInput(db, "other-run", "run-2", 1, "must not leak", "INITIAL_PROMPT");
  addInput(db, "delivered", "run-1", 4, "already delivered", "QUEUED_INPUT", "DELIVERED");
  addInput(db, "steering", "run-1", 5, "belongs to active steering", "STEERING");

  const prompt = buildRunPrompt(db, "run-1");
  assert.match(prompt.text, /^Implement this task\./);
  assert.ok(prompt.text.indexOf("Implement the fix") < prompt.text.indexOf("Task description:"));
  assert.match(prompt.text, /Additional queued guidance:\n- first note\n- second note/);
  assert.doesNotMatch(prompt.text, /must not leak|already delivered|belongs to active steering/);
  assert.deepEqual(prompt.commentIds, []);
});

test("a run without an explicit initial prompt cannot dispatch", (t) => {
  const db = makeDb();
  t.after(() => db.close());
  assert.throws(() => buildRunPrompt(db, "run-1"), /no initial prompt/);
});
