import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../dist/db.js";
import { AgentManager } from "../dist/agents/agent-manager.js";
import { RunInputReconciler } from "../dist/agents/run-input-reconciler.js";
import { buildRunPrompt } from "../dist/agents/prompt-builder.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

function makeRecoveryDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "kanban-phase11-recovery-"));
  const db = openDatabase(join(dir, "kanban.sqlite"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Recovery task', '', 'IN_PROGRESS', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, input_mode, session_id,
    transcript_end_entry_id)
    VALUES ('run-1', 'task-1', 'WORK', 1, 'RUNNING', 'STEERING', 'session-1', 'boundary-0')`).run();
  return db;
}

function addInput(db, {
  id = "input-1",
  status = "PENDING",
  content = "Inspect the parser",
  deliveryType = "STEERING",
  boundary = "boundary-0",
  sessionSequence = 1,
  deliveryIntentAt = null,
  sessionId = "session-1",
} = {}) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content,
    delivery_type, delivery_status, accepted_at, delivery_intent_at, session_id,
    session_sequence, transcript_boundary_entry_id)
    VALUES (?, 'task-1', 'run-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, sessionSequence, id, content, deliveryType, status, now, deliveryIntentAt, sessionId, sessionSequence, boundary);
}

function addTranscriptEntry(db, { entryId, sequence = 1, runId = "run-1", sessionId = "session-1" } = {}) {
  db.prepare(`INSERT INTO run_transcript_entries (session_id, entry_id, run_id, sequence)
    VALUES (?, ?, ?, ?)`).run(sessionId, entryId, runId, sequence);
}

async function recover(db, branch) {
  const reconciler = new RunInputReconciler(db, async () => ({ sessionId: "session-1", branch }));
  await reconciler.reconcileAfterRestart();
}

function boundaryEntry() {
  return { id: "boundary-0", type: "message", message: { role: "assistant", content: [] } };
}

function userEntry(id, text) {
  return { id, type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

test("crash before the Pi call leaves guidance explicitly undelivered", async (t) => {
  const db = makeRecoveryDb(t);
  addInput(db);

  await recover(db, [boundaryEntry()]);

  assert.deepEqual(db.prepare(`SELECT delivery_status, transcript_entry_id FROM run_inputs
    WHERE id = 'input-1'`).get(), {
    delivery_status: "UNDELIVERED",
    transcript_entry_id: null,
  });
  db.close();
});

test("crash after the Pi call but before transcript append makes delivery unknown", async (t) => {
  const db = makeRecoveryDb(t);
  addInput(db, { deliveryIntentAt: new Date().toISOString() });

  await recover(db, [boundaryEntry()]);

  assert.equal(db.prepare("SELECT delivery_status FROM run_inputs WHERE id = 'input-1'").get().delivery_status,
    "DELIVERY_UNKNOWN");
  db.close();
});

test("crash after transcript append but before delivery metadata records the unique entry", async (t) => {
  const db = makeRecoveryDb(t);
  addInput(db, { deliveryIntentAt: new Date().toISOString() });
  addTranscriptEntry(db, { entryId: "steering-entry-1" });

  await recover(db, [boundaryEntry(), userEntry("steering-entry-1", "Inspect the parser")]);

  assert.deepEqual(db.prepare(`SELECT delivery_status, transcript_entry_id FROM run_inputs
    WHERE id = 'input-1'`).get(), {
    delivery_status: "DELIVERED",
    transcript_entry_id: "steering-entry-1",
  });
  db.close();
});

test("ambiguous or off-branch transcript evidence remains delivery unknown", async (t) => {
  const db = makeRecoveryDb(t);
  addInput(db, { deliveryIntentAt: new Date().toISOString() });
  addTranscriptEntry(db, { entryId: "entry-from-other-branch", sessionId: "session-2" });
  addTranscriptEntry(db, { entryId: "another-matching-entry", sequence: 2 });

  await recover(db, [boundaryEntry(), userEntry("external-entry", "External user message"),
    userEntry("another-matching-entry", "Inspect the parser")]);

  assert.equal(db.prepare("SELECT delivery_status FROM run_inputs WHERE id = 'input-1'").get().delivery_status,
    "DELIVERY_UNKNOWN");
  assert.equal(db.prepare("SELECT transcript_entry_id FROM run_inputs WHERE id = 'input-1'").get().transcript_entry_id,
    null);
  db.close();
});

test("bundled initial and queued inputs recover from one combined Pi entry", async (t) => {
  const db = makeRecoveryDb(t);
  const intent = new Date().toISOString();
  addInput(db, { id: "initial-1", content: "Initial request", deliveryType: "INITIAL_PROMPT", deliveryIntentAt: intent });
  addInput(db, { id: "queued-1", content: "Additional guidance", deliveryType: "QUEUED_INPUT", sessionSequence: 2, deliveryIntentAt: intent });
  const expected = buildRunPrompt(db, "run-1").text;
  const entryId = "combined-prompt-entry";

  await recover(db, [boundaryEntry(), userEntry(entryId, expected)]);

  assert.deepEqual(db.prepare(`SELECT id, delivery_status, transcript_entry_id FROM run_inputs
    WHERE run_id = 'run-1' ORDER BY sequence`).all(), [
    { id: "initial-1", delivery_status: "DELIVERED", transcript_entry_id: entryId },
    { id: "queued-1", delivery_status: "DELIVERED", transcript_entry_id: entryId },
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM run_transcript_entries WHERE run_id = 'run-1'").get().count, 1);
  db.close();
});

test("reconciliation reads the restored AgentManager active branch", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-phase11-agent-"));
  const sessionDir = join(dir, "sessions");
  const db = openDatabase(join(dir, "kanban.sqlite"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Recovery task', '', 'IN_PROGRESS', ?, ?)`).run(now, now);
  const sessionManager = SessionManager.create(tmpdir(), sessionDir);
  const boundaryId = sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "prior" }],
    provider: "test", model: "test", api: "openai-completions", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" });
  const inputEntryId = sessionManager.appendMessage({ role: "user", content: "Inspect the parser", timestamp: Date.now() });
  db.prepare("UPDATE tasks SET working_session_id = ?, working_session_file = ? WHERE id = 'task-1'")
    .run(sessionManager.getSessionId(), sessionManager.getSessionFile());
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, input_mode, session_id, session_file,
    transcript_end_entry_id) VALUES ('run-1', 'task-1', 'WORK', 1, 'RUNNING', 'STEERING', ?, ?, ?)`)
    .run(sessionManager.getSessionId(), sessionManager.getSessionFile(), boundaryId);
  addInput(db, { deliveryIntentAt: now, boundary: boundaryId, sessionId: sessionManager.getSessionId() });
  const agents = new AgentManager(db, sessionDir, async (_cwd, manager) => ({
    sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), sessionManager: manager,
    prompt: async () => {}, steer: async () => {}, abort: async () => {}, subscribe: () => () => {}, dispose: () => {},
  }));
  t.after(() => agents.dispose("task-1"));

  const reconciler = new RunInputReconciler(db, (taskId) => agents.inspectWorkingBranch(taskId));
  await reconciler.reconcileAfterRestart();

  assert.deepEqual(db.prepare("SELECT delivery_status, transcript_entry_id FROM run_inputs WHERE id = 'input-1'").get(), {
    delivery_status: "DELIVERED", transcript_entry_id: inputEntryId,
  });
});

test("repeated restart reconciliation is idempotent and never resends guidance", async (t) => {
  const db = makeRecoveryDb(t);
  addInput(db, { deliveryIntentAt: new Date().toISOString() });
  addTranscriptEntry(db, { entryId: "steering-entry-1" });
  const branch = [boundaryEntry(), userEntry("steering-entry-1", "Inspect the parser")];

  await recover(db, branch);
  const first = db.prepare(`SELECT delivery_status, transcript_entry_id, failure_reason
    FROM run_inputs WHERE id = 'input-1'`).get();
  await recover(db, branch);
  const second = db.prepare(`SELECT delivery_status, transcript_entry_id, failure_reason
    FROM run_inputs WHERE id = 'input-1'`).get();

  assert.deepEqual(second, first);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM run_transcript_entries WHERE run_id = 'run-1'").get().count, 1);
  db.close();
});
