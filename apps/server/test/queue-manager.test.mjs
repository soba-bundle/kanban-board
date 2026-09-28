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

  const first = queue.enqueueTask("task-1", "INVESTIGATION");
  const second = queue.enqueueTask("task-2", "IMPLEMENTATION");
  const third = queue.enqueueTask("task-3", "INVESTIGATION");
  assert.deepEqual(fakeRuns.started, [first.run_id]);
  assert.equal(queue.getSnapshot().active_count, 1);

  queue.reorder(third.job_id, 1);
  assert.deepEqual(queue.getSnapshot().jobs.filter((job) => job.job_status === "QUEUED").map((job) => job.job_id), [third.job_id, second.job_id]);
  queue.remove(second.job_id);
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = ?").get(second.run_id).status, "CANCELLED");
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
  queue.enqueueTask("task-2", "INVESTIGATION");
  const queued = queue.enqueueTask("task-1", "INVESTIGATION");
  assert.equal(db.prepare("SELECT workflow_state FROM tasks WHERE id = 'task-1'").get().workflow_state, "IN_PROGRESS");
  queue.remove(queued.job_id);
  assert.deepEqual(db.prepare("SELECT workflow_state, review_tag FROM tasks WHERE id = 'task-1'").get(), {
    workflow_state: "REVIEW", review_tag: "IMPLEMENTATION_COMPLETE",
  });
});

test("queue routes enqueue tasks and expose the global queue snapshot", async (t) => {
  const db = makeDb(1);
  const fakeRuns = makeFakeRuns(db);
  const queue = new QueueManager(db, fakeRuns, 1);
  queue.initialize();
  const app = Fastify();
  registerQueueRoutes(app, queue);
  t.after(async () => { for (const release of fakeRuns.releases.values()) release(); await app.close(); db.close(); });

  const invalid = await app.inject({ method: "POST", url: "/api/tasks/task-1/queue", payload: { stage: "VALIDATION_REVIEW" } });
  assert.equal(invalid.statusCode, 400);
  const enqueued = await app.inject({ method: "POST", url: "/api/tasks/task-1/queue", payload: { stage: "INVESTIGATION" } });
  assert.equal(enqueued.statusCode, 201);
  assert.ok(enqueued.json().run_id);
  const snapshot = await app.inject({ method: "GET", url: "/api/queue" });
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.json().max_concurrent_agents, 1);
  assert.equal(snapshot.json().active_count, 1);
  assert.equal(snapshot.json().jobs[0].task_id, "task-1");
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

  const queued = queue.enqueueTask("task-1", "INVESTIGATION");
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

  db.prepare(`INSERT INTO ticket_comments (id, task_id, author_type, content, delivery_status, created_at)
    VALUES ('c-1', 'task-1', 'USER', 'undelivered note', 'PENDING', ?)`).run(new Date().toISOString());
  const queued = queue.enqueueTask("task-1", "INVESTIGATION");
  await worktreeStarted;
  const stopped = await app.inject({ method: "POST", url: `/api/runs/${queued.run_id}/stop` });
  assert.equal(stopped.statusCode, 200);
  releaseWorktree();
  await waitFor(() => db.prepare("SELECT status FROM agent_jobs WHERE id = ?").get(queued.job_id).status === "FINISHED");
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = ?").get(queued.run_id).status, "INTERRUPTED");
  // Nothing reached the model, so the comment must still be pending for the next run.
  assert.equal(db.prepare("SELECT delivery_status FROM ticket_comments WHERE id = 'c-1'").get().delivery_status, "PENDING");
});

test("queue dispatches up to maxConcurrentAgents and recovers interrupted claims safely", async (t) => {
  const db = makeDb(3);
  const fakeRuns = makeFakeRuns(db);
  const queue = new QueueManager(db, fakeRuns, 2);
  queue.initialize();
  t.after(() => { for (const release of fakeRuns.releases.values()) release(); db.close(); });

  const first = queue.enqueueTask("task-1", "INVESTIGATION");
  const second = queue.enqueueTask("task-2", "IMPLEMENTATION");
  const third = queue.enqueueTask("task-3", "INVESTIGATION");
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
  queue.initialize();
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'stale-run'").get().status, "INTERRUPTED");
  assert.equal(db.prepare("SELECT reason_code FROM task_runs WHERE id = 'stale-run'").get().reason_code, "BACKEND_INTERRUPTED");
  assert.equal(db.prepare("SELECT workflow_state FROM tasks WHERE id = 'task-1'").get().workflow_state, "REVIEW");
  assert.equal(db.prepare("SELECT status FROM agent_jobs WHERE id = 'stale-job'").get().status, "FINISHED");
});
