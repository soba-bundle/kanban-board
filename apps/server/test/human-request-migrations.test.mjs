import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../dist/db.js";

test("Phase 7 schema stores one structured questionnaire request and answer per Pi tool call", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  assert.ok(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version >= 8);
  const columns = db.prepare("PRAGMA table_info(human_requests)").all().map((column) => column.name);
  assert.ok(columns.includes("questions_json"), "the full multi-question tool payload must be durable");
  assert.ok(columns.includes("answers_json"), "the complete answer set must be durable before resumption");

  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', '', 'REQUIRES_HUMAN', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('run-1', 'task-1', 'INVESTIGATION', 1, 'WAITING_FOR_HUMAN')`).run();

  const questions = [
    { id: "scope", label: "Scope", prompt: "Which scope?", options: [
      { value: "small", label: "Small", description: "One module" },
    ], allowOther: true },
    { id: "risk", label: "Risk", prompt: "Accept the migration risk?", options: [
      { value: "yes", label: "Yes" }, { value: "no", label: "No" },
    ], allowOther: false },
  ];
  const result = db.prepare(`INSERT INTO human_requests (id, task_id, run_id, session_id, tool_call_id,
    question, options_json, answer, questions_json, answers_json, status, created_at)
    VALUES ('request-1', 'task-1', 'run-1', 'session-1', 'tool-call-1', '', '[]', NULL, ?, NULL, 'PENDING', ?)`)
    .run(JSON.stringify(questions), now);
  assert.equal(result.changes, 1);
  const stored = db.prepare("SELECT questions_json, answers_json, status FROM human_requests WHERE id = 'request-1'").get();
  assert.deepEqual(JSON.parse(stored.questions_json), questions);
  assert.equal(stored.answers_json, null);
  assert.equal(stored.status, "PENDING");
  assert.throws(() => db.prepare(`INSERT INTO human_requests (id, task_id, run_id, session_id, tool_call_id,
    question, options_json, answer, questions_json, answers_json, status, created_at)
    SELECT 'duplicate-request', task_id, run_id, session_id, tool_call_id, question, options_json, answer,
      questions_json, answers_json, status, created_at FROM human_requests WHERE id = 'request-1'`).run(),
  /UNIQUE constraint failed/i, "one Pi tool call must own at most one durable Human Request");
});
