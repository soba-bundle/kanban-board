import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../dist/agents/agent-manager.js";
import { openDatabase } from "../dist/db.js";
import { createKanbanResourceLoader } from "../dist/pi/resource-loader.js";

test("a new ticket worktree's production Pi session includes Kanban's appended prompt on an agent turn", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "kanban-system-prompt-"));
  const worktree = join(root, "worktree");
  const sessionDir = join(root, "sessions");
  mkdirSync(worktree);
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project', 'Project', ?, ?, ?)`).run(root, now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, worktree_path, created_at, updated_at)
    VALUES ('ticket', 'project', 'Prompt check', '', 'TODO', ?, ?, ?)`).run(worktree, now, now);
  const agents = new AgentManager(db, sessionDir);
  t.after(() => {
    agents.dispose("ticket");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const session = await agents.createWorkingSession("ticket");
  const { resourceLoader } = createKanbanResourceLoader(worktree);
  await resourceLoader.reload();
  const skill = resourceLoader.getSkills().skills.find((item) => item.name === "markdown-rendering");
  assert.ok(skill, "Pi SDK discovers the repo-owned Markdown skill");
  assert.match(skill.description, /Markdown documents directly in conversation/);

  let promptAtAgentTurn = "";
  session.agent.prompt = async () => {
    promptAtAgentTurn = session.agent.state.systemPrompt;
  };
  await agents.prompt("ticket", "test-run", "Check the prompt.");

  assert.match(promptAtAgentTurn, /Kanban Markdown rendering guidance/);
  assert.match(promptAtAgentTurn, /markdown-rendering/);
  assert.match(promptAtAgentTurn, /outer fence longer than/);
  assert.match(promptAtAgentTurn, /do not substitute colon\/container syntax/i);
  assert.match(promptAtAgentTurn, /verification token: [a-f0-9]{32}/);
});
