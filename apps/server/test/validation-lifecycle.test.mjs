import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../dist/db.js";
import { ValidationManager } from "../dist/agents/validation-manager.js";
import { QueueManager } from "../dist/queue/queue-manager.js";

const baseSha = "a".repeat(40);
const candidateSha = "b".repeat(40);

function makeDb() {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('p', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, review_tag,
      base_branch, base_commit_sha, latest_task_commit_sha, worktree_path,
      working_session_id, working_session_file, created_at, updated_at)
    VALUES ('t', 'p', 'Private task title', 'Reviewer-facing task description.', 'REVIEW', 'IMPLEMENTATION_COMPLETE',
      'main', ?, ?, '/tmp/project/task-worktree', 'implementation-session', '/tmp/implementation-session.jsonl', ?, ?)`)
    .run(baseSha, candidateSha, now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, task_commit_sha, handover_json)
    VALUES ('impl-1', 't', 'IMPLEMENTATION', 1, 'COMPLETED', ?, ?)`)
    .run(candidateSha, JSON.stringify({ summary: "Completed the implementation." }));
  db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content,
      delivery_type, delivery_status, accepted_at, delivered_at)
    VALUES ('guidance-1', 't', 'impl-1', 1, 'guidance-1', 'Keep the API stable.',
      'QUEUED_INPUT', 'DELIVERED', ?, ?)`).run(now, now);
  return db;
}

const worktrees = {
  async getTaskWorktreeState() { return { head_sha: candidateSha, dirty: false }; },
  async getPinnedDiff() { return { changedFiles: ["src/change.ts"], diff: "+pinned change" }; },
  async getBaseBranchTip() { return baseSha; },
};

test("explicit validation start captures pinned context and queues without replacing the implementation session", async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const enqueued = [];
  const queue = {
    enqueueValidation(...args) {
      enqueued.push(args);
      return { run_id: "validation-1", status: "QUEUED" };
    },
  };
  const manager = new ValidationManager(db, worktrees, queue, {});
  const result = await manager.start("t");

  assert.deepEqual(result, { run_id: "validation-1", status: "QUEUED" });
  assert.equal(enqueued.length, 1);
  const [, prompt, , metadata] = enqueued[0];
  assert.match(prompt, /submit_validation_report/);
  assert.match(prompt, /pinned change/);
  assert.doesNotMatch(prompt, /Private task title/);
  assert.equal(metadata.candidate_sha, candidateSha);
  assert.equal(metadata.base_sha, baseSha);
  assert.equal(metadata.context.confirmed_guidance[0].content, "Keep the API stable.");
  assert.equal(metadata.context.checkpoint_run_id, "impl-1");
  assert.equal(metadata.task_head_sha, candidateSha);
  const task = db.prepare("SELECT working_session_id, working_session_file FROM tasks WHERE id = 't'").get();
  assert.equal(task.working_session_id, "implementation-session");
  assert.equal(task.working_session_file, "/tmp/implementation-session.jsonl");
});

test("Stop is delegated to the exact active Validation Review run", async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  let finish;
  const stopped = [];
  const queue = new QueueManager(db, { start() { return Promise.resolve(); } }, 1, undefined, {
    execute(runId) {
      db.prepare("UPDATE task_runs SET status = 'RUNNING' WHERE id = ?").run(runId);
      return new Promise((resolve) => { finish = resolve; });
    },
    async stop(runId) {
      stopped.push(runId);
      db.prepare(`UPDATE task_runs SET status = 'FAILED', reason_code = 'USER_STOPPED', completed_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), runId);
      finish();
    },
  });
  const job = queue.enqueueValidation("t", "review", "request-stop", {
    context: { candidate_commit_sha: candidateSha }, candidate_sha: candidateSha, base_sha: baseSha,
    base_tip_sha: baseSha, guidance_watermark: 1, task_head_sha: candidateSha,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await queue.stopRun(job.run_id);
  assert.deepEqual(stopped, [job.run_id]);
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = ?").get(job.run_id).status, "FAILED");
});

test("validation enqueue persists its context and atomically prevents a duplicate task run", (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const dispatched = [];
  const queue = new QueueManager(db, { start() { return Promise.resolve(); } }, 1, undefined, {
    execute(runId) { dispatched.push(runId); return Promise.resolve(); },
    stop() { return Promise.resolve(); },
  });
  const metadata = {
    context: { candidate_commit_sha: candidateSha, base_commit_sha: baseSha },
    candidate_sha: candidateSha,
    base_sha: baseSha,
    base_tip_sha: baseSha,
    guidance_watermark: 1,
    task_head_sha: candidateSha,
  };
  const job = queue.enqueueValidation("t", "review", "request-1", metadata);
  assert.equal(job.run_id.length > 0, true);
  assert.throws(() => queue.enqueueValidation("t", "review", "request-2", metadata), /not eligible|queued or running/i);
  const run = db.prepare(`SELECT stage, validation_context_json, validation_base_tip_sha,
      validation_guidance_watermark, task_commit_sha FROM task_runs WHERE id = ?`).get(job.run_id);
  assert.equal(run.stage, "VALIDATION_REVIEW");
  assert.equal(JSON.parse(run.validation_context_json).candidate_commit_sha, candidateSha);
  assert.equal(run.validation_base_tip_sha, baseSha);
  assert.equal(run.validation_guidance_watermark, 1);
  assert.equal(run.task_commit_sha, candidateSha);
  assert.deepEqual(dispatched, [job.run_id]);
  const task = db.prepare("SELECT working_session_id FROM tasks WHERE id = 't'").get();
  assert.equal(task.working_session_id, "implementation-session");
});
