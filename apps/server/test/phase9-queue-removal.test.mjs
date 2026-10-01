import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { openDatabase } from "../dist/db.js";
import { TaskOperationCoordinator } from "../dist/task-operation-coordinator.js";
import { registerQueueRoutes } from "../dist/queue/queue-routes.js";
import { QueueManager } from "../dist/queue/queue-manager.js";

test("removing queued Validation notifies merge lifecycle after the queue item is cancelled", async (t) => {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('p', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, review_tag, created_at, updated_at)
    VALUES ('t', 'p', 'Task', '', 'IN_PROGRESS', NULL, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, return_workflow_state, return_review_tag)
    VALUES ('validation-run', 't', 'VALIDATION_REVIEW', 2, 'QUEUED', 'REVIEW', 'IMPLEMENTATION_COMPLETE')`).run();
  db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content,
    delivery_type, delivery_status, accepted_at)
    VALUES ('validation-input', 't', 'validation-run', 1, 'validation-key', 'review', 'INITIAL_PROMPT', 'PENDING', ?)`)
    .run(now);
  db.prepare(`INSERT INTO agent_jobs (id, task_run_id, queue_position, priority, status, created_at)
    VALUES ('validation-job', 'validation-run', 1, 1, 'QUEUED', ?)`).run(now);

  const queue = new QueueManager(db, { start() { throw new Error("removed job must not dispatch"); } }, 1);
  const app = Fastify();
  const removals = [];
  const stops = [];
  registerQueueRoutes(app, queue, new TaskOperationCoordinator(), {
    async onRunStopped(runId) { stops.push(runId); },
    async onJobRemoved(jobId) {
      const job = db.prepare(`SELECT j.status AS job_status, r.id AS run_id, r.stage, r.status AS run_status
        FROM agent_jobs j JOIN task_runs r ON r.id = j.task_run_id WHERE j.id = ?`).get(jobId);
      removals.push({ jobId, ...job });
    },
  });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const refusedStop = await app.inject({ method: "POST", url: "/api/runs/validation-run/stop" });
  assert.equal(refusedStop.statusCode, 409);
  assert.match(refusedStop.json().error, /remove it from the queue/i);
  assert.deepEqual(stops, [], "a rejected Stop cannot notify or revoke merge lifecycle state");
  assert.equal(db.prepare("SELECT status FROM agent_jobs WHERE id = 'validation-job'").get().status, "QUEUED");

  const response = await app.inject({ method: "DELETE", url: "/api/queue/validation-job" });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(removals, [{
    jobId: "validation-job", job_status: "CANCELLED", run_id: "validation-run",
    stage: "VALIDATION_REVIEW", run_status: "CANCELLED",
  }], "merge lifecycle must learn that the associated Validation was removed");
  assert.equal(db.prepare("SELECT workflow_state FROM tasks WHERE id = 't'").get().workflow_state, "REVIEW");
});
