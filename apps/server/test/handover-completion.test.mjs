import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../dist/db.js";
import { AgentManager } from "../dist/agents/agent-manager.js";
import { RunManager } from "../dist/agents/run-manager.js";

function makeFixture(t, options = {}) {
  const { stage = "INVESTIGATION", submitOn = [] } = options;
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', 'Details', 'IN_PROGRESS', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('run-1', 'task-1', ?, 1, 'QUEUED')`).run(stage);

  const prompts = [];
  const agents = new AgentManager(db, "/tmp/handover-test", async (_cwd, manager) => ({
    sessionId: manager.getSessionId(),
    sessionFile: manager.getSessionFile(),
    subscribe: () => () => {},
    // submitOn lists the prompt indexes on which the agent calls submit_handover.
    prompt: async (text) => {
      prompts.push(text);
      if (submitOn.includes(prompts.length - 1)) {
        db.prepare("UPDATE task_runs SET handover_json = ? WHERE id = 'run-1'")
          .run(JSON.stringify({ stage, summary: "done" }));
      }
    },
    steer: async () => {},
    abort: async () => {},
    dispose() {},
  }));
  const runs = new RunManager(db, agents);
  t.after(() => { agents.dispose("task-1"); db.close(); });
  return { db, runs, prompts };
}

const run = (db) => db.prepare("SELECT * FROM task_runs WHERE id = 'run-1'").get();
const task = (db) => db.prepare("SELECT workflow_state, review_tag FROM tasks WHERE id = 'task-1'").get();

test("investigation handover on the first prompt completes the run and moves to Review", async (t) => {
  const { db, runs, prompts } = makeFixture(t, { submitOn: [0] });
  await runs.start("run-1", { text: "investigate", inputIds: [] });

  assert.equal(prompts.length, 1);
  assert.equal(run(db).status, "COMPLETED");
  assert.equal(run(db).reason_code, null);
  assert.deepEqual(task(db), { workflow_state: "REVIEW", review_tag: "INVESTIGATION_COMPLETE" });
});

test("implementation handover uses its own review tag", async (t) => {
  const { db, runs } = makeFixture(t, { stage: "IMPLEMENTATION", submitOn: [0] });
  await runs.start("run-1", { text: "implement", inputIds: [] });
  assert.equal(run(db).status, "COMPLETED");
  assert.deepEqual(task(db), { workflow_state: "REVIEW", review_tag: "IMPLEMENTATION_COMPLETE" });
});

test("a missing handover is requested exactly once and then succeeds", async (t) => {
  const { db, runs, prompts } = makeFixture(t, { submitOn: [1] });
  await runs.start("run-1", { text: "investigate", inputIds: [] });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /without calling submit_handover/);
  assert.match(prompts[1], /Do not do any further work/);
  assert.equal(run(db).status, "COMPLETED");
  assert.deepEqual(task(db), { workflow_state: "REVIEW", review_tag: "INVESTIGATION_COMPLETE" });
});

test("a second missing handover fails the run with HANDOVER_FAILED", async (t) => {
  const { db, runs, prompts } = makeFixture(t, { submitOn: [] });
  await runs.start("run-1", { text: "investigate", inputIds: [] });

  // Exactly one retry, never more.
  assert.equal(prompts.length, 2);
  assert.equal(run(db).status, "FAILED");
  assert.equal(run(db).reason_code, "HANDOVER_FAILED");
  assert.match(run(db).error_message, /without a valid handover/);
  assert.ok(run(db).completed_at);
  assert.deepEqual(task(db), { workflow_state: "REVIEW", review_tag: "RUN_FAILED" });
});

test("validation review runs complete without requiring a handover", async (t) => {
  const { db, runs, prompts } = makeFixture(t, { stage: "VALIDATION_REVIEW", submitOn: [] });
  await runs.start("run-1", { text: "review", inputIds: [] });

  assert.equal(prompts.length, 1);
  assert.equal(run(db).status, "COMPLETED");
  // Phase 8 owns validation outcomes, so the board is untouched here.
  assert.deepEqual(task(db), { workflow_state: "IN_PROGRESS", review_tag: null });
});

test("a stop during the handover retry is recorded as interrupted, not handover failure", async (t) => {
  const { db, runs } = makeFixture(t, { submitOn: [] });
  const started = runs.start("run-1", { text: "investigate", inputIds: [] });
  await runs.stop("run-1");
  await started;

  assert.equal(run(db).status, "INTERRUPTED");
  assert.equal(run(db).reason_code, "USER_STOPPED");
  assert.deepEqual(task(db), { workflow_state: "REVIEW", review_tag: "INTERRUPTED" });
});
