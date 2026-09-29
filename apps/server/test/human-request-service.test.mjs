import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../dist/db.js";

let HumanRequestService;
let serviceLoadError;
try {
  ({ HumanRequestService } = await import("../dist/agents/human-requests.js"));
} catch (error) {
  serviceLoadError = error;
}

function makeDb() {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', '', 'IN_PROGRESS', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('run-1', 'task-1', 'INVESTIGATION', 1, 'RUNNING')`).run();
  return db;
}

test("HumanRequestService parks durable questions, validates batch answers, and resumes only when scheduled", async (t) => {
  assert.equal(typeof HumanRequestService, "function",
    `Expected HumanRequestService export; ${serviceLoadError?.message ?? "export is missing"}`);
  const db = makeDb();
  t.after(() => db.close());
  const resumed = [];
  const parked = [];
  let enterSecondAnswer;
  const secondAnswerEntered = new Promise((resolve) => { enterSecondAnswer = resolve; });
  let releaseSecondAnswer;
  const secondAnswerGate = new Promise((resolve) => { releaseSecondAnswer = resolve; });
  const service = new HumanRequestService(db, {
    onWaiting: async (request) => { parked.push(request.id); },
    onAnswered: async (request) => {
      resumed.push(request.id);
      if (request.tool_call_id === "tool-call-2") {
        enterSecondAnswer();
        await secondAnswerGate;
      }
    },
  });
  const questions = [
    {
      id: "scope", label: "Scope", prompt: "Which scope?",
      options: [{ value: "small", label: "Small" }], allowOther: true,
    },
    {
      id: "risk", label: "Risk", prompt: "Accept the risk?",
      options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }], allowOther: false,
    },
  ];

  const waiting = service.ask({
    taskId: "task-1", runId: "run-1", sessionId: "session-1", toolCallId: "tool-call-1", questions,
  });
  const [request] = service.listForTask("task-1");
  assert.ok(request.id);
  assert.equal(request.status, "PENDING");
  assert.deepEqual(request.questions, questions);
  assert.deepEqual(parked, [request.id]);

  await assert.rejects(service.answer(request.id, [{ id: "scope", value: "small" }]), /answer every question/i);
  await assert.rejects(service.answer(request.id, [
    { id: "scope", value: "small" }, { id: "risk", value: "custom risk" },
  ]), /allowed option|not allowed/i);
  assert.equal(service.listForTask("task-1")[0].status, "PENDING");

  const expectedAnswers = [
    { id: "scope", value: "a custom scope", label: "a custom scope", wasCustom: true },
    { id: "risk", value: "no", label: "No", wasCustom: false, index: 2 },
  ];
  const submitted = await service.answer(request.id, [
    { id: "scope", value: "a custom scope" }, { id: "risk", value: "no" },
  ]);
  assert.equal(submitted.status, "ANSWERED");
  assert.deepEqual(submitted.answers, expectedAnswers);
  assert.deepEqual(resumed, [request.id], "accepting an answer queues exactly one continuation");
  const stored = db.prepare("SELECT status, answers_json, answered_at FROM human_requests WHERE id = ?").get(request.id);
  assert.equal(stored.status, "ANSWERED");
  assert.deepEqual(JSON.parse(stored.answers_json), expectedAnswers);
  assert.ok(stored.answered_at);

  let firstWaitResolved = false;
  void waiting.then(() => { firstWaitResolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstWaitResolved, false, "the tool must remain parked until the queue grants a worker slot");
  const duplicate = await service.answer(request.id, [
    { id: "scope", value: "a custom scope" }, { id: "risk", value: "no" },
  ]);
  assert.deepEqual(duplicate.answers, expectedAnswers);
  await assert.rejects(service.answer(request.id, [
    { id: "scope", value: "small" }, { id: "risk", value: "no" },
  ]), /already answered|different answer/i);
  assert.deepEqual(resumed, [request.id], "an idempotent retry must not schedule the continuation twice");
  await service.resume(request.id);
  assert.deepEqual(await waiting, expectedAnswers);

  const waitingAgain = service.ask({
    taskId: "task-1", runId: "run-1", sessionId: "session-1", toolCallId: "tool-call-2", questions,
  });
  const secondRequest = service.listForTask("task-1").find((item) => item.tool_call_id === "tool-call-2");
  const answering = service.answer(secondRequest.id, [
    { id: "scope", value: "small" }, { id: "risk", value: "yes" },
  ]);
  await secondAnswerEntered;
  await service.cancelForRun("run-1");
  assert.equal(service.listForTask("task-1").find((item) => item.id === secondRequest.id).status, "ANSWERED",
    "Stop must not overwrite a committed answer while continuation scheduling is in flight");
  await assert.rejects(waitingAgain, /cancelled|stopped/i);
  releaseSecondAnswer();
  assert.equal((await answering).status, "ANSWERED");

  const waitingCancelled = service.ask({
    taskId: "task-1", runId: "run-1", sessionId: "session-1", toolCallId: "tool-call-3", questions,
  }).catch((error) => error);
  const cancelledRequest = service.listForTask("task-1").find((item) => item.tool_call_id === "tool-call-3");
  await service.cancelForRun("run-1");
  assert.equal(service.listForTask("task-1").find((item) => item.id === cancelledRequest.id).status, "CANCELLED");
  await assert.rejects(service.answer(cancelledRequest.id, [
    { id: "scope", value: "small" }, { id: "risk", value: "no" },
  ]), /cancelled/i);
  assert.match((await waitingCancelled).message, /cancelled/i);
});

test("HumanRequestService reads legacy single-question rows after migration", (t) => {
  assert.equal(typeof HumanRequestService, "function",
    `Expected HumanRequestService export; ${serviceLoadError?.message ?? "export is missing"}`);
  const db = makeDb();
  t.after(() => db.close());
  db.prepare(`INSERT INTO human_requests (id, task_id, run_id, session_id, tool_call_id, question,
    options_json, answer, status, created_at, answered_at)
    VALUES ('legacy-request', 'task-1', 'run-1', 'session-1', 'legacy-call', 'Choose a scope',
      '["Small","Large"]', 'Large', 'ANSWERED', ?, ?)`)
    .run(new Date().toISOString(), new Date().toISOString());
  db.prepare(`INSERT INTO human_requests (id, task_id, run_id, session_id, tool_call_id, question,
    options_json, answer, status, created_at, answered_at)
    VALUES ('legacy-custom', 'task-1', 'run-1', 'session-1', 'legacy-call-2', 'Choose a scope',
      '["Small","Large"]', 'Custom', 'ANSWERED', ?, ?)`)
    .run(new Date().toISOString(), new Date().toISOString());
  const service = new HumanRequestService(db, { onWaiting: async () => {}, onAnswered: async () => {} });
  const requests = service.listForTask("task-1");
  const request = requests.find((item) => item.id === "legacy-request");
  assert.equal(request.questions[0].id, "legacy-legacy-request");
  assert.deepEqual(request.questions[0].options, [
    { value: "Small", label: "Small" }, { value: "Large", label: "Large" },
  ]);
  assert.deepEqual(request.answers, [
    { id: "legacy-legacy-request", value: "Large", label: "Large", wasCustom: false, index: 2 },
  ]);
  const custom = requests.find((item) => item.id === "legacy-custom");
  assert.equal(custom.questions[0].allowOther, true,
    "a persisted legacy custom answer implies that free text was accepted");
  assert.deepEqual(custom.answers, [
    { id: "legacy-legacy-custom", value: "Custom", label: "Custom", wasCustom: true },
  ]);
});
