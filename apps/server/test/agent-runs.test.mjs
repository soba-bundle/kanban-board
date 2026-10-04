import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { AgentManager } from "../dist/agents/agent-manager.js";
import { registerLiveEventRoutes } from "../dist/agents/live-event-routes.js";
import { RunManager } from "../dist/agents/run-manager.js";
import { QueueManager } from "../dist/queue/queue-manager.js";
import { registerQueueRoutes } from "../dist/queue/queue-routes.js";
import { openDatabase } from "../dist/db.js";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

class FakeSession {
  constructor(sessionManager) {
    this.sessionId = sessionManager.getSessionId();
    this.sessionFile = sessionManager.getSessionFile();
    this.listeners = new Set();
    this.prompts = [];
  }

  subscribe(handler) { this.listeners.add(handler); return () => this.listeners.delete(handler); }
  async prompt(text) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.prompts.push(text);
    for (const handler of this.listeners) {
      handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
    }
  }
  async steer() {}
  abort() {}
  dispose() {}
}

function makeFixture(sessionDir) {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', '', 'IN_PROGRESS', ?, ?)`).run(now, now);
  for (const [index, id] of ["run-1", "run-2", "run-3"].entries()) {
    db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
      VALUES (?, 'task-1', 'WORK', ?, 'QUEUED')`).run(id, index + 1);
  }
  const createdSessions = [];
  const customToolsSeen = [];
  const createAgentManager = () => new AgentManager(db, sessionDir, async (_cwd, manager, customTools) => {
    customToolsSeen.push(customTools);
    const sessionFile = manager.getSessionFile();
    if (sessionFile && !existsSync(sessionFile)) {
      manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
      manager.appendMessage({
        role: "assistant", content: [{ type: "text", text: "seed" }], provider: "test", model: "test",
        api: "openai-completions", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop",
      });
    }
    const session = new FakeSession(manager);
    createdSessions.push(session);
    return session;
  });
  const agents = createAgentManager();
  return { db, agents, createAgentManager, createdSessions, customToolsSeen };
}

async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for run completion.");
}

test("production AgentManager excludes the configured pi-questions extension while retaining another user extension", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "kanban-pi-agent-config-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-pi-agent-sessions-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let db;
  let agents;
  t.after(() => {
    try { agents?.dispose("task-1"); } finally {
      try { db?.close(); } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        rmSync(agentDir, { recursive: true, force: true });
        rmSync(sessionDir, { recursive: true, force: true });
      }
    }
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const extensionRoot = join(agentDir, "extensions");
  const incompatibleDir = join(extensionRoot, "pi-questions");
  const retainedDir = join(extensionRoot, "other-user-extension");
  mkdirSync(incompatibleDir, { recursive: true });
  mkdirSync(retainedDir, { recursive: true });
  writeFileSync(join(incompatibleDir, "index.ts"), `export default function(pi) {
    pi.registerTool({ name: "questionnaire", label: "Questionnaire", description: "TUI-only fixture",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() { return { content: [{ type: "text", text: "TUI only" }], details: {} }; } });
  }`);
  writeFileSync(join(retainedDir, "index.ts"), `export default function(pi) {
    pi.registerTool({ name: "other_extension_tool", label: "Other", description: "Retained fixture",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() { return { content: [{ type: "text", text: "retained" }], details: {} }; } });
  }`);

  db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', ?, ?, ?)`).run(tmpdir(), now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', '', 'TODO', ?, ?)`).run(now, now);
  agents = new AgentManager(db, sessionDir);

  const session = await agents.getOrCreateWorkingSession("task-1");
  assert.ok(session.getToolDefinition("other_extension_tool"), "unrelated user extensions must remain available");
  assert.equal(session.getToolDefinition("questionnaire"), undefined,
    "production hosted sessions must not expose the incompatible global TUI questionnaire");
  assert.ok(session.getToolDefinition("kanban_questionnaire"), "the repo-owned hosted questionnaire must be registered");
  assert.equal(session.extensionRunner.createContext().mode, "print");
});

test("Kanban SDK sessions force auto-compaction without changing Pi user settings", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "kanban-pi-user-settings-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-pi-session-"));
  const cwd = mkdtempSync(join(tmpdir(), "kanban-pi-project-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const globalSettingsPath = join(agentDir, "settings.json");
  const projectSettingsPath = join(cwd, ".pi", "settings.json");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(globalSettingsPath, JSON.stringify({
    compaction: { enabled: false, reserveTokens: 7000, keepRecentTokens: 9000 },
  }));
  writeFileSync(projectSettingsPath, JSON.stringify({
    compaction: { enabled: false, reserveTokens: 8000, keepRecentTokens: 10000 },
  }));
  const globalSettingsBefore = readFileSync(globalSettingsPath, "utf8");
  const projectSettingsBefore = readFileSync(projectSettingsPath, "utf8");
  let db;
  let agents;
  t.after(() => {
    try { agents?.dispose("task-1"); } finally {
      try { db?.close(); } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        rmSync(agentDir, { recursive: true, force: true });
        rmSync(sessionDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', ?, ?, ?)`).run(cwd, now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', '', 'IN_PROGRESS', ?, ?)`).run(now, now);

  agents = new AgentManager(db, sessionDir);
  const first = await agents.getOrCreateWorkingSession("task-1");
  assert.equal(first.autoCompactionEnabled, true, "Kanban sessions must force Pi auto-compaction on");
  assert.deepEqual(first.settingsManager.getCompactionSettings(), {
    enabled: true, reserveTokens: 8000, keepRecentTokens: 10000,
  }, "Kanban overrides enablement but preserve the Pi native reserve settings");
  assert.equal(readFileSync(globalSettingsPath, "utf8"), globalSettingsBefore);
  assert.equal(readFileSync(projectSettingsPath, "utf8"), projectSettingsBefore);
  assert.equal(SettingsManager.create(cwd, agentDir).getCompactionEnabled(), false,
    "normal Pi console settings must remain unchanged");

  agents.dispose("task-1");
  agents = new AgentManager(db, sessionDir);
  const restored = await agents.restoreWorkingSession("task-1");
  assert.equal(restored.autoCompactionEnabled, true, "restored Kanban sessions must reapply the SDK-only override");
  assert.deepEqual(restored.settingsManager.getCompactionSettings(), {
    enabled: true, reserveTokens: 8000, keepRecentTokens: 10000,
  });
  assert.equal(readFileSync(globalSettingsPath, "utf8"), globalSettingsBefore);
  assert.equal(readFileSync(projectSettingsPath, "utf8"), projectSettingsBefore);
});

test("resolved Pi prompt with failed compaction is durably failed, not completed", async (t) => {
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-compaction-failure-"));
  const { db, agents } = makeFixture(sessionDir);
  t.after(() => { agents.dispose("task-1"); db.close(); rmSync(sessionDir, { recursive: true, force: true }); });
  const session = await agents.getOrCreateWorkingSession("task-1");
  session.prompt = async () => {
    for (const handler of session.listeners) handler({ type: "compaction_end", reason: "overflow",
      aborted: false, willRetry: false, errorMessage: "Summarization failed: generation hit the token cap" });
  };
  await new RunManager(db, agents).start("run-1", { text: "continue", inputIds: [] });
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = 'run-1'").get().status !== "RUNNING");
  assert.deepEqual(db.prepare("SELECT status, error_message FROM task_runs WHERE id = 'run-1'").get(), {
    status: "FAILED", error_message: "Summarization failed: generation hit the token cap",
  });
  assert.equal(db.prepare("SELECT review_tag FROM tasks WHERE id = 'task-1'").get().review_tag, "RUN_FAILED");
  assert.equal(agents.replay("run-1").length, 0, "failure survives replay cleanup in the run record");
});

for (const recovered of [false, true]) test(`truncated response ${recovered ? "recovers once" : "cannot complete without recovery"}`, async (t) => {
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-length-recovery-"));
  const { db, agents } = makeFixture(sessionDir);
  t.after(() => { agents.dispose("task-1"); db.close(); rmSync(sessionDir, { recursive: true, force: true }); });
  const session = await agents.getOrCreateWorkingSession("task-1");
  session.prompt = async () => {
    const emit = (event) => { for (const handler of session.listeners) handler(event); };
    emit({ type: "message_end", message: { role: "assistant", stopReason: "length" } });
    if (recovered) {
      emit({ type: "compaction_end", aborted: false, willRetry: true, result: { summary: "Context retained." } });
      emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
    }
  };
  await new RunManager(db, agents).start("run-1", { text: "continue", inputIds: [] });
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = 'run-1'").get().status !== "RUNNING");
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'run-1'").get().status, recovered ? "COMPLETED" : "FAILED");
});

test("successive runs reuse the persisted task session", async (t) => {
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-agent-test-"));
  const { db, agents, createAgentManager, createdSessions, customToolsSeen } = makeFixture(sessionDir);
  t.after(() => { agents.dispose("task-1"); db.close(); rmSync(sessionDir, { recursive: true, force: true }); });
  const runs = new RunManager(db, agents);

  await runs.start("run-1", { text: "investigate", inputIds: [] });
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = 'run-1'").get().status === "COMPLETED");
  await runs.start("run-2", { text: "implement", inputIds: [] });
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = 'run-2'").get().status === "COMPLETED");

  assert.equal(createdSessions.length, 1);
  assert.deepEqual(createdSessions[0].prompts, ["investigate", "implement"]);
  assert.deepEqual(customToolsSeen.map((tools) => tools.map((tool) => tool.name)), [["kanban_questionnaire"]]);
  const sessionId = createdSessions[0].sessionId;
  assert.ok(createdSessions[0].sessionFile);
  assert.ok(existsSync(createdSessions[0].sessionFile));
  assert.equal(db.prepare("SELECT working_session_id FROM tasks WHERE id = 'task-1'").get().working_session_id, sessionId);
  assert.equal(db.prepare("SELECT session_id FROM task_runs WHERE id = 'run-2'").get().session_id, sessionId);

  agents.dispose("task-1");
  const restoredAgents = createAgentManager();
  await new RunManager(db, restoredAgents).start("run-3", { text: "continue", inputIds: [] });
  await waitFor(() => db.prepare("SELECT status FROM task_runs WHERE id = 'run-3'").get().status !== "RUNNING");
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'run-3'").get().status, "COMPLETED", db.prepare("SELECT error_message FROM task_runs WHERE id = 'run-3'").get().error_message);
  assert.equal(createdSessions.length, 2);
  assert.equal(createdSessions[1].sessionId, sessionId);
  assert.deepEqual(createdSessions[1].prompts, ["continue"]);
  // The hosted Human Request tool is re-registered on restored sessions; handover submission is retired.
  assert.deepEqual(customToolsSeen.map((tools) => tools.map((tool) => tool.name)),
    [["kanban_questionnaire"], ["kanban_questionnaire"]]);
  restoredAgents.dispose("task-1");
});

test("restoring an answered questionnaire repairs its tool result before creating the resumed session", async (t) => {
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-human-request-recovery-"));
  let db;
  let agents;
  t.after(() => {
    try { agents?.dispose("task-1"); } finally {
      try { db?.close(); } finally { rmSync(sessionDir, { recursive: true, force: true }); }
    }
  });
  db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', ?, ?, ?)`).run(tmpdir(), now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', '', 'REQUIRES_HUMAN', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, session_id, session_file)
    VALUES ('run-1', 'task-1', 'INVESTIGATION', 1, 'WAITING_FOR_HUMAN', 'session-1', NULL)`).run();
  db.prepare(`INSERT INTO agent_jobs (id, task_run_id, status, created_at)
    VALUES ('job-1', 'run-1', 'WAITING_FOR_HUMAN', ?)`).run(now);

  const manager = SessionManager.create(tmpdir(), sessionDir);
  manager.appendMessage({ role: "user", content: "Clarify the scope", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "kanban_questionnaire", arguments: { questions: [{ id: "scope" }] } }],
    provider: "test", model: "test", api: "openai-completions", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse",
  });
  const sessionFile = manager.getSessionFile();
  db.prepare("UPDATE tasks SET working_session_id = ?, working_session_file = ? WHERE id = 'task-1'")
    .run(manager.getSessionId(), sessionFile);
  db.prepare("UPDATE task_runs SET session_file = ? WHERE id = 'run-1'").run(sessionFile);
  const columns = db.prepare("PRAGMA table_info(human_requests)").all().map((column) => column.name);
  assert.ok(columns.includes("questions_json") && columns.includes("answers_json"),
    "restart repair must use the structured request schema");
  if (columns.includes("questions_json")) {
    db.prepare(`INSERT INTO human_requests (id, task_id, run_id, session_id, tool_call_id, question,
      options_json, answer, questions_json, answers_json, status, created_at, answered_at)
      VALUES ('request-1', 'task-1', 'run-1', ?, 'call-1', '', '[]', NULL, ?, ?, 'ANSWERED', ?, ?)`)
      .run(manager.getSessionId(), JSON.stringify([{ id: "scope", prompt: "Which scope?", options: [], allowOther: true }]),
        JSON.stringify([{ id: "scope", value: "custom scope", wasCustom: true }]), now, now);
  } else {
    db.prepare(`INSERT INTO human_requests (id, task_id, run_id, session_id, tool_call_id, question,
      options_json, answer, status, created_at, answered_at)
      VALUES ('request-1', 'task-1', 'run-1', ?, 'call-1', 'Which scope?', '[]', 'custom scope', 'ANSWERED', ?, ?)`)
      .run(manager.getSessionId(), now, now);
  }
  manager.appendMessage({ role: "toolResult", toolCallId: "call-6", toolName: "kanban_questionnaire",
    content: [{ type: "text", text: "Premature result" }], isError: false, timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [
      { type: "toolCall", id: "call-2", name: "kanban_questionnaire", arguments: { questions: [{ id: "risk" }] } },
      { type: "toolCall", id: "call-3", name: "kanban_questionnaire", arguments: { questions: [{ id: "region" }] } },
      { type: "toolCall", id: "call-4", name: "kanban_questionnaire", arguments: { questions: [{ id: "priority" }] } },
      { type: "toolCall", id: "call-5", name: "kanban_questionnaire", arguments: { questions: [{ id: "legacy" }] } },
      { type: "toolCall", id: "call-6", name: "kanban_questionnaire", arguments: { questions: [{ id: "premature" }] } },
    ],
    provider: "test", model: "test", api: "openai-completions", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse",
  });
  manager.appendMessage({ role: "toolResult", toolCallId: "call-2", toolName: "kanban_questionnaire",
    content: [{ type: "text", text: "Existing answer" }], isError: false, timestamp: Date.now() });
  for (const seed of [
    { id: "request-2", callId: "call-2", questionId: "risk", value: "accepted risk" },
    { id: "request-4", callId: "call-4", questionId: "priority", value: "high priority" },
    { id: "request-ghost", callId: "ghost-call", questionId: "ghost", value: "unmatched" },
    { id: "request-early", callId: "call-6", questionId: "premature", value: "premature" },
  ]) {
    db.prepare(`INSERT INTO human_requests (id, task_id, run_id, session_id, tool_call_id, question,
      options_json, answer, questions_json, answers_json, status, created_at, answered_at)
      VALUES (?, 'task-1', 'run-1', ?, ?, '', '[]', NULL, ?, ?, 'ANSWERED', ?, ?)`)
      .run(seed.id, manager.getSessionId(), seed.callId,
        JSON.stringify([{ id: seed.questionId, prompt: "Answer?", options: [], allowOther: true }]),
        JSON.stringify([{ id: seed.questionId, value: seed.value, label: seed.value, wasCustom: true }]), now, now);
  }

  db.prepare(`INSERT INTO human_requests (id, task_id, run_id, session_id, tool_call_id, question,
    options_json, answer, questions_json, answers_json, status, created_at, answered_at)
    VALUES ('request-legacy', 'task-1', 'run-1', ?, 'call-5', 'Legacy question', '[]', 'legacy free text', NULL, NULL, 'ANSWERED', ?, ?)`)
    .run(manager.getSessionId(), now, now);

  let restoredManager;
  agents = new AgentManager(db, sessionDir, async (_cwd, restored) => {
    restoredManager = restored;
    const results = restored.getBranch().filter((entry) => entry.type === "message" &&
      entry.message.role === "toolResult" && entry.message.toolName === "kanban_questionnaire");
    assert.equal(results.filter((entry) => entry.message.toolCallId === "call-1").length, 1,
      "a completed human request must close its matching dangling questionnaire call");
    assert.equal(results.filter((entry) => entry.message.toolCallId === "call-2").length, 1,
      "an existing tool result must not be duplicated");
    assert.equal(results.filter((entry) => entry.message.toolCallId === "call-4").length, 1,
      "a second completed request must repair its own dangling questionnaire call");
    assert.equal(results.filter((entry) => entry.message.toolCallId === "call-5").length, 1,
      "a legacy single-question answer must repair its matching dangling call");
    assert.equal(results.filter((entry) => entry.message.toolCallId === "call-6").length, 1,
      "an early tool result must not be duplicated or accepted as a completion");
    assert.equal(results.some((entry) => entry.message.toolCallId === "call-3" || entry.message.toolCallId === "ghost-call"), false,
      "unanswered and mismatched requests must not be attached to unrelated tool calls");
    assert.ok(JSON.stringify(results.find((entry) => entry.message.toolCallId === "call-1").message).includes("custom scope"));
    assert.ok(JSON.stringify(results.find((entry) => entry.message.toolCallId === "call-5").message).includes("legacy free text"));
    return {
      sessionId: restored.getSessionId(), sessionFile: restored.getSessionFile(), sessionManager: restored,
      prompt: async () => assert.fail("transcript repair must not prompt while a ghost call remains unmatched"),
      steer: async () => {}, abort: async () => {}, subscribe: () => () => {}, dispose: () => {},
    };
  });

  const runs = new RunManager(db, agents);
  await runs.reconcileHumanRequests();
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'run-1'").get().status, "WAITING_FOR_HUMAN",
    "a ghost request must not let the run continue with an unmatched answered call");
  assert.equal(db.prepare("SELECT status FROM agent_jobs WHERE id = 'job-1'").get().status, "WAITING_FOR_HUMAN");
  assert.equal(agents.questionnaireCallState("task-1", restoredManager.getSessionId(), "call-6"), "MISSING");
  await agents.restoreWorkingSession("task-1");
  const results = restoredManager.getBranch().filter((entry) => entry.type === "message" &&
    entry.message.role === "toolResult" && entry.message.toolName === "kanban_questionnaire");
  assert.equal(results.filter((entry) => entry.message.toolCallId === "call-1").length, 1,
    "recovery must append one correlated result, not duplicate it on repeated restore");
  assert.equal(results.filter((entry) => entry.message.toolCallId === "call-2").length, 1,
    "an existing result remains exactly once");
  assert.equal(results.filter((entry) => entry.message.toolCallId === "call-4").length, 1,
    "a second matching answer is repaired exactly once");
  assert.equal(results.filter((entry) => entry.message.toolCallId === "call-5").length, 1,
    "a legacy custom answer is repaired exactly once");
  assert.equal(results.length, 5, "only transcript calls with matching completed HumanRequests should have repaired results");

  assert.deepEqual(restoredManager.getBranch().filter((entry) => entry.type === "message" &&
    entry.message.role === "toolResult" && entry.message.toolName === "kanban_questionnaire")
    .map((entry) => entry.message.toolCallId).sort(), ["call-1", "call-2", "call-4", "call-5", "call-6"]);
});

test("restart leaves an unanswered questionnaire parked without appending a result or starting a prompt", async (t) => {
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-human-request-pending-recovery-"));
  let db;
  let agents;
  t.after(() => {
    try { agents?.dispose("task-1"); } finally {
      try { db?.close(); } finally { rmSync(sessionDir, { recursive: true, force: true }); }
    }
  });
  db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', ?, ?, ?)`).run(tmpdir(), now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', '', 'REQUIRES_HUMAN', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, session_id)
    VALUES ('run-1', 'task-1', 'INVESTIGATION', 1, 'RUNNING', 'session-1')`).run();
  db.prepare(`INSERT INTO agent_jobs (id, task_run_id, status, created_at)
    VALUES ('job-1', 'run-1', 'CLAIMED', ?)`).run(now);

  const manager = SessionManager.create(tmpdir(), sessionDir);
  manager.appendMessage({ role: "user", content: "Clarify the scope", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "kanban_questionnaire", arguments: { questions: [{ id: "scope" }] } }],
    provider: "test", model: "test", api: "openai-completions", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse",
  });
  const sessionFile = manager.getSessionFile();
  db.prepare("UPDATE tasks SET working_session_id = ?, working_session_file = ? WHERE id = 'task-1'")
    .run(manager.getSessionId(), sessionFile);
  db.prepare("UPDATE task_runs SET session_file = ? WHERE id = 'run-1'").run(sessionFile);
  const columns = db.prepare("PRAGMA table_info(human_requests)").all().map((column) => column.name);
  assert.ok(columns.includes("questions_json") && columns.includes("answers_json"),
    "unanswered recovery requires the structured request schema");
  if (columns.includes("questions_json")) {
    db.prepare(`INSERT INTO human_requests (id, task_id, run_id, session_id, tool_call_id, question,
      options_json, answer, questions_json, answers_json, status, created_at)
      VALUES ('request-1', 'task-1', 'run-1', ?, 'call-1', '', '[]', NULL, ?, NULL, 'PENDING', ?)`)
      .run(manager.getSessionId(), JSON.stringify([{ id: "scope", prompt: "Which scope?", options: [], allowOther: true }]), now);
  } else {
    db.prepare(`INSERT INTO human_requests (id, task_id, run_id, session_id, tool_call_id, question,
      options_json, answer, status, created_at)
      VALUES ('request-1', 'task-1', 'run-1', ?, 'call-1', 'Which scope?', '[]', NULL, 'PENDING', ?)`)
      .run(manager.getSessionId(), now);
  }

  let restored;
  let promptCalls = 0;
  agents = new AgentManager(db, sessionDir, async (_cwd, sessionManager) => {
    restored = sessionManager;
    return {
      sessionId: sessionManager.getSessionId(), sessionFile: sessionManager.getSessionFile(), sessionManager,
      prompt: async () => { promptCalls++; }, steer: async () => {}, abort: async () => {},
      subscribe: () => () => {}, dispose: () => {},
    };
  });

  const runs = new RunManager(db, agents);
  await runs.reconcileHumanRequests();
  await agents.getOrCreateWorkingSession("task-1");
  const toolResults = restored.getBranch().filter((entry) => entry.type === "message" &&
    entry.message.role === "toolResult" && entry.message.toolCallId === "call-1");
  assert.equal(toolResults.length, 0, "an unanswered tool call must stay open across restart");
  assert.equal(promptCalls, 0, "restart must not replay or retry the provider turn");
  assert.equal(db.prepare("SELECT status FROM human_requests WHERE id = 'request-1'").get().status, "PENDING");
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'run-1'").get().status, "WAITING_FOR_HUMAN");
  assert.equal(db.prepare("SELECT status FROM agent_jobs WHERE id = 'job-1'").get().status, "WAITING_FOR_HUMAN");
  assert.equal(db.prepare("SELECT workflow_state FROM tasks WHERE id = 'task-1'").get().workflow_state, "REQUIRES_HUMAN");

  db.prepare("DELETE FROM agent_jobs WHERE id = 'job-1'").run();
  db.prepare("UPDATE task_runs SET status = 'RUNNING' WHERE id = 'run-1'").run();
  db.prepare("UPDATE tasks SET workflow_state = 'IN_PROGRESS' WHERE id = 'task-1'").run();
  await runs.reconcileHumanRequests();
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'run-1'").get().status, "WAITING_FOR_HUMAN");
  assert.deepEqual(db.prepare("SELECT status FROM agent_jobs WHERE task_run_id = 'run-1'").all(), [
    { status: "WAITING_FOR_HUMAN" },
  ], "a pending request with a missing queue row is restored as a visible parked wait");
});

test("an answered restart continues the saved session without replaying the original prompt", async (t) => {
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-human-request-continuation-"));
  let db;
  let agents;
  t.after(() => {
    try { agents?.dispose("task-1"); } finally {
      try { db?.close(); } finally { rmSync(sessionDir, { recursive: true, force: true }); }
    }
  });
  db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', ?, ?, ?)`).run(tmpdir(), now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', '', 'REQUIRES_HUMAN', ?, ?),
      ('task-2', 'project-1', 'Earlier task', '', 'TODO', ?, ?)`).run(now, now, now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('earlier-run', 'task-2', 'INVESTIGATION', 1, 'QUEUED')`).run();
  db.prepare(`INSERT INTO agent_jobs (id, task_run_id, queue_position, status, created_at)
    VALUES ('earlier-job', 'earlier-run', 1, 'QUEUED', ?)`).run(now);
  const manager = SessionManager.create(tmpdir(), sessionDir);
  manager.appendMessage({ role: "user", content: "Original user prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "kanban_questionnaire",
      arguments: { questions: [{ id: "scope" }] } }],
    provider: "test", model: "test", api: "openai-completions", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse",
  });
  db.prepare("UPDATE tasks SET working_session_id = ?, working_session_file = ? WHERE id = 'task-1'")
    .run(manager.getSessionId(), manager.getSessionFile());
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status, session_id, session_file)
    VALUES ('run-1', 'task-1', 'VALIDATION_REVIEW', 1, 'WAITING_FOR_HUMAN', ?, ?)`)
    .run(manager.getSessionId(), manager.getSessionFile());
  db.prepare(`INSERT INTO agent_jobs (id, task_run_id, status, created_at)
    VALUES ('job-1', 'run-1', 'WAITING_FOR_HUMAN', ?)`).run(now);
  db.prepare(`INSERT INTO human_requests (id, task_id, run_id, session_id, tool_call_id, question,
    options_json, answer, questions_json, answers_json, status, created_at, answered_at)
    VALUES ('request-1', 'task-1', 'run-1', ?, 'call-1', 'Scope?', '[]', 'small', ?, ?, 'ANSWERED', ?, ?)`)
    .run(manager.getSessionId(), JSON.stringify([{ id: "scope", label: "Scope", prompt: "Scope?", options: [], allowOther: true }]),
      JSON.stringify([{ id: "scope", value: "small", label: "small", wasCustom: true }]), now, now);

  const promptCalls = [];
  agents = new AgentManager(db, sessionDir, async (_cwd, sessionManager) => ({
    sessionId: sessionManager.getSessionId(), sessionFile: sessionManager.getSessionFile(), sessionManager,
    prompt: async (text) => {
      assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "message" &&
        entry.message.role === "toolResult" && entry.message.toolCallId === "call-1").length, 1,
      "repair must happen before the resumed provider request");
      promptCalls.push(text);
    },
    steer: async () => {}, abort: async () => {}, subscribe: () => () => {}, dispose: () => {},
  }));
  const runs = new RunManager(db, agents);
  await runs.reconcileHumanRequests();
  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'run-1'").get().status, "QUEUED");
  assert.equal(db.prepare("SELECT queue_position FROM agent_jobs WHERE id = 'job-1'").get().queue_position, 2,
    "restored continuations are placed behind work already in the queue");
  db.prepare("UPDATE agent_jobs SET status = 'CLAIMED' WHERE id = 'job-1'").run();
  await runs.resumeAfterRestart("run-1", "request-1");

  assert.equal(db.prepare("SELECT status FROM task_runs WHERE id = 'run-1'").get().status, "COMPLETED");
  assert.equal(promptCalls.length, 1);
  assert.notEqual(promptCalls[0], "Original user prompt");
  assert.match(promptCalls[0], /continue from the current transcript/i);
  assert.equal(db.prepare("SELECT session_id FROM task_runs WHERE id = 'run-1'").get().session_id, manager.getSessionId());
});

test("run WebSocket receives normalized live events from its task session", async (t) => {
  const { db, agents } = makeFixture();
  db.prepare("UPDATE tasks SET workflow_state = 'TODO' WHERE id = 'task-1'").run();
  const app = Fastify();
  const queue = new QueueManager(db, new RunManager(db, agents));
  queue.initialize();
  await registerLiveEventRoutes(app, db, agents);
  registerQueueRoutes(app, queue);
  let socket;
  t.after(async () => { socket?.terminate(); await app.close(); agents.dispose("task-1"); db.close(); });

  await app.ready();
  const response = await app.inject({ method: "POST", url: "/api/tasks/task-1/queue", payload: {
    task_id: "task-1", prompt: "Investigate the issue", idempotency_key: "start-run-1",
  } });
  assert.equal(response.statusCode, 201);
  const runId = response.json().run_id;
  assert.equal(db.prepare("SELECT stage FROM task_runs WHERE id = ?").get(runId).stage, "WORK");
  socket = await app.injectWS(`/api/tasks/task-1/runs/${runId}/events`);
  const received = new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())));
    socket.once("error", reject);
  });
  const event = await received;

  assert.equal(event.taskId, "task-1");
  assert.equal(event.runId, runId);
  assert.equal(event.type, "message_update");
  assert.equal(event.data.delta, "Investigate the issue");
  socket.terminate();
  // Let normal run completion settle without a handover retry.
  await waitFor(() => !["QUEUED", "RUNNING"].includes(
    db.prepare("SELECT status FROM task_runs WHERE id = ?").get(runId).status));
});
