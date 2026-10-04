import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../dist/db.js";
import { AgentManager } from "../dist/agents/agent-manager.js";
import { RunManager } from "../dist/agents/run-manager.js";

function makeFixture(t, options = {}) {
  const { stage = "WORK", pausePrompt = false } = options;
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', 'Details', 'IN_PROGRESS', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('run-1', 'task-1', ?, 1, 'QUEUED')`).run(stage);

  const prompts = [];
  let releasePrompt;
  const agents = new AgentManager(db, "/tmp/handover-test", async (_cwd, manager) => ({
    sessionId: manager.getSessionId(),
    sessionFile: manager.getSessionFile(),
    subscribe: () => () => {},
    prompt: async (text) => {
      prompts.push(text);
      if (pausePrompt) await new Promise((resolve) => { releasePrompt = resolve; });
    },
    steer: async () => {},
    abort: async () => { releasePrompt?.(); },
    dispose() {},
  }));
  const runs = new RunManager(db, agents);
  t.after(() => { agents.dispose("task-1"); db.close(); });
  return { db, runs, prompts };
}

const run = (db) => db.prepare("SELECT * FROM task_runs WHERE id = 'run-1'").get();
const task = (db) => db.prepare("SELECT workflow_state, review_tag FROM tasks WHERE id = 'task-1'").get();

test("WORK completes after the ordinary response without a handover retry", async (t) => {
  for (const stage of ["WORK"]) {
    await t.test(stage, async (subtest) => {
      const { db, runs, prompts } = makeFixture(subtest, { stage });
      await runs.start("run-1", { text: "Work on the task", inputIds: [] });

      assert.equal(prompts.length, 1, "completion must not trigger a handover retry prompt");
      assert.equal(run(db).status, "COMPLETED");
      assert.equal(run(db).reason_code, null);
      assert.equal(run(db).handover_json, null);
      assert.deepEqual(task(db), { workflow_state: "REVIEW", review_tag: "WORK_COMPLETE" });
    });
  }
});

test("stopping active WORK remains interrupted without a handover retry", async (t) => {
  const { db, runs, prompts } = makeFixture(t, { stage: "WORK", pausePrompt: true });
  const started = runs.start("run-1", { text: "work", inputIds: [] });
  for (let index = 0; prompts.length === 0 && index < 100; index++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(prompts.length, 1);
  await runs.stop("run-1");
  await started;

  assert.equal(prompts.length, 1, "stop must not launch a handover retry");
  assert.equal(run(db).status, "INTERRUPTED");
  assert.equal(run(db).reason_code, "USER_STOPPED");
  assert.deepEqual(task(db), { workflow_state: "REVIEW", review_tag: "INTERRUPTED" });
});
