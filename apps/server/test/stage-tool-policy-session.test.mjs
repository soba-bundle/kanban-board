import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDatabase } from "../dist/db.js";
import { AgentManager } from "../dist/agents/agent-manager.js";
import { mkdirSync } from "node:fs";

const piSdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piSdkRoot = dirname(dirname(piSdkEntry));
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(
  piSdkRoot, "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
)).href);

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

function makeDb(rootPath, taskWorktree) {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', ?, ?, ?)`).run(rootPath, now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, worktree_path, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', 'Description', 'IN_PROGRESS', ?, ?, ?)`).run(taskWorktree, now, now);
  return db;
}

test("hosted AgentSession blocks write/edit for Investigation and Validation but permits them for Implementation", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "kanban-stage-tools-agent-"));
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-stage-tools-session-"));
  const rootPath = mkdtempSync(join(tmpdir(), "kanban-stage-tools-root-"));
  const taskWorktree = mkdtempSync(join(tmpdir(), "kanban-stage-tools-worktree-"));
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
        rmSync(rootPath, { recursive: true, force: true });
        rmSync(taskWorktree, { recursive: true, force: true });
      }
    }
  });

  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  db = makeDb(rootPath, taskWorktree);
  agents = new AgentManager(db, sessionDir);
  const session = await agents.getOrCreateWorkingSession("task-1");
  const writeTarget = join(taskWorktree, "write-target.txt");
  const editTarget = join(taskWorktree, "edit-target.txt");
  writeFileSync(writeTarget, "original write\n");
  writeFileSync(editTarget, "original edit\n");

  let sequence = 0;
  async function requestTool(stage, name) {
    const runId = `run-${++sequence}`;
    db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
      VALUES (?, 'task-1', ?, ?, 'RUNNING')`).run(runId, stage, sequence);
    let callNumber = 0;
    let activeToolsDuringCall;
    session.agent.streamFunction = async (model) => {
      callNumber++;
      if (callNumber === 1) {
        activeToolsDuringCall = session.getActiveToolNames();
        const arguments_ = name === "write"
          ? { path: writeTarget, content: "changed by model\n" }
          : { path: editTarget, oldText: "original edit", newText: "changed by model" };
        return assistantStream(model, [{ type: "toolCall", id: `${runId}-${name}`, name, arguments: arguments_ }], "toolUse");
      }
      return assistantStream(model, [{ type: "text", text: "Finished." }], "stop");
    };
    await agents.prompt("task-1", runId, `Try ${name}`);
    return { activeToolsDuringCall, activeToolsAfterRun: session.getActiveToolNames(), callNumber };
  }

  for (const stage of ["INVESTIGATION", "VALIDATION_REVIEW"]) {
    for (const name of ["write", "edit"]) {
      const target = name === "write" ? writeTarget : editTarget;
      const original = name === "write" ? "original write\n" : "original edit\n";
      const { activeToolsDuringCall, activeToolsAfterRun } = await requestTool(stage, name);
      assert.ok(activeToolsAfterRun.includes("write"), "the idle session must restore its configured tools after a run");
      assert.ok(activeToolsAfterRun.includes("edit"), "the idle session must restore its configured tools after a run");
      assert.ok(!activeToolsDuringCall.includes("write"), `${stage} session must hide write`);
      assert.ok(!activeToolsDuringCall.includes("edit"), `${stage} session must hide edit`);
      if (stage === "VALIDATION_REVIEW") {
        assert.ok(!activeToolsDuringCall.includes("kanban_questionnaire"), "Validation must not park on a Human Request");
      } else {
        assert.ok(activeToolsDuringCall.includes("kanban_questionnaire"), "Investigation must retain its Human Request tool");
      }
      assert.equal(readFileSync(target, "utf8"), original, `${stage} ${name} call must not mutate the file`);
    }
  }

  for (const name of ["write", "edit"]) {
    const { activeToolsDuringCall } = await requestTool("IMPLEMENTATION", name);
    assert.ok(activeToolsDuringCall.includes("write"), "Implementation must retain write");
    assert.ok(activeToolsDuringCall.includes("edit"), "Implementation must retain edit");
  }
  assert.equal(readFileSync(writeTarget, "utf8"), "changed by model\n");
  assert.equal(readFileSync(editTarget, "utf8"), "changed by model\n");
  assert.ok(existsSync(writeTarget));
  assert.ok(existsSync(editTarget));
});
