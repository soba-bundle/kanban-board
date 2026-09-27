import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../dist/db.js";
import { buildRunPrompt, markCommentsDelivered } from "../dist/agents/prompt-builder.js";

function makeDb(stage = "INVESTIGATION") {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Fix retry', 'Retries drop the abort signal.', 'IN_PROGRESS', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('run-1', 'task-1', ?, 1, 'QUEUED')`).run(stage);
  return db;
}

function addComment(db, id, content, extra = {}) {
  const { status = "PENDING", author = "USER", createdAt = new Date().toISOString() } = extra;
  db.prepare(`INSERT INTO ticket_comments (id, task_id, author_type, content, delivery_status, created_at)
    VALUES (?, 'task-1', ?, ?, ?, ?)`).run(id, author, content, status, createdAt);
}

test("prompt carries stage, task details, and no comment section when none are pending", (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const prompt = buildRunPrompt(db, "run-1");
  assert.match(prompt.text, /^Investigate this task\./);
  assert.match(prompt.text, /Title: Fix retry/);
  assert.match(prompt.text, /Retries drop the abort signal\./);
  assert.doesNotMatch(prompt.text, /New comments/);
  assert.deepEqual(prompt.commentIds, []);
  assert.throws(() => buildRunPrompt(db, "missing"), /not found/);
});

test("implementation stage and pending comments are folded into the prompt in order", (t) => {
  const db = makeDb("IMPLEMENTATION");
  t.after(() => db.close());
  addComment(db, "c-2", "second note", { createdAt: "2025-01-02T00:00:00.000Z" });
  addComment(db, "c-1", "first note", { createdAt: "2025-01-01T00:00:00.000Z" });
  addComment(db, "c-sent", "already sent", { status: "DELIVERED" });
  addComment(db, "c-queued", "steering in flight", { status: "QUEUED" });
  addComment(db, "c-agent", "agent chatter", { author: "AGENT" });

  const prompt = buildRunPrompt(db, "run-1");
  assert.match(prompt.text, /^Implement this task\./);
  assert.match(prompt.text, /New comments from the user:\n- first note\n- second note/);
  assert.doesNotMatch(prompt.text, /already sent|steering in flight|agent chatter/);
  assert.deepEqual(prompt.commentIds, ["c-1", "c-2"]);
});

test("marking delivery stamps session metadata and never revives delivered comments", (t) => {
  const db = makeDb();
  t.after(() => db.close());
  addComment(db, "c-1", "please check logging");
  addComment(db, "c-2", "and the timeout");

  markCommentsDelivered(db, buildRunPrompt(db, "run-1").commentIds, "session-9", "run-1");
  const rows = db.prepare("SELECT * FROM ticket_comments ORDER BY id").all();
  for (const row of rows) {
    assert.equal(row.delivery_status, "DELIVERED");
    assert.equal(row.delivery_type, "NEXT_PROMPT");
    assert.equal(row.delivered_session_id, "session-9");
    assert.equal(row.delivered_run_id, "run-1");
    assert.ok(row.delivered_at);
  }

  // A later run must not resend or restamp them.
  const next = buildRunPrompt(db, "run-1");
  assert.deepEqual(next.commentIds, []);
  assert.doesNotMatch(next.text, /please check logging/);
  markCommentsDelivered(db, ["c-1"], "session-10", "run-2");
  assert.equal(db.prepare("SELECT delivered_session_id FROM ticket_comments WHERE id = 'c-1'").get().delivered_session_id, "session-9");
  markCommentsDelivered(db, [], "session-10", "run-2");
});
