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

test("fresh merge-gate Validation is prioritized behind active work without preempting it", async (t) => {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('p', 'Project', '/tmp/project', ?, ?)")
    .run(now, now);
  for (const [id, state, tag] of [["active", "IN_PROGRESS", null], ["ordinary", "IN_PROGRESS", null], ["merge", "REVIEW", "IMPLEMENTATION_COMPLETE"]]) {
    db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, review_tag,
      base_commit_sha, latest_task_commit_sha, created_at, updated_at) VALUES (?, 'p', ?, '', ?, ?, ?, ?, ?, ?)`)
      .run(id, id, state, tag, id === "merge" ? "b".repeat(40) : null, id === "merge" ? "c".repeat(40) : null, now, now);
  }
  db.prepare("INSERT INTO task_runs (id, task_id, stage, sequence, status) VALUES ('active-run', 'active', 'IMPLEMENTATION', 1, 'RUNNING')").run();
  db.prepare("INSERT INTO agent_jobs (id, task_run_id, queue_position, priority, status, created_at) VALUES ('active-job', 'active-run', NULL, 0, 'CLAIMED', ?)")
    .run(now);
  for (const [id, taskId, stage, sequence] of [["ordinary-run", "ordinary", "IMPLEMENTATION", 1]]) {
    db.prepare("INSERT INTO task_runs (id, task_id, stage, sequence, status) VALUES (?, ?, ?, ?, 'QUEUED')").run(id, taskId, stage, sequence);
    db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content, delivery_type, delivery_status, accepted_at)
      VALUES (?, ?, ?, 1, ?, 'work', 'INITIAL_PROMPT', 'PENDING', ?)`)
      .run(`${id}-input`, taskId, id, `${id}-key`, now);
    db.prepare("INSERT INTO agent_jobs (id, task_run_id, queue_position, priority, status, created_at) VALUES (?, ?, 1, 0, 'QUEUED', ?)")
      .run(`${id}-job`, id, now);
  }
  const starts = [];
  const validationStarts = [];
  const queue = new QueueManager(db, { start(runId) { starts.push(runId); return new Promise(() => {}); } }, 1,
    undefined, { async execute(runId) { validationStarts.push(runId); } });
  t.after(() => db.close());

  const validation = queue.enqueueValidation("merge", "Fresh priority review", "merge-validation-key", {
    context: {}, candidate_sha: "c".repeat(40), base_sha: "b".repeat(40), base_tip_sha: "b".repeat(40),
    guidance_watermark: 0, task_head_sha: "c".repeat(40), priority: true,
  });
  const jobs = db.prepare(`SELECT r.stage, j.priority, j.status FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id
    WHERE j.status IN ('QUEUED', 'CLAIMED') ORDER BY j.priority DESC, j.queue_position`).all();
  assert.equal(jobs[0].stage, "VALIDATION_REVIEW", "fresh merge-gate validation should be ahead of ordinary queued work");
  assert.equal(jobs[0].priority, 1);
  assert.equal(jobs[0].status, "QUEUED", "priority must not preempt active work");
  assert.equal(db.prepare("SELECT status FROM agent_jobs WHERE id = 'active-job'").get().status, "CLAIMED");
  assert.deepEqual(starts, [], "no new job can start while the active slot is occupied");
  assert.ok(validation.created);

  db.prepare("UPDATE agent_jobs SET status = 'FINISHED' WHERE id = 'active-job'").run();
  db.prepare("UPDATE task_runs SET status = 'COMPLETED' WHERE id = 'active-run'").run();
  const duplicate = queue.enqueueValidation("merge", "Fresh priority review", "merge-validation-key", {
    context: {}, candidate_sha: "c".repeat(40), base_sha: "b".repeat(40), base_tip_sha: "b".repeat(40),
    guidance_watermark: 0, task_head_sha: "c".repeat(40), priority: true,
  });
  assert.equal(duplicate.run_id, validation.run_id);
  assert.deepEqual(validationStarts, [validation.run_id], "the priority validation dispatches as soon as capacity is free");
});

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
