import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../dist/db.js";
import { AgentManager } from "../dist/agents/agent-manager.js";

let createValidationSession;
let importError;
try {
  ({ createValidationSession } = await import("../dist/agents/validation-session.js"));
} catch (error) {
  importError = error;
}

test("each validation attempt gets a fresh Review session, distinct from task and earlier validation sessions", async (t) => {
  assert.equal(typeof createValidationSession, "function",
    `Expected a validation-only Review session factory; ${importError?.message ?? "export is missing"}`);
  const root = mkdtempSync(join(tmpdir(), "kanban-validation-sessions-"));
  const taskWorktree = join(root, "task-worktree");
  const firstValidationWorktree = join(root, "validation-1");
  const secondValidationWorktree = join(root, "validation-2");
  const sessionDir = join(root, "sessions");
  const agentDir = join(root, "pi-agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let first;
  let second;
  let db;
  let agents;
  t.after(() => {
    first?.dispose();
    second?.dispose();
    agents?.dispose("t");
    db?.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(taskWorktree, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(firstValidationWorktree, { recursive: true });
  mkdirSync(secondValidationWorktree, { recursive: true });
  const now = new Date().toISOString();
  db = openDatabase(":memory:");
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('p', 'Project', ?, ?, ?)`).run(taskWorktree, now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, worktree_path, created_at, updated_at)
    VALUES ('t', 'p', 'Task', 'Description', 'REVIEW', ?, ?, ?)`).run(taskWorktree, now, now);
  agents = new AgentManager(db, sessionDir);
  const implementationSession = await agents.getOrCreateWorkingSession("t");

  first = await createValidationSession({ cwd: firstValidationWorktree, sessionDir, agentDir, stage: "VALIDATION_REVIEW" });
  second = await createValidationSession({ cwd: secondValidationWorktree, sessionDir, agentDir, stage: "VALIDATION_REVIEW" });

  assert.notEqual(first.sessionId, implementationSession.sessionId);
  assert.notEqual(second.sessionId, implementationSession.sessionId);
  assert.notEqual(second.sessionId, first.sessionId, "a retry must not resume the earlier Review session");
  assert.notEqual(first.sessionFile, second.sessionFile);
});
