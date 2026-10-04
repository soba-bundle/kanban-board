import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { openDatabase } from "../dist/db.js";
import { registerTaskRunRoutes } from "../dist/task-runs.js";

test("task runs endpoint exposes historical Validation findings without recomputing readiness", async (t) => {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  const baseSha = "a".repeat(40);
  const candidateSha = "b".repeat(40);
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('p', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, review_tag,
      base_commit_sha, latest_task_commit_sha, created_at, updated_at)
    VALUES ('t', 'p', 'Task', '', 'REVIEW', 'IN_PROGRESS', ?, ?, ?, ?)`)
    .run(baseSha, candidateSha, now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('validation-1', 't', 'VALIDATION_REVIEW', 1, 'COMPLETED')`).run();
  db.prepare(`INSERT INTO validation_results (id, task_id, run_id, result, findings_json, created_at)
    VALUES ('result-1', 't', 'validation-1', 'ISSUES_FOUND', ?, ?)`).run(JSON.stringify([
      { id: "indirect-1", attribution: "INDIRECT", summary: "Old timeout",
        rationale: "It predates this change.", evidence: "Observed under load.", locations: [{ file: "src/client.ts", line: 8 }] },
    ]), now);

  let gitReads = 0;
  const worktrees = {
    async getBaseBranchTip() { gitReads++; return baseSha; },
    async getTaskWorktreeState() { gitReads++; return { head_sha: candidateSha, dirty: false }; },
  };
  const app = Fastify();
  registerTaskRunRoutes(app, db);
  t.after(async () => { await app.close(); db.close(); });

  const response = await app.inject({ method: "GET", url: "/api/tasks/t/runs" });
  const validation = response.json()[0].validation_result;
  assert.equal(validation.result, "ISSUES_FOUND");
  assert.equal(validation.active, false);
  assert.equal(validation.findings[0].summary, "Old timeout");
  assert.equal(gitReads, 0, "history reads do not inspect live Git state");
  assert.equal(db.prepare("SELECT review_tag FROM tasks WHERE id = 't'").get().review_tag, "IN_PROGRESS");
});

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
