import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { openDatabase } from "../dist/db.js";
import { registerTaskRunRoutes } from "../dist/task-runs.js";
import { recordValidationResult } from "../dist/agents/validation-results.js";

test("task runs endpoint exposes validation findings and recomputes active readiness", async (t) => {
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
  await recordValidationResult(db, {
    task_id: "t", run_id: "validation-1", candidate_sha: candidateSha, base_sha: baseSha,
    base_tip_at_start: baseSha, base_tip_at_finish: baseSha, guidance_watermark: "2",
    task_head_at_start: candidateSha, task_head_at_finish: candidateSha,
    task_worktree_clean_at_start: true, task_worktree_clean_at_finish: true,
    validation_worktree_clean: true,
    report: { findings: [{ id: "indirect-1", attribution: "INDIRECT", summary: "Old timeout",
      rationale: "It predates this change.", evidence: "Observed under load.", locations: [{ file: "src/client.ts", line: 8 }] }] },
  });

  let liveBaseTip = baseSha;
  const worktrees = {
    async getBaseBranchTip() { return liveBaseTip; },
    async getTaskWorktreeState() { return { head_sha: candidateSha, dirty: false }; },
  };
  const app = Fastify();
  registerTaskRunRoutes(app, db, worktrees);
  t.after(async () => { await app.close(); db.close(); });

  let response = await app.inject({ method: "GET", url: "/api/tasks/t/runs" });
  let validation = response.json()[0].validation_result;
  assert.equal(validation.result, "ISSUES_FOUND");
  assert.equal(validation.active, true);
  assert.equal(validation.findings[0].summary, "Old timeout");

  liveBaseTip = "c".repeat(40);
  response = await app.inject({ method: "GET", url: "/api/tasks/t/runs" });
  validation = response.json()[0].validation_result;
  assert.equal(validation.active, false);
  assert.equal(db.prepare("SELECT review_tag FROM tasks WHERE id = 't'").get().review_tag, "IMPLEMENTATION_COMPLETE");
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
