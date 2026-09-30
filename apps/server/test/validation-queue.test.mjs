import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../dist/db.js";
import { QueueManager } from "../dist/queue/queue-manager.js";

function makeDb() {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('p', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('t', 'p', 'Task', '', 'IN_PROGRESS', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('validation-1', 't', 'VALIDATION_REVIEW', 1, 'QUEUED')`).run();
  db.prepare(`INSERT INTO agent_jobs (id, task_run_id, queue_position, priority, status, created_at)
    VALUES ('job-1', 'validation-1', NULL, 0, 'CLAIMED', ?)`).run(now);
  return db;
}

test("claimed Validation Review stopped before Pi dispatch becomes Validation Failed without starting a session", async (t) => {
  const db = makeDb();
  const startedRuns = [];
  const queue = new QueueManager(db, { start(runId) { startedRuns.push(runId); return Promise.resolve(); } }, 1);
  t.after(() => db.close());

  await queue.stopRun("validation-1");
  const stopped = db.prepare("SELECT status, reason_code FROM task_runs WHERE id = 'validation-1'").get();
  assert.equal(stopped.status, "FAILED");
  assert.equal(stopped.reason_code, "USER_STOPPED");
  assert.equal(db.prepare("SELECT review_tag FROM tasks WHERE id = 't'").get().review_tag, "VALIDATION_FAILED");
  assert.deepEqual(startedRuns, [], "the stopped validation prompt must never reach Pi");
});

test("backend restart marks active Validation Review failed instead of replaying it", (t) => {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('p', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, review_tag, created_at, updated_at)
    VALUES ('t', 'p', 'Task', '', 'IN_PROGRESS', NULL, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('validation-1', 't', 'VALIDATION_REVIEW', 1, 'RUNNING')`).run();
  db.prepare(`INSERT INTO agent_jobs (id, task_run_id, queue_position, priority, status, created_at)
    VALUES ('job-1', 'validation-1', NULL, 0, 'CLAIMED', ?)`).run(now);
  const resumed = [];
  const queue = new QueueManager(db, { start(runId) { resumed.push(runId); return Promise.resolve(); } }, 1);
  t.after(() => db.close());

  queue.initialize();
  const run = db.prepare("SELECT status, reason_code FROM task_runs WHERE id = 'validation-1'").get();
  assert.equal(run.status, "FAILED");
  assert.equal(run.reason_code, "BACKEND_INTERRUPTED");
  assert.equal(db.prepare("SELECT review_tag FROM tasks WHERE id = 't'").get().review_tag, "VALIDATION_FAILED");
  assert.deepEqual(resumed, [], "restart must not replay the interrupted reviewer prompt");
});
