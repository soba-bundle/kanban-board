import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Fastify from "fastify";
import { openDatabase } from "../dist/db.js";
import { QueueManager } from "../dist/queue/queue-manager.js";
import { registerQueueRoutes } from "../dist/queue/queue-routes.js";
import { AgentManager } from "../dist/agents/agent-manager.js";
import { RunManager } from "../dist/agents/run-manager.js";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const piSdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piSdkRoot = dirname(dirname(piSdkEntry));
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(
  piSdkRoot, "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
)).href);

let createKanbanQuestionnaireTool;
let questionnaireToolLoadError;
try {
  ({ createKanbanQuestionnaireTool } = await import("../dist/pi/questionnaire-tool.js"));
} catch (error) {
  questionnaireToolLoadError = error;
}
let HumanRequestService;
let humanRequestServiceLoadError;
try {
  ({ HumanRequestService } = await import("../dist/agents/human-requests.js"));
} catch (error) {
  humanRequestServiceLoadError = error;
}

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

function assistantStream(model, content, stopReason) {
  const message = {
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: stopReason, message });
  stream.end(message);
  return stream;
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

test("a human-waiting run remains parked while a later job uses the released worker slot", async (t) => {
  const db = makeDb(2);
  const now = new Date().toISOString();
  db.prepare("UPDATE tasks SET workflow_state = 'REQUIRES_HUMAN' WHERE id = 'task-1'").run();
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, started_at)
    VALUES ('waiting-run', 'task-1', 'INVESTIGATION', 1, 'WAITING_FOR_HUMAN', ?)`).run(now);
  db.prepare(`INSERT INTO agent_jobs (id, task_run_id, status, created_at)
    VALUES ('waiting-job', 'waiting-run', 'WAITING_FOR_HUMAN', ?)`).run(now);
  db.prepare(`INSERT INTO human_requests (id, task_id, run_id, session_id, tool_call_id, question,
    options_json, status, created_at) VALUES ('request-1', 'task-1', 'waiting-run', 'session-1',
    'call-1', 'Which scope?', '[]', 'PENDING', ?)`).run(now);

  const fakeRuns = makeFakeRuns(db);
  const queue = new QueueManager(db, fakeRuns, 1);
  queue.initialize();
  t.after(async () => {
    for (const release of fakeRuns.releases.values()) release();
    await waitFor(() => queue.getSnapshot().active_count === 0);
    db.close();
  });
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'waiting-run'").get().status, "WAITING_FOR_HUMAN");
  assert.equal(db.prepare("SELECT status FROM human_requests WHERE id = 'request-1'").get().status, "PENDING");
  assert.equal(queue.getSnapshot().active_count, 0);

  const later = enqueue(queue, "task-2", "INVESTIGATION");
  await waitFor(() => fakeRuns.started.includes(later.run_id));
  assert.deepEqual(fakeRuns.started, [later.run_id]);
  assert.equal(queue.getSnapshot().active_count, 1);
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'waiting-run'").get().status, "WAITING_FOR_HUMAN");
});

test("startup queues an answered human continuation after existing work instead of replaying its original prompt", async (t) => {
  const db = makeDb(2);
  const now = new Date().toISOString();
  db.prepare("UPDATE tasks SET workflow_state = 'REQUIRES_HUMAN' WHERE id = 'task-1'").run();
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, session_id)
    VALUES ('restart-run', 'task-1', 'INVESTIGATION', 1, 'QUEUED', 'saved-session')`).run();
  db.prepare(`INSERT INTO agent_jobs (id, task_run_id, queue_position, status, created_at)
    VALUES ('restart-job', 'restart-run', 2, 'QUEUED', ?)`).run(now);
  db.prepare(`INSERT INTO human_requests (id, task_id, run_id, session_id, tool_call_id, question,
    options_json, answer, questions_json, answers_json, status, created_at, answered_at)
    VALUES ('restart-request', 'task-1', 'restart-run', 'saved-session', 'call-1', 'Scope?', '[]', 'small', ?, ?, 'ANSWERED', ?, ?)`)
    .run(JSON.stringify([{ id: "scope", label: "Scope", prompt: "Scope?", options: [], allowOther: true }]),
      JSON.stringify([{ id: "scope", value: "small", label: "small", wasCustom: true }]), now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('earlier-run', 'task-2', 'INVESTIGATION', 1, 'QUEUED')`).run();
  db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content,
    delivery_type, delivery_status, accepted_at)
    VALUES ('earlier-input', 'task-2', 'earlier-run', 1, 'earlier-input', 'Earlier work',
      'INITIAL_PROMPT', 'PENDING', ?)` ).run(now);
  db.prepare(`INSERT INTO agent_jobs (id, task_run_id, queue_position, priority, status, created_at)
    VALUES ('earlier-job', 'earlier-run', 1, 0, 'QUEUED', ?)`).run(now);

  let releaseEarlier;
  const started = [];
  const resumed = [];
  const fakeRuns = {
    start(runId) {
      started.push(runId);
      db.prepare("UPDATE task_runs SET status = 'RUNNING' WHERE id = ?").run(runId);
      return new Promise((resolve) => { releaseEarlier = () => {
        db.prepare("UPDATE task_runs SET status = 'COMPLETED' WHERE id = ?").run(runId);
        resolve();
      }; });
    },
    resumeAfterRestart(runId, requestId) {
      resumed.push({ runId, requestId });
      db.prepare("UPDATE task_runs SET status = 'COMPLETED' WHERE id = ? AND status = 'QUEUED'").run(runId);
      return Promise.resolve();
    },
  };
  const queue = new QueueManager(db, fakeRuns, 1);
  queue.initialize();
  t.after(async () => { releaseEarlier?.(); await waitFor(() => queue.getSnapshot().active_count === 0); db.close(); });

  await waitFor(() => started.includes("earlier-run"));
  assert.deepEqual(resumed, [], "a pre-existing queued job must run before the restored continuation");
  assert.equal(db.prepare("SELECT queue_position FROM agent_jobs WHERE id = 'restart-job'").get().queue_position, 1,
    "once the earlier job is claimed, the continuation is next in queue");
  releaseEarlier();
  await waitFor(() => resumed.length === 1);
  assert.deepEqual(resumed, [{ runId: "restart-run", requestId: "restart-request" }]);
  assert.deepEqual(started, ["earlier-run"], "the original prompt must not be replayed after restart");
  await waitFor(() => db.prepare("SELECT status FROM agent_jobs WHERE id = 'restart-job'").get().status === "FINISHED");
});

test("a hosted AgentSession prompt waits without consuming capacity and resumes once after the queue grants a slot", async (t) => {
  assert.equal(typeof createKanbanQuestionnaireTool, "function",
    `Expected repo-owned questionnaire tool factory; ${questionnaireToolLoadError?.message ?? "export is missing"}`);
  assert.equal(typeof HumanRequestService, "function",
    `Expected HumanRequestService export; ${humanRequestServiceLoadError?.message ?? "export is missing"}`);
  const db = makeDb(2);
  const agentDir = mkdtempSync(join(tmpdir(), "kanban-real-agent-session-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-real-agent-sessions-"));
  const task1Cwd = mkdtempSync(join(tmpdir(), "kanban-human-task-"));
  const task2Cwd = mkdtempSync(join(tmpdir(), "kanban-other-task-"));
  let queue;
  let agents;
  let humanRequests;
  let requestId;
  let releaseOtherProvider;
  const sessions = new Map();
  const streamCalls = [];
  const startCalls = [];
  const startPromises = [];
  const cleanup = async () => {
    releaseOtherProvider?.();
    humanRequests?.cancelForRun("run-human");
    for (const taskId of ["task-1", "task-2"]) await agents?.abort(taskId).catch(() => {});
    for (let i = 0; queue && queue.getSnapshot().active_count > 0 && i < 200; i++) {
      releaseOtherProvider?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(queue?.getSnapshot().active_count ?? 0, 0,
      "test cleanup must not close state while a queue worker is active");
    let timer;
    const runsSettled = await Promise.race([
      Promise.allSettled(startPromises).then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), 1000); }),
    ]);
    clearTimeout(timer);
    assert.equal(runsSettled, true, "cancelled Pi prompts must settle before fixture teardown");
    agents?.dispose("task-1");
    agents?.dispose("task-2");
    db.close();
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(task1Cwd, { recursive: true, force: true });
    rmSync(task2Cwd, { recursive: true, force: true });
  };
  t.after(cleanup);

  db.prepare("UPDATE tasks SET workflow_state = 'IN_PROGRESS', worktree_path = ? WHERE id = 'task-1'").run(task1Cwd);
  db.prepare("UPDATE tasks SET worktree_path = ? WHERE id = 'task-2'").run(task2Cwd);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('run-human', 'task-1', 'INVESTIGATION', 1, 'QUEUED')`).run();
  db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content,
    delivery_type, delivery_status, accepted_at)
    VALUES ('input-human', 'task-1', 'run-human', 1, 'input-human', 'Clarify the scope',
      'INITIAL_PROMPT', 'PENDING', ?)`).run(now);
  db.prepare(`INSERT INTO agent_jobs (id, task_run_id, queue_position, priority, status, created_at)
    VALUES ('job-human', 'run-human', 1, 0, 'QUEUED', ?)`).run(now);

  humanRequests = new HumanRequestService(db, {
    onWaiting: async (request) => {
      requestId = request.id;
      await queue.parkForHuman(request.run_id, request.id);
    },
    onAnswered: (request) => queue.resumeHumanRun(request.run_id, request.id),
  });
  agents = new AgentManager(db, sessionDir, async (cwd, sessionManager, customTools) => {
    const taskId = cwd === task1Cwd ? "task-1" : cwd === task2Cwd ? "task-2" : assert.fail(`Unexpected task cwd ${cwd}`);
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader,
      sessionManager, customTools, tools: ["submit_handover", "kanban_questionnaire"] });
    sessions.set(taskId, session);
    let callNumber = 0;
    session.agent.streamFunction = async (model) => {
      callNumber++;
      streamCalls.push({ taskId, callNumber });
      if (taskId === "task-2" && callNumber === 1) {
        await new Promise((resolve) => { releaseOtherProvider = resolve; });
      }
      if (taskId === "task-1" && callNumber === 1) {
        return assistantStream(model, [{ type: "toolCall", id: "pi-human-call", name: "kanban_questionnaire",
          arguments: { questions: [{ id: "scope", label: "Scope", prompt: "Which scope?", options: [
            { value: "small", label: "Small" }, { value: "large", label: "Large" },
          ], allowOther: true }] } }], "toolUse");
      }
      const callHandover = (taskId === "task-1" && callNumber === 2) || (taskId === "task-2" && callNumber === 1);
      if (callHandover) {
        return assistantStream(model, [{ type: "toolCall", id: `handover-${taskId}`, name: "submit_handover", arguments: {
          stage: "INVESTIGATION", summary: `Finished ${taskId}`, confidence: "HIGH",
          outcome: "Completed the requested investigation", recommended_next_step: "CLOSE",
        } }], "toolUse");
      }
      return assistantStream(model, [{ type: "text", text: `Done ${taskId}` }], "stop");
    };
    return session;
  }, undefined, humanRequests);
  const runs = new RunManager(db, agents, humanRequests);
  const originalStart = runs.start.bind(runs);
  runs.start = (runId, prompt) => {
    startCalls.push(runId);
    const started = originalStart(runId, prompt);
    startPromises.push(started);
    return started;
  };
  queue = new QueueManager(db, runs, 1);
  queue.initialize();

  await waitFor(() => !!requestId && db.prepare("SELECT status FROM agent_jobs WHERE task_run_id = 'run-human'").get()?.status === "WAITING_FOR_HUMAN");
  const pendingRequest = humanRequests.listForTask("task-1").find((request) => request.id === requestId);
  assert.equal(pendingRequest.status, "PENDING");
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'run-human'").get().status, "WAITING_FOR_HUMAN");
  assert.equal(streamCalls.filter((call) => call.taskId === "task-1").length, 1,
    "the Pi prompt must be held inside its pending tool execution");

  const active = enqueue(queue, "task-2", "INVESTIGATION", "Other task continues");
  await waitFor(() => streamCalls.some((call) => call.taskId === "task-2"));
  assert.ok(queue.getSnapshot().jobs.some((job) => job.run_id === active.run_id && job.job_status === "CLAIMED"),
    "another task must own the released worker slot while the Pi tool promise remains pending");
  const submitted = await humanRequests.answer(requestId, [{ id: "scope", value: "large" }]);
  assert.equal(submitted.status, "ANSWERED");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(streamCalls.filter((call) => call.taskId === "task-1").length, 1,
    "accepting an answer must not resume Pi before the competing run releases capacity");
  assert.equal(startCalls.filter((id) => id === "run-human").length, 1,
    "resumption continues the original RunManager operation rather than starting a duplicate run");

  releaseOtherProvider();
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = 'run-human'").get().status === "COMPLETED");
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = ?").get(active.run_id).status === "COMPLETED");
  assert.deepEqual(startCalls, ["run-human", active.run_id]);
  assert.equal(streamCalls.filter((call) => call.taskId === "task-1").length, 3,
    "the same Pi prompt should continue through the answer, handover, and final response");
  const sessionManager = sessions.get("task-1").sessionManager;
  assert.equal(sessionManager.getSessionId(), db.prepare("SELECT session_id FROM task_runs WHERE id = 'run-human'").get().session_id);
  const toolResults = sessionManager.getBranch().filter((entry) => entry.type === "message" &&
    entry.message.role === "toolResult" && entry.message.toolCallId === "pi-human-call");
  assert.equal(toolResults.length, 1, "the resumed Pi loop must append one matching questionnaire result");
  assert.match(JSON.stringify(toolResults[0].message), /Large/);
  const history = agents.historySnapshot("task-1");
  assert.equal(history.entries.filter((entry) => entry.role === "tool" &&
    entry.message.toolCallId === "pi-human-call").length, 1,
    "the actual tool result must be present in persisted Live history");
});

test("a hosted Pi tool execution exercises the HumanRequest and queue scheduler seams", async (t) => {
  assert.equal(typeof createKanbanQuestionnaireTool, "function",
    `Expected repo-owned questionnaire tool factory; ${questionnaireToolLoadError?.message ?? "export is missing"}`);
  assert.equal(typeof HumanRequestService, "function",
    `Expected HumanRequestService export; ${humanRequestServiceLoadError?.message ?? "export is missing"}`);
  const db = makeDb(2);
  const agentDir = mkdtempSync(join(tmpdir(), "kanban-pi-questionnaire-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-pi-questionnaire-session-"));
  let queue;
  let humanRequests;
  let requestId;
  let resolveParked;
  const parked = new Promise((resolve) => { resolveParked = resolve; });
  let releaseOther;
  let session;
  let toolCallPromise;
  let answerToolResult;
  const starts = [];
  const callId = "pi-tool-call-1";
  const cleanup = async () => {
    if (releaseOther) releaseOther();
    resolveParked();
    if (requestId && humanRequests) {
      humanRequests.cancelForRun("run-human");
    }
    await toolCallPromise?.catch(() => {});
    for (let i = 0; queue && queue.getSnapshot().active_count > 0 && i < 100; i++) {
      if (releaseOther) releaseOther();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    session?.dispose();
    db.close();
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  };
  t.after(cleanup);

  const now = new Date().toISOString();
  db.prepare("UPDATE tasks SET workflow_state = 'IN_PROGRESS' WHERE id = 'task-1'").run();
  const sessionManager = SessionManager.create(tmpdir(), sessionDir);
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({ cwd: tmpdir(), agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  humanRequests = new HumanRequestService(db, {
    onWaiting: async (request) => {
      requestId = request.id;
      await queue.parkForHuman(request.run_id, request.id);
      resolveParked();
    },
    onAnswered: (request) => queue.resumeHumanRun(request.run_id, request.id),
  });
  const tool = createKanbanQuestionnaireTool({
    humanRequests, taskId: "task-1", runId: "run-human", sessionId: sessionManager.getSessionId(),
  });
  ({ session } = await createAgentSession({
    cwd: tmpdir(), agentDir, settingsManager, resourceLoader, sessionManager,
    customTools: [tool], tools: ["kanban_questionnaire"],
  }));
  const questions = [{ id: "scope", label: "Scope", prompt: "Which scope?", options: [
    { value: "small", label: "Small" }, { value: "large", label: "Large" },
  ], allowOther: true }];
  const fakeRuns = {
    async start(runId) {
      starts.push(runId);
      if (runId === "run-human" && starts.filter((id) => id === runId).length === 1) {
        db.prepare("UPDATE task_runs SET status = 'RUNNING', session_id = ?, session_file = ? WHERE id = ?")
          .run(session.sessionId, session.sessionFile, runId);
        db.prepare("UPDATE tasks SET working_session_id = ?, working_session_file = ? WHERE id = 'task-1'")
          .run(session.sessionId, session.sessionFile);
        sessionManager.appendMessage({ role: "user", content: "Choose a scope", timestamp: Date.now() });
        sessionManager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: callId,
          name: "kanban_questionnaire", arguments: { questions } }], provider: "test", model: "test",
          api: "openai-completions", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0,
            cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0,
              cacheWrite: 0, total: 0 } }, stopReason: "toolUse" });
        const definition = session.getToolDefinition("kanban_questionnaire");
        toolCallPromise = definition.execute(callId, { questions }, undefined, undefined,
          session.extensionRunner.createContext());
        void toolCallPromise.catch(() => {});
        await parked;
        return;
      }
      if (runId === "run-human") {
        db.prepare("UPDATE task_runs SET status = 'RUNNING' WHERE id = ?").run(runId);
        const answers = await humanRequests.resume(requestId);
        answerToolResult = await toolCallPromise;
        sessionManager.appendMessage({ role: "toolResult", toolCallId: callId, toolName: "kanban_questionnaire",
          content: answerToolResult.content, isError: false, timestamp: Date.now() });
        db.prepare("UPDATE task_runs SET status = 'COMPLETED', completed_at = ? WHERE id = ?")
          .run(new Date().toISOString(), runId);
        assert.deepEqual(answers, [{ id: "scope", value: "large", label: "Large", wasCustom: false, index: 2 }]);
        return;
      }
      db.prepare("UPDATE task_runs SET status = 'RUNNING', started_at = ? WHERE id = ?")
        .run(new Date().toISOString(), runId);
      await new Promise((resolve) => { releaseOther = resolve; });
      db.prepare("UPDATE task_runs SET status = 'COMPLETED', completed_at = ? WHERE id = ?")
        .run(new Date().toISOString(), runId);
    },
  };
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('run-human', 'task-1', 'INVESTIGATION', 1, 'QUEUED')`).run();
  db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content,
    delivery_type, delivery_status, accepted_at)
    VALUES ('input-human', 'task-1', 'run-human', 1, 'input-human', 'Choose a scope',
      'INITIAL_PROMPT', 'PENDING', ?)`).run(now);
  db.prepare(`INSERT INTO agent_jobs (id, task_run_id, queue_position, priority, status, created_at)
    VALUES ('job-human', 'run-human', 1, 0, 'QUEUED', ?)`).run(now);
  queue = new QueueManager(db, fakeRuns, 1);
  queue.initialize();
  await waitFor(() => starts.includes("run-human"));
  const active = enqueue(queue, "task-2", "INVESTIGATION", "Other task");
  await waitFor(() => starts.includes(active.run_id));
  const request = humanRequests.listForTask("task-1").find((item) => item.id === requestId);
  assert.equal(request.status, "PENDING");
  assert.equal(request.tool_call_id, callId);
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'run-human'").get().status, "WAITING_FOR_HUMAN");

  const answered = await humanRequests.answer(request.id, [{ id: "scope", value: "large" }]);
  assert.equal(answered.status, "ANSWERED");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts.filter((id) => id === "run-human").length, 1,
    "the answered tool call must not preempt the task holding the worker slot");
  assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "message" &&
    entry.message.role === "toolResult" && entry.message.toolCallId === callId).length, 0,
    "the provider-visible tool result must remain gated until the continuation is scheduled");

  releaseOther();
  await waitFor(() => starts.filter((id) => id === "run-human").length === 2);
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = 'run-human'").get().status === "COMPLETED");
  const results = sessionManager.getBranch().filter((entry) => entry.type === "message" &&
    entry.message.role === "toolResult" && entry.message.toolCallId === callId);
  assert.equal(results.length, 1);
  assert.match(JSON.stringify(results[0].message), /Large/);
  assert.equal(db.prepare("SELECT session_id FROM task_runs WHERE id = 'run-human'").get().session_id, session.sessionId);
  const persistedLive = new AgentManager(db, sessionDir, async () => assert.fail("history reads must not reopen a provider session"))
    .historySnapshot("task-1");
  assert.equal(persistedLive.entries.filter((entry) => entry.role === "tool" &&
    entry.message.toolCallId === callId).length, 1,
    "the correlated answer must be visible in persisted Live history after the worker completes");
  assert.deepEqual(starts, ["run-human", active.run_id, "run-human"]);
});

test("a live human wait frees capacity and an answered run resumes in queue without preempting another task", async (t) => {
  assert.equal(typeof HumanRequestService, "function",
    `Expected HumanRequestService export; ${humanRequestServiceLoadError?.message ?? "export is missing"}`);
  const db = makeDb(2);
  const calls = [];
  const gates = [];
  let humanRequests;
  let waitingRunId;
  let requestId;
  const fakeRuns = {
    start(runId) {
      calls.push(runId);
      if (runId === waitingRunId && calls.filter((startedRunId) => startedRunId === runId).length === 2) {
        void humanRequests.resume(requestId);
      }
      db.prepare(`UPDATE task_runs SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'QUEUED'`)
        .run(new Date().toISOString(), runId);
      return new Promise((resolve) => gates.push({ runId, release: () => {
        db.prepare(`UPDATE task_runs SET status = 'COMPLETED', completed_at = ? WHERE id = ? AND status = 'RUNNING'`)
          .run(new Date().toISOString(), runId);
        resolve();
      } }));
    },
  };
  let queue;
  humanRequests = new HumanRequestService(db, {
    onWaiting: (request) => queue.parkForHuman(request.run_id, request.id),
    onAnswered: (request) => queue.resumeHumanRun(request.run_id, request.id),
  });
  queue = new QueueManager(db, fakeRuns, 1);
  queue.initialize();
  t.after(async () => {
    for (let attempt = 0; attempt < 100 && queue.getSnapshot().active_count > 0; attempt++) {
      for (const gate of gates) gate.release();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await waitFor(() => queue.getSnapshot().active_count === 0);
    db.close();
  });

  const waiting = enqueue(queue, "task-1", "INVESTIGATION");
  waitingRunId = waiting.run_id;
  const active = enqueue(queue, "task-2", "INVESTIGATION");
  db.prepare("UPDATE task_runs SET session_id = 'same-session' WHERE id = ?").run(waiting.run_id);
  await waitFor(() => calls.includes(waiting.run_id));
  assert.deepEqual(calls, [waiting.run_id]);

  // One questionnaire call persists and parks the current run; another task takes the released slot.
  const waitingAnswers = humanRequests.ask({
    taskId: "task-1", runId: waiting.run_id, sessionId: "same-session", toolCallId: "call-1",
    questions: [{ id: "scope", label: "Scope", prompt: "Which scope?", options: [
      { value: "small", label: "Small" },
    ], allowOther: true }],
  });
  await waitFor(() => calls.includes(active.run_id));
  const [request] = humanRequests.listForTask("task-1");
  requestId = request.id;
  assert.equal(request.status, "PENDING");
  assert.equal(request.tool_call_id, "call-1");
  gates.find((gate) => gate.runId === waiting.run_id).release();
  await waitFor(() => db.prepare("SELECT status FROM agent_jobs WHERE task_run_id = ?").get(waiting.run_id).status === "WAITING_FOR_HUMAN");
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = ?").get(waiting.run_id).status, "WAITING_FOR_HUMAN");
  assert.equal(db.prepare("SELECT workflow_state FROM tasks WHERE id = 'task-1'").get().workflow_state, "REQUIRES_HUMAN");

  const answered = await humanRequests.answer(request.id, [{ id: "scope", value: "small" }]);
  assert.equal(answered.status, "ANSWERED");
  let answerDeliveredToTool = false;
  void waitingAnswers.then(() => { answerDeliveredToTool = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answerDeliveredToTool, false, "an accepted answer stays queued while another run owns capacity");
  assert.equal(calls.filter((runId) => runId === waiting.run_id).length, 1,
    "an answered waiter must not preempt the task that already owns the worker slot");
  assert.equal(queue.getSnapshot().active_count, 1);
  assert.equal(db.prepare("SELECT session_id FROM task_runs WHERE id = ?").get(waiting.run_id).session_id, "same-session");

  gates.find((gate) => gate.runId === active.run_id).release();
  await waitFor(() => calls.filter((runId) => runId === waiting.run_id).length === 2);
  assert.deepEqual(await waitingAnswers, [{ id: "scope", value: "small", label: "Small", wasCustom: false, index: 1 }]);
  assert.equal(db.prepare("SELECT session_id FROM task_runs WHERE id = ?").get(waiting.run_id).session_id, "same-session");
  assert.equal(queue.getSnapshot().active_count, 1);
  gates.filter((gate) => gate.runId === waiting.run_id).at(-1).release();
  await waitFor(() => queue.getSnapshot().active_count === 0);
  assert.deepEqual(calls, [waiting.run_id, active.run_id, waiting.run_id]);
});

test("each Human Request in the same run releases and reacquires queue capacity", async (t) => {
  const db = makeDb(3);
  let queue;
  let humanRequests;
  let firstRequestId;
  let secondRequestId;
  let secondWait;
  let resolveRun;
  const runCompletion = new Promise((resolve) => { resolveRun = resolve; });
  const started = [];
  const releases = new Map();
  const fakeRuns = {
    start(runId) {
      started.push(runId);
      const taskId = db.prepare("SELECT task_id FROM task_runs WHERE id = ?").get(runId).task_id;
      db.prepare("UPDATE task_runs SET status = 'RUNNING' WHERE id = ?").run(runId);
      if (taskId === "task-1") return runCompletion;
      return new Promise((resolve) => releases.set(runId, () => {
        db.prepare("UPDATE task_runs SET status = 'COMPLETED' WHERE id = ?").run(runId);
        resolve();
      }));
    },
    resume(runId, requestId) {
      db.prepare("UPDATE task_runs SET status = 'RUNNING' WHERE id = ? AND status = 'QUEUED'").run(runId);
      db.prepare("UPDATE tasks SET workflow_state = 'IN_PROGRESS' WHERE id = 'task-1'").run();
      humanRequests.resume(requestId);
      if (requestId === firstRequestId) {
        secondWait = humanRequests.ask({
          taskId: "task-1", runId, sessionId: "same-session", toolCallId: "call-2",
          questions: [{ id: "second", label: "Second", prompt: "Second answer?", options: [], allowOther: true }],
        });
      } else {
        void secondWait.then(() => {
          db.prepare("UPDATE task_runs SET status = 'COMPLETED' WHERE id = ?").run(runId);
          resolveRun();
        });
      }
      return runCompletion;
    },
  };
  humanRequests = new HumanRequestService(db, {
    onWaiting: (request) => {
      if (request.tool_call_id === "call-1") firstRequestId = request.id;
      else secondRequestId = request.id;
      queue.parkForHuman(request.run_id, request.id);
    },
    onAnswered: (request) => queue.resumeHumanRun(request.run_id, request.id),
  });
  queue = new QueueManager(db, fakeRuns, 1);
  queue.initialize();
  t.after(async () => {
    for (const release of releases.values()) release();
    resolveRun();
    for (const request of humanRequests.listForTask("task-1")) {
      if (request.status === "PENDING") humanRequests.cancelForRun(request.run_id);
    }
    await waitFor(() => queue.getSnapshot().active_count === 0);
    db.close();
  });

  const waiting = enqueue(queue, "task-1", "INVESTIGATION");
  db.prepare("UPDATE task_runs SET session_id = 'same-session' WHERE id = ?").run(waiting.run_id);
  const question = (toolCallId, id) => humanRequests.ask({
    taskId: "task-1", runId: waiting.run_id, sessionId: "same-session", toolCallId,
    questions: [{ id, label: id, prompt: `${id}?`, options: [], allowOther: true }],
  });
  const firstWait = question("call-1", "first");
  await waitFor(() => db.prepare("SELECT status FROM agent_jobs WHERE task_run_id = ?").get(waiting.run_id).status === "WAITING_FOR_HUMAN");

  const other = enqueue(queue, "task-2", "INVESTIGATION");
  await waitFor(() => started.includes(other.run_id));
  await humanRequests.answer(firstRequestId, [{ id: "first", value: "one" }]);
  releases.get(other.run_id)();
  await waitFor(() => secondRequestId && db.prepare("SELECT status FROM agent_jobs WHERE task_run_id = ?").get(waiting.run_id).status === "WAITING_FOR_HUMAN");
  assert.equal(started.filter((runId) => runId === waiting.run_id).length, 1,
    "a second Human Request parks the original execution without starting another prompt");

  const next = enqueue(queue, "task-3", "INVESTIGATION");
  await waitFor(() => started.includes(next.run_id));
  await humanRequests.answer(secondRequestId, [{ id: "second", value: "two" }]);
  releases.get(next.run_id)();
  await Promise.all([firstWait, secondWait]);
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = ?").get(waiting.run_id).status === "COMPLETED");
  assert.equal(started.filter((runId) => runId === waiting.run_id).length, 1);
  await waitFor(() => queue.getSnapshot().active_count === 0);
});

test("Stop removes an answered continuation queued behind another task before it can call Pi", async (t) => {
  const db = makeDb(2);
  const now = new Date().toISOString();
  db.prepare("UPDATE tasks SET workflow_state = 'REQUIRES_HUMAN' WHERE id = 'task-1'").run();
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, session_id)
    VALUES ('waiting-run', 'task-1', 'INVESTIGATION', 1, 'QUEUED', 'same-session')`).run();
  db.prepare(`INSERT INTO agent_jobs (id, task_run_id, queue_position, status, created_at)
    VALUES ('waiting-job', 'waiting-run', 2, 'QUEUED', ?)`).run(now);
  const columns = db.prepare("PRAGMA table_info(human_requests)").all().map((column) => column.name);
  assert.ok(columns.includes("questions_json") && columns.includes("answers_json"), "requires migration 8");
  db.prepare(`INSERT INTO human_requests (id, task_id, run_id, session_id, tool_call_id, question,
    options_json, answer, questions_json, answers_json, status, created_at, answered_at)
    VALUES ('request-1', 'task-1', 'waiting-run', 'same-session', 'call-1', '', '[]', NULL, ?, ?, 'ANSWERED', ?, ?)`)
    .run(JSON.stringify([{ id: "scope", prompt: "Which scope?", options: [], allowOther: true }]),
      JSON.stringify([{ id: "scope", value: "small", label: "Small", wasCustom: false, index: 1 }]), now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('active-run', 'task-2', 'INVESTIGATION', 1, 'QUEUED')`).run();
  db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content,
    delivery_type, delivery_status, accepted_at)
    VALUES ('active-input', 'task-2', 'active-run', 1, 'active-input', 'Active work', 'INITIAL_PROMPT', 'PENDING', ?)`)
    .run(now);
  db.prepare(`INSERT INTO agent_jobs (id, task_run_id, queue_position, priority, status, created_at)
    VALUES ('active-job', 'active-run', 1, 0, 'QUEUED', ?)`).run(now);

  const fakeRuns = makeFakeRuns(db);
  const queue = new QueueManager(db, fakeRuns, 1);
  queue.initialize();
  const app = Fastify();
  registerQueueRoutes(app, queue);
  t.after(async () => {
    for (const release of fakeRuns.releases.values()) release();
    await app.close();
    db.close();
  });
  const active = { run_id: "active-run" };
  await waitFor(() => fakeRuns.started.includes(active.run_id));
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'waiting-run'").get().status, "QUEUED");
  assert.equal(fakeRuns.started.includes("waiting-run"), false);

  const stopped = await app.inject({ method: "POST", url: "/api/runs/waiting-run/stop" });
  assert.equal(stopped.statusCode, 200);
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'waiting-run'").get().status, "INTERRUPTED");
  assert.equal(db.prepare("SELECT workflow_state || ':' || review_tag AS state FROM tasks WHERE id = 'task-1'").get().state,
    "REVIEW:INTERRUPTED");
  assert.equal(db.prepare("SELECT status FROM human_requests WHERE id = 'request-1'").get().status, "ANSWERED",
    "Stop interrupts the queued run without rewriting the already committed answer");
  fakeRuns.releases.get(active.run_id)();
  await waitFor(() => queue.getSnapshot().active_count === 0);
  assert.deepEqual(fakeRuns.started, [active.run_id], "the stopped continuation must never be dispatched to Pi");
});

test("Stop Run cancels an unanswered human request without requiring a running provider call", async (t) => {
  const db = makeDb(1);
  const now = new Date().toISOString();
  db.prepare("UPDATE tasks SET workflow_state = 'REQUIRES_HUMAN' WHERE id = 'task-1'").run();
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, started_at)
    VALUES ('waiting-run', 'task-1', 'INVESTIGATION', 1, 'WAITING_FOR_HUMAN', ?)`).run(now);
  db.prepare(`INSERT INTO agent_jobs (id, task_run_id, status, created_at)
    VALUES ('waiting-job', 'waiting-run', 'WAITING_FOR_HUMAN', ?)`).run(now);
  db.prepare(`INSERT INTO human_requests (id, task_id, run_id, session_id, tool_call_id, question,
    options_json, status, created_at) VALUES ('request-1', 'task-1', 'waiting-run', 'session-1',
    'call-1', 'Which scope?', '[]', 'PENDING', ?)`).run(now);

  const queue = new QueueManager(db, { start: async () => assert.fail("No provider call should be needed to stop a waiter.") }, 1);
  queue.initialize();
  const app = Fastify();
  registerQueueRoutes(app, queue);
  t.after(async () => { await app.close(); db.close(); });

  const stopped = await app.inject({ method: "POST", url: "/api/runs/waiting-run/stop" });
  assert.equal(stopped.statusCode, 200);
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'waiting-run'").get().status, "INTERRUPTED");
  assert.equal(db.prepare("SELECT status FROM human_requests WHERE id = 'request-1'").get().status, "CANCELLED");
  assert.equal(db.prepare("SELECT workflow_state || ':' || review_tag AS state FROM tasks WHERE id = 'task-1'").get().state,
    "REVIEW:INTERRUPTED");
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
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('orphan-run', 'task-2', 'INVESTIGATION', 2, 'RUNNING')`).run();
  db.prepare(`INSERT INTO agent_jobs (id, task_run_id, status, created_at, completed_at)
    VALUES ('orphan-job', 'orphan-run', 'FINISHED', ?, ?)`).run(now, now);
  queue.initialize();
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'stale-run'").get().status, "INTERRUPTED");
  assert.equal(db.prepare("SELECT reason_code FROM task_runs WHERE id = 'stale-run'").get().reason_code, "BACKEND_INTERRUPTED");
  assert.equal(db.prepare("SELECT workflow_state FROM tasks WHERE id = 'task-1'").get().workflow_state, "REVIEW");
  assert.equal(db.prepare("SELECT status FROM agent_jobs WHERE id = 'stale-job'").get().status, "FINISHED");
  assert.deepEqual(db.prepare("SELECT id, delivery_status FROM run_inputs WHERE run_id = 'stale-run' ORDER BY sequence").all(), [
    { id: "stale-pending", delivery_status: "UNDELIVERED" },
    { id: "stale-accepted", delivery_status: "DELIVERY_UNKNOWN" },
  ]);
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'orphan-run'").get().status, "INTERRUPTED",
    "an orphan RUNNING run must be recovered even when its job is already FINISHED");
});
