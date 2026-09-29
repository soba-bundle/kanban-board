import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { openDatabase } from "../dist/db.js";
import { QueueManager } from "../dist/queue/queue-manager.js";
import { registerQueueRoutes } from "../dist/queue/queue-routes.js";
import { AgentManager } from "../dist/agents/agent-manager.js";
import { RunManager } from "../dist/agents/run-manager.js";

function makeDb(taskCount = 3) {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  for (let index = 1; index <= taskCount; index++) {
    db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
      VALUES (?, 'project-1', ?, '', 'TODO', ?, ?)`).run(`task-${index}`, `Task ${index}`, now, now);
  }
  return db;
}

let inputSequence = 0;
function enqueue(queue, taskId, stage, prompt = `Explicit prompt ${inputSequence + 1}`) {
  inputSequence++;
  return queue.enqueueTask(taskId, stage, prompt, `request-${inputSequence}`);
}

function makeFakeRuns(db) {
  const active = new Set();
  const started = [];
  const releases = new Map();
  let peak = 0;
  return {
    active,
    started,
    releases,
    get peak() { return peak; },
    start(runId) {
      active.add(runId);
      started.push(runId);
      peak = Math.max(peak, active.size);
      db.prepare("UPDATE task_runs SET status = 'RUNNING', started_at = ? WHERE id = ?")
        .run(new Date().toISOString(), runId);
      return new Promise((resolve) => releases.set(runId, () => {
        db.prepare("UPDATE task_runs SET status = 'COMPLETED', completed_at = ? WHERE id = ?")
          .run(new Date().toISOString(), runId);
        active.delete(runId);
        resolve();
      }));
    },
  };
}

async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for queue dispatch.");
}

test("global queue preserves order, supports reorder/remove, and respects concurrency", async (t) => {
  const db = makeDb();
  const fakeRuns = makeFakeRuns(db);
  const queue = new QueueManager(db, fakeRuns, 1);
  queue.initialize();
  t.after(() => { for (const release of fakeRuns.releases.values()) release(); db.close(); });

  const first = enqueue(queue, "task-1", "INVESTIGATION");
  const second = enqueue(queue, "task-2", "IMPLEMENTATION");
  const third = enqueue(queue, "task-3", "INVESTIGATION");
  assert.deepEqual(fakeRuns.started, [first.run_id]);
  assert.equal(queue.getSnapshot().active_count, 1);

  queue.reorder(third.job_id, 1);
  assert.deepEqual(queue.getSnapshot().jobs.filter((job) => job.job_status === "QUEUED").map((job) => job.job_id), [third.job_id, second.job_id]);
  queue.remove(second.job_id);
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = ?").get(second.run_id).status, "CANCELLED");
  assert.equal(db.prepare("SELECT delivery_status FROM run_inputs WHERE run_id = ?").get(second.run_id).delivery_status, "UNDELIVERED");
  assert.equal(db.prepare("SELECT workflow_state FROM tasks WHERE id = 'task-2'").get().workflow_state, "TODO");

  fakeRuns.releases.get(first.run_id)();
  await waitFor(() => fakeRuns.started.includes(third.run_id));
  assert.equal(fakeRuns.peak, 1);
  fakeRuns.releases.get(third.run_id)();
  await waitFor(() => queue.getSnapshot().active_count === 0);
  assert.equal(queue.getSnapshot().jobs.length, 0);
});

test("completed Review tasks can continue with another run and cancellation restores Review", async (t) => {
  const db = makeDb(2);
  db.prepare("UPDATE tasks SET workflow_state = 'REVIEW', review_tag = 'IMPLEMENTATION_COMPLETE' WHERE id = 'task-1'").run();
  const fakeRuns = makeFakeRuns(db);
  const queue = new QueueManager(db, fakeRuns, 1);
  queue.initialize();
  t.after(async () => {
    for (const release of fakeRuns.releases.values()) release();
    await waitFor(() => queue.getSnapshot().active_count === 0);
    db.close();
  });
  enqueue(queue, "task-2", "INVESTIGATION");
  const queued = enqueue(queue, "task-1", "INVESTIGATION");
  assert.equal(db.prepare("SELECT workflow_state FROM tasks WHERE id = 'task-1'").get().workflow_state, "IN_PROGRESS");
  queue.remove(queued.job_id);
  assert.deepEqual(db.prepare("SELECT workflow_state, review_tag FROM tasks WHERE id = 'task-1'").get(), {
    workflow_state: "REVIEW", review_tag: "IMPLEMENTATION_COMPLETE",
  });
});

test("a new run can explicitly reuse unresolved guidance as a linked initial input", async (t) => {
  const db = makeDb(1);
  db.prepare(`UPDATE tasks SET workflow_state = 'REVIEW', review_tag = 'INTERRUPTED' WHERE id = 'task-1'`).run();
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('old-run', 'task-1', 'IMPLEMENTATION', 1, 'INTERRUPTED')`).run();
  db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content, delivery_type,
    delivery_status, accepted_at) VALUES ('uncertain-input', 'task-1', 'old-run', 1, 'old-input', 'retry this',
    'STEERING', 'DELIVERY_UNKNOWN', ?)`)
    .run(new Date().toISOString());
  const fakeRuns = makeFakeRuns(db);
  const queue = new QueueManager(db, fakeRuns, 1);
  queue.initialize();
  t.after(() => { for (const release of fakeRuns.releases.values()) release(); db.close(); });
  const queued = queue.enqueueTask("task-1", "IMPLEMENTATION", "retry this", "retry-key", "uncertain-input");
  const linked = db.prepare(`SELECT reused_from_input_id, content FROM run_inputs WHERE run_id = ? AND delivery_type = 'INITIAL_PROMPT'`)
    .get(queued.run_id);
  assert.deepEqual(linked, { reused_from_input_id: "uncertain-input", content: "retry this" });
  fakeRuns.releases.get(queued.run_id)();
  await waitFor(() => queue.getSnapshot().active_count === 0);

  db.prepare("UPDATE run_inputs SET delivery_status = 'DELIVERED' WHERE id = 'uncertain-input'").run();
  db.prepare("UPDATE tasks SET workflow_state = 'REVIEW', review_tag = 'INTERRUPTED' WHERE id = 'task-1'").run();
  assert.throws(() => queue.enqueueTask("task-1", "IMPLEMENTATION", "retry this", "new-key", "uncertain-input"), /Only undelivered or delivery-unknown/);
});

test("interrupted Review tasks can be safely recovered with a new explicit prompt", async (t) => {
  const db = makeDb(1);
  db.prepare("UPDATE tasks SET workflow_state = 'REVIEW', review_tag = 'INTERRUPTED' WHERE id = 'task-1'").run();
  const fakeRuns = makeFakeRuns(db);
  const queue = new QueueManager(db, fakeRuns, 1);
  queue.initialize();
  t.after(() => { for (const release of fakeRuns.releases.values()) release(); db.close(); });

  const queued = enqueue(queue, "task-1", "IMPLEMENTATION", "Recover with this new instruction");
  assert.equal(db.prepare("SELECT workflow_state FROM tasks WHERE id = 'task-1'").get().workflow_state, "IN_PROGRESS");
  assert.equal(db.prepare("SELECT content FROM run_inputs WHERE run_id = ?").get(queued.run_id).content, "Recover with this new instruction");
  fakeRuns.releases.get(queued.run_id)();
  await waitFor(() => queue.getSnapshot().active_count === 0);
});

test("queue routes enqueue tasks and expose the global queue snapshot", async (t) => {
  const db = makeDb(1);
  const fakeRuns = makeFakeRuns(db);
  const queue = new QueueManager(db, fakeRuns, 1);
  queue.initialize();
  const app = Fastify();
  registerQueueRoutes(app, queue);
  t.after(async () => { for (const release of fakeRuns.releases.values()) release(); await app.close(); db.close(); });

  const invalid = await app.inject({ method: "POST", url: "/api/tasks/task-1/queue", payload: {
    task_id: "task-1", stage: "VALIDATION_REVIEW", prompt: "Invalid", idempotency_key: "bad",
  } });
  assert.equal(invalid.statusCode, 400);
  const missingPrompt = await app.inject({ method: "POST", url: "/api/tasks/task-1/queue", payload: {
    task_id: "task-1", stage: "INVESTIGATION", idempotency_key: "missing-prompt",
  } });
  assert.equal(missingPrompt.statusCode, 400);
  const payload = { task_id: "task-1", stage: "INVESTIGATION", prompt: "Look into the race", idempotency_key: "start-1" };
  const enqueued = await app.inject({ method: "POST", url: "/api/tasks/task-1/queue", payload });
  assert.equal(enqueued.statusCode, 201);
  assert.ok(enqueued.json().run_id);
  assert.equal(db.prepare("SELECT content FROM run_inputs WHERE run_id = ?").get(enqueued.json().run_id).content, payload.prompt);
  const retry = await app.inject({ method: "POST", url: "/api/tasks/task-1/queue", payload });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().run_id, enqueued.json().run_id);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_runs").get().count, 1);
  const conflictingRetry = await app.inject({ method: "POST", url: "/api/tasks/task-1/queue", payload: {
    ...payload, prompt: "Different instructions",
  } });
  assert.equal(conflictingRetry.statusCode, 409);
  const wrongTask = await app.inject({ method: "POST", url: "/api/tasks/task-1/queue", payload: {
    ...payload, task_id: "task-other", idempotency_key: "other-key",
  } });
  assert.equal(wrongTask.statusCode, 400);
  const snapshot = await app.inject({ method: "GET", url: "/api/queue" });
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.json().max_concurrent_agents, 1);
  assert.equal(snapshot.json().active_count, 1);
  assert.equal(snapshot.json().jobs[0].task_id, "task-1");

  db.prepare("DELETE FROM agent_jobs WHERE id = ?").run(enqueued.json().job_id);
  const delayedRetry = await app.inject({ method: "POST", url: "/api/tasks/task-1/queue", payload });
  assert.equal(delayedRetry.statusCode, 200);
  assert.equal(delayedRetry.json().run_id, enqueued.json().run_id);
  assert.equal(delayedRetry.json().job_id, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_runs").get().count, 1);
});

test("Stop Run aborts an active session and records USER_STOPPED / Interrupted", async (t) => {
  const db = makeDb(1);
  let session;
  const agents = new AgentManager(db, "/tmp/stop-run-test", async (_cwd, manager) => {
    session = {
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
      promptStarted: false,
      subscribe() { return () => {}; },
      prompt() {
        session.promptStarted = true;
        return new Promise((resolve) => { session.finishPrompt = resolve; });
      },
      steer: async () => {},
      abort: async () => { session.finishPrompt?.(); },
      dispose() {},
    };
    return session;
  });
  const runs = new RunManager(db, agents);
  const queue = new QueueManager(db, runs, 1);
  queue.initialize();
  const app = Fastify();
  registerQueueRoutes(app, queue);
  t.after(async () => { await app.close(); agents.dispose("task-1"); db.close(); });

  const queued = enqueue(queue, "task-1", "INVESTIGATION");
  await waitFor(() => session?.promptStarted === true);
  const stopped = await app.inject({ method: "POST", url: `/api/runs/${queued.run_id}/stop` });
  assert.equal(stopped.statusCode, 200);
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = ?").get(queued.run_id).status === "INTERRUPTED");
  assert.equal(db.prepare("SELECT reason_code FROM task_runs WHERE id = ?").get(queued.run_id).reason_code, "USER_STOPPED");
  assert.equal(db.prepare("SELECT workflow_state, review_tag FROM tasks WHERE id = 'task-1'").get().workflow_state, "REVIEW");
  assert.equal(db.prepare("SELECT review_tag FROM tasks WHERE id = 'task-1'").get().review_tag, "INTERRUPTED");
  assert.equal(db.prepare("SELECT status FROM agent_jobs WHERE id = ?").get(queued.job_id).status, "FINISHED");
});

test("Stop Run during worktree setup prevents the agent prompt from starting", async (t) => {
  const db = makeDb(1);
  const fakeRuns = { start: () => assert.fail("Agent run should not start after Stop Run") };
  let releaseWorktree;
  let signalWorktreeStarted;
  const worktreeStarted = new Promise((resolve) => { signalWorktreeStarted = resolve; });
  const worktrees = {
    createTaskWorktree: () => {
      signalWorktreeStarted();
      return new Promise((resolve) => { releaseWorktree = resolve; });
    },
  };
  const queue = new QueueManager(db, fakeRuns, 1, worktrees);
  queue.initialize();
  const app = Fastify();
  registerQueueRoutes(app, queue);
  t.after(async () => { releaseWorktree?.(); await app.close(); db.close(); });

  const queued = enqueue(queue, "task-1", "INVESTIGATION");
  await worktreeStarted;
  const stopped = await app.inject({ method: "POST", url: `/api/runs/${queued.run_id}/stop` });
  assert.equal(stopped.statusCode, 200);
  releaseWorktree();
  await waitFor(() => db.prepare("SELECT status FROM agent_jobs WHERE id = ?").get(queued.job_id).status === "FINISHED");
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = ?").get(queued.run_id).status, "INTERRUPTED");
  // Nothing reached the model; guidance stays undelivered for explicit reuse.
  assert.equal(db.prepare("SELECT delivery_status FROM run_inputs WHERE run_id = ?").get(queued.run_id).delivery_status, "UNDELIVERED");
});

test("queue dispatches up to maxConcurrentAgents and recovers interrupted claims safely", async (t) => {
  const db = makeDb(3);
  const fakeRuns = makeFakeRuns(db);
  const queue = new QueueManager(db, fakeRuns, 2);
  queue.initialize();
  t.after(() => { for (const release of fakeRuns.releases.values()) release(); db.close(); });

  const first = enqueue(queue, "task-1", "INVESTIGATION");
  const second = enqueue(queue, "task-2", "IMPLEMENTATION");
  const third = enqueue(queue, "task-3", "INVESTIGATION");
  assert.deepEqual(fakeRuns.started, [first.run_id, second.run_id]);
  assert.equal(queue.getSnapshot().active_count, 2);
  fakeRuns.releases.get(first.run_id)();
  await waitFor(() => fakeRuns.started.includes(third.run_id));
  assert.equal(fakeRuns.peak, 2);
  fakeRuns.releases.get(second.run_id)();
  fakeRuns.releases.get(third.run_id)();
  await waitFor(() => queue.getSnapshot().active_count === 0);

  const now = new Date().toISOString();
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('stale-run', 'task-1', 'INVESTIGATION', 2, 'RUNNING')`).run();
  db.prepare(`INSERT INTO agent_jobs (id, task_run_id, queue_position, priority, status, created_at, started_at)
    VALUES ('stale-job', 'stale-run', 1, 0, 'CLAIMED', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content,
    delivery_type, delivery_status, accepted_at) VALUES
    ('stale-pending', 'task-1', 'stale-run', 1, 'stale-pending', 'pending', 'STEERING', 'PENDING', ?),
    ('stale-accepted', 'task-1', 'stale-run', 2, 'stale-accepted', 'accepted', 'STEERING', 'ACCEPTED', ?)`)
    .run(now, now);
  queue.initialize();
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'stale-run'").get().status, "INTERRUPTED");
  assert.equal(db.prepare("SELECT reason_code FROM task_runs WHERE id = 'stale-run'").get().reason_code, "BACKEND_INTERRUPTED");
  assert.equal(db.prepare("SELECT workflow_state FROM tasks WHERE id = 'task-1'").get().workflow_state, "REVIEW");
  assert.equal(db.prepare("SELECT status FROM agent_jobs WHERE id = 'stale-job'").get().status, "FINISHED");
  assert.deepEqual(db.prepare("SELECT id, delivery_status FROM run_inputs WHERE run_id = 'stale-run' ORDER BY sequence").all(), [
    { id: "stale-pending", delivery_status: "UNDELIVERED" },
    { id: "stale-accepted", delivery_status: "DELIVERY_UNKNOWN" },
  ]);
});
