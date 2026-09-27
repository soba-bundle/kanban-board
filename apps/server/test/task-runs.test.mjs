import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { openDatabase } from "../dist/db.js";
import { registerTaskRunRoutes } from "../dist/task-runs.js";

test("task runs endpoint exposes parsed handovers in run order", async (t) => {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', 'Details', 'REVIEW', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, handover_json, started_at)
    VALUES ('run-2', 'task-1', 'IMPLEMENTATION', 2, 'FAILED', NULL, ?)`).run(now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, reason_code, handover_json, started_at)
    VALUES ('run-1', 'task-1', 'INVESTIGATION', 1, 'COMPLETED', NULL, ?, ?)`)
    .run(JSON.stringify({ stage: "INVESTIGATION", summary: "found it", evidence: ["log line"] }), now);

  const app = Fastify();
  registerTaskRunRoutes(app, db);
  t.after(async () => { await app.close(); db.close(); });

  assert.equal((await app.inject({ method: "GET", url: "/api/tasks/missing/runs" })).statusCode, 404);
  const response = await app.inject({ method: "GET", url: "/api/tasks/task-1/runs" });
  assert.equal(response.statusCode, 200);
  const runs = response.json();
  assert.deepEqual(runs.map((run) => run.id), ["run-1", "run-2"]);
  assert.equal(runs[0].handover.summary, "found it");
  assert.deepEqual(runs[0].handover.evidence, ["log line"]);
  assert.equal(runs[1].handover, null);
  assert.equal("handover_json" in runs[0], false);
});
