import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { openDatabase } from "../dist/db.js";
import { AgentManager } from "../dist/agents/agent-manager.js";
import { registerLiveEventRoutes } from "../dist/agents/live-event-routes.js";

const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function appendMessage(manager, role, text) {
  const message = role === "user"
    ? { role, content: [{ type: "text", text }], timestamp: Date.now() }
    : {
      role, content: [{ type: "text", text }], provider: "test", model: "test", api: "openai-completions",
      timestamp: Date.now(), usage, stopReason: "stop",
    };
  return manager.appendMessage(message);
}

function seed(db) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  for (const id of ["task-1", "task-2"]) {
    db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
      VALUES (?, 'project-1', ?, '', 'IN_PROGRESS', ?, ?)`).run(id, id, now, now);
  }
}

function createAgents(db, sessionDir, replayLimit = 2000) {
  const managers = new Map();
  const agents = new AgentManager(db, sessionDir, async (_cwd, manager) => {
    managers.set(manager.getSessionId(), manager);
    return {
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
      sessionManager: manager,
      prompt: async () => {},
      steer: async () => {},
      abort: async () => {},
      subscribe: () => () => {},
      dispose() {},
    };
  }, replayLimit);
  return { agents, managers };
}

test("Live history reconstructs the active Pi branch after manager restart and scopes entries to each task", async (t) => {
  const db = openDatabase(":memory:");
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-live-history-"));
  t.after(() => { db.close(); rmSync(sessionDir, { recursive: true, force: true }); });
  seed(db);
  const { agents, managers } = createAgents(db, sessionDir);
  t.after(() => agents.dispose("task-1"));

  const task1Session = await agents.getOrCreateWorkingSession("task-1");
  const manager1 = managers.get(task1Session.sessionId);
  const firstUserId = appendMessage(manager1, "user", "check the parser");
  const assistantId = appendMessage(manager1, "assistant", "parser checked");
  const toolCallId = manager1.appendMessage({
    role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "read_file", arguments: { path: "a.ts" } }],
    provider: "test", model: "test", api: "openai-completions", timestamp: Date.now(), usage, stopReason: "toolUse",
  });
  manager1.appendMessage({ role: "tool", toolCallId: "tool-1", toolName: "read_file", content: "source text", timestamp: Date.now() });
  const end1 = manager1.getLeafId();
  const secondRunUserId = appendMessage(manager1, "user", "also inspect the fallback");
  const secondRunAssistantId = appendMessage(manager1, "assistant", "fallback inspected");
  const end2 = manager1.getLeafId();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, session_id, session_file,
    transcript_start_entry_id, transcript_end_entry_id)
    VALUES ('run-1', 'task-1', 'INVESTIGATION', 1, 'COMPLETED', ?, ?, NULL, ?)`)
    .run(task1Session.sessionId, task1Session.sessionFile, end1);
  db.prepare(`INSERT INTO run_inputs (id, task_id, run_id, sequence, idempotency_key, content, delivery_type,
    delivery_status, accepted_at, session_id, transcript_entry_id)
    VALUES ('input-1', 'task-1', 'run-1', 1, 'input-1', 'check the parser', 'INITIAL_PROMPT',
      'DELIVERED', ?, ?, ?)`)
    .run(now, task1Session.sessionId, firstUserId);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, session_id, session_file,
    transcript_start_entry_id, transcript_end_entry_id)
    VALUES ('run-1-next', 'task-1', 'IMPLEMENTATION', 2, 'COMPLETED', ?, ?, ?, ?)`)
    .run(task1Session.sessionId, task1Session.sessionFile, end1, end2);
  const recordEntry = db.prepare(`INSERT INTO run_transcript_entries (session_id, entry_id, run_id, sequence)
    VALUES (?, ?, 'run-1', ?)`);
  [firstUserId, assistantId, toolCallId, end1].forEach((entryId, index) =>
    recordEntry.run(task1Session.sessionId, entryId, index + 1));

  const task2Session = await agents.getOrCreateWorkingSession("task-2");
  const manager2 = managers.get(task2Session.sessionId);
  appendMessage(manager2, "user", "other ticket only");
  const task2End = manager2.getLeafId();
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, session_id, session_file,
    transcript_start_entry_id, transcript_end_entry_id)
    VALUES ('run-2', 'task-2', 'INVESTIGATION', 1, 'COMPLETED', ?, ?, NULL, ?)`)
    .run(task2Session.sessionId, task2Session.sessionFile, task2End);

  const app = Fastify();
  await registerLiveEventRoutes(app, db, agents);
  await app.ready();
  t.after(async () => { await app.close(); });
  const response = await app.inject({ method: "GET", url: "/api/tasks/task-1/live/history" });
  assert.equal(response.statusCode, 200);
  const snapshot = response.json();
  assert.deepEqual(snapshot.entries.map((entry) => entry.entry_id), [
    firstUserId, assistantId, toolCallId, end1, secondRunUserId, secondRunAssistantId,
  ]);
  assert.deepEqual(snapshot.entries.map((entry) => entry.run_id), [
    "run-1", "run-1", "run-1", "run-1", "run-1-next", "run-1-next",
  ]);
  assert.deepEqual(snapshot.entries.map((entry) => entry.role), ["user", "assistant", "assistant", "tool", "user", "assistant"]);
  assert.equal(snapshot.inputs[0].transcript_entry_id, firstUserId);
  assert.equal(JSON.stringify(snapshot).includes("other ticket only"), false);

  agents.dispose("task-1");
  agents.dispose("task-2");
  const restored = createAgents(db, sessionDir).agents;
  const restoredSnapshot = restored.historySnapshot("task-1");
  assert.deepEqual(restoredSnapshot.entries.map((entry) => entry.id), snapshot.entries.map((entry) => entry.id));
  assert.equal(JSON.stringify(restoredSnapshot).includes("source text"), true);
  assert.equal(JSON.stringify(restoredSnapshot).includes("other ticket only"), false);

  const restoredSession = await restored.getOrCreateWorkingSession("task-1");
  restoredSession.sessionManager.branch(firstUserId);
  const branchEntryId = appendMessage(restoredSession.sessionManager, "assistant", "new active branch response");
  const branched = restored.historySnapshot("task-1");
  assert.deepEqual(branched.entries.map((entry) => entry.entry_id), [firstUserId, branchEntryId]);
  assert.deepEqual(branched.entries.map((entry) => entry.run_id), ["run-1", null]);
  restored.dispose("task-1");
});

test("completed history snapshots retain Pi compaction summaries after manager restart", async (t) => {
  const db = openDatabase(":memory:");
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-live-history-"));
  t.after(() => { db.close(); rmSync(sessionDir, { recursive: true, force: true }); });
  seed(db);
  const { agents, managers } = createAgents(db, sessionDir);
  const session = await agents.getOrCreateWorkingSession("task-1");
  const manager = managers.get(session.sessionId);
  appendMessage(manager, "user", "Keep the chosen reserve setting.");
  const assistantEntryId = appendMessage(manager, "assistant", "Using the native reserve.");
  const expectedSummary = "Decision: keep Pi's native reserveTokens; next: verify Live history.";
  manager.appendCompaction(expectedSummary, assistantEntryId, 4704);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, session_id, session_file,
    transcript_start_entry_id, transcript_end_entry_id)
    VALUES ('run-compact', 'task-1', 'WORK', 1, 'COMPLETED', ?, ?, NULL, ?)`)
    .run(session.sessionId, session.sessionFile, assistantEntryId);

  const first = agents.historySnapshot("task-1");
  assert.equal(first.compaction_summaries.length, 1);
  assert.equal(first.compaction_summaries[0].summary, expectedSummary);
  assert.equal(first.compaction_summaries[0].tokens_before, 4704);
  assert.equal(first.compaction_summaries[0].after_entry_id, `${session.sessionId}:${assistantEntryId}`);
  assert.ok(first.compaction_summaries[0].id);
  assert.equal(first.active_run_id, null);

  agents.dispose("task-1");
  const restored = createAgents(db, sessionDir).agents;
  const afterRestart = restored.historySnapshot("task-1");
  assert.deepEqual(afterRestart.compaction_summaries, first.compaction_summaries);
  restored.dispose("task-1");
});

test("active snapshots expose only provisional events newer than persisted transcript entries", async (t) => {
  const db = openDatabase(":memory:");
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-live-history-"));
  t.after(() => { db.close(); rmSync(sessionDir, { recursive: true, force: true }); });
  seed(db);
  const { agents, managers } = createAgents(db, sessionDir);
  t.after(() => agents.dispose("task-1"));
  const session = await agents.getOrCreateWorkingSession("task-1");
  const manager = managers.get(session.sessionId);
  appendMessage(manager, "user", "question");
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, session_id, session_file,
    transcript_start_entry_id) VALUES ('run-live', 'task-1', 'INVESTIGATION', 1, 'RUNNING', ?, ?, NULL)`)
    .run(session.sessionId, session.sessionFile);
  agents.publish("task-1", "run-live", "message_update", { subtype: "text_delta", delta: "discard after history snapshot" });
  agents.publish("task-1", "run-live", "entry_appended", { entryId: "assistant-entry", entryType: "message", role: "assistant" });
  agents.publish("task-1", "run-live", "message_update", { subtype: "text_delta", delta: "provisional answer" });

  const snapshot = agents.historySnapshot("task-1");
  assert.equal(snapshot.active_run_id, "run-live");
  assert.equal(snapshot.cursor, 3);
  assert.deepEqual(snapshot.provisional_events.map((event) => event.sequence), [3]);
  assert.deepEqual(snapshot.provisional_events.map((event) => event.data.delta), ["provisional answer"]);
  assert.deepEqual(snapshot.provisional_output, { text: "provisional answer", thinking: "" });
  assert.equal(snapshot.provisional_truncated, false);
});

test("history snapshots retain complete provisional output after the replay buffer overflows", async (t) => {
  const db = openDatabase(":memory:");
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-live-history-"));
  t.after(() => { db.close(); rmSync(sessionDir, { recursive: true, force: true }); });
  seed(db);
  const { agents } = createAgents(db, sessionDir, 2);
  t.after(() => agents.dispose("task-1"));
  const session = await agents.getOrCreateWorkingSession("task-1");
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, session_id, session_file)
    VALUES ('run-live', 'task-1', 'WORK', 1, 'RUNNING', ?, ?)`)
    .run(session.sessionId, session.sessionFile);

  for (const delta of ["first ", "second ", "third ", "fourth"]) {
    agents.publish("task-1", "run-live", "message_update", { subtype: "text_delta", delta });
  }
  const snapshot = agents.historySnapshot("task-1");
  assert.equal(snapshot.cursor, 4);
  assert.deepEqual(snapshot.provisional_events.map((event) => event.sequence), [3, 4]);
  assert.deepEqual(snapshot.provisional_output, { text: "first second third fourth", thinking: "" });
  assert.equal(snapshot.provisional_truncated, true);

  agents.publish("task-1", "run-live", "auto_retry_start", { attempt: 1 });
  agents.publish("task-1", "run-live", "message_update", { subtype: "text_delta", delta: "replacement answer" });
  assert.deepEqual(agents.historySnapshot("task-1").provisional_output, { text: "replacement answer", thinking: "" });

  agents.publish("task-1", "run-live", "entry_appended", { entryId: "assistant-entry", entryType: "message", role: "assistant" });
  const committed = agents.historySnapshot("task-1");
  assert.deepEqual(committed.provisional_output, { text: "", thinking: "" });
  assert.deepEqual(committed.provisional_events, []);

  agents.clearReplay("run-live");
  assert.deepEqual(agents.streamSnapshot("run-live").provisionalOutput, { text: "", thinking: "" });
});

test("history endpoint rejects an unknown task", async (t) => {
  const db = openDatabase(":memory:");
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-live-history-"));
  const { agents } = createAgents(db, sessionDir);
  const app = Fastify();
  await registerLiveEventRoutes(app, db, agents);
  await app.ready();
  t.after(async () => { await app.close(); agents.dispose("missing"); db.close(); rmSync(sessionDir, { recursive: true, force: true }); });
  const response = await app.inject({ method: "GET", url: "/api/tasks/missing/live/history" });
  assert.equal(response.statusCode, 404);
});
