import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

let createKanbanQuestionnaireTool;
let kanbanToolLoadError;
try {
  ({ createKanbanQuestionnaireTool } = await import("../dist/pi/questionnaire-tool.js"));
} catch (error) {
  kanbanToolLoadError = error;
}

const questionnaireParams = Type.Object({
  questions: Type.Array(Type.Object({
    id: Type.String(),
    label: Type.Optional(Type.String()),
    prompt: Type.String(),
    options: Type.Array(Type.Object({ value: Type.String(), label: Type.String() })),
    allowOther: Type.Optional(Type.Boolean()),
  })),
});

test("the repo-owned questionnaire tool handles structured answers in a hosted Pi session", async (t) => {
  assert.equal(typeof createKanbanQuestionnaireTool, "function",
    `Expected repo-owned questionnaire tool factory; ${kanbanToolLoadError?.message ?? "export is missing"}`);
  const agentDir = mkdtempSync(join(tmpdir(), "kanban-questionnaire-tool-"));
  const cwd = tmpdir();
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const questions = [
    { id: "scope", label: "Scope", prompt: "Which scope?", options: [
      { value: "small", label: "Small" }, { value: "large", label: "Large" },
    ], allowOther: false },
    { id: "risk", label: "Risk", prompt: "What risk is acceptable?", options: [], allowOther: true },
  ];
  const calls = [];
  const humanRequests = {
    async ask(input) {
      calls.push(input);
      if (input.toolCallId === "call-cancel") throw new Error("Human Request was cancelled because the run was stopped.");
      if (input.toolCallId === "call-incomplete") return [
        { id: "scope", value: "large", label: "Large", wasCustom: false, index: 2 },
      ];
      return [
        { id: "scope", value: "large", label: "Large", wasCustom: false, index: 2 },
        { id: "risk", value: "controlled", label: "controlled", wasCustom: true },
      ];
    },
  };
  const questionnaireTool = createKanbanQuestionnaireTool({
    humanRequests, taskId: "task-1", runId: "run-1", sessionId: "session-1",
  });
  const { session } = await createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    customTools: [questionnaireTool], tools: ["kanban_questionnaire"],
  });
  t.after(() => { session.dispose(); rmSync(agentDir, { recursive: true, force: true }); });

  const context = session.extensionRunner.createContext();
  assert.equal(context.mode, "print");
  const registeredTool = session.getToolDefinition("kanban_questionnaire");
  assert.ok(registeredTool, "the repo-owned tool must be registered without a TUI");
  const result = await registeredTool.execute("call-1", { questions }, undefined, undefined, context);
  assert.deepEqual(calls[0], {
    taskId: "task-1", runId: "run-1", sessionId: "session-1", toolCallId: "call-1", questions,
  });
  assert.deepEqual(result.details, {
    questions, answers: [
      { id: "scope", value: "large", label: "Large", wasCustom: false, index: 2 },
      { id: "risk", value: "controlled", label: "controlled", wasCustom: true },
    ], cancelled: false,
  });
  assert.match(result.content[0].text, /Scope: user selected: 2\. Large/);
  assert.match(result.content[0].text, /Risk: user wrote: controlled/);

  await assert.rejects(
    registeredTool.execute("call-cancel", { questions }, undefined, undefined, context),
    /cancelled/i,
    "Stop cancellation must abort the tool instead of returning a successful result to Pi",
  );
  assert.equal(calls[1].toolCallId, "call-cancel");
  await assert.rejects(
    registeredTool.execute("call-incomplete", { questions }, undefined, undefined, context),
    /incomplete or mismatched answer batch/i,
  );
  assert.equal(calls[2].toolCallId, "call-incomplete");
});

test("Pi's default hosted SDK context cannot run a TUI-only questionnaire tool", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "kanban-pi-compatibility-"));
  const cwd = tmpdir();
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const questionnaireTool = defineTool({
    name: "questionnaire",
    label: "Questionnaire",
    description: "Ask the user questions through Pi's TUI.",
    parameters: questionnaireParams,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") {
        return {
          content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
          details: { cancelled: true },
        };
      }
      return { content: [{ type: "text", text: "TUI available" }], details: {} };
    },
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    customTools: [questionnaireTool],
    tools: ["questionnaire"],
  });
  t.after(() => {
    session.dispose();
    rmSync(agentDir, { recursive: true, force: true });
  });

  const context = session.extensionRunner.createContext();
  assert.equal(context.mode, "print");
  assert.equal(context.hasUI, false);
  const registeredTool = session.getToolDefinition("questionnaire");
  assert.ok(registeredTool, "the hosted session must register the questionnaire tool");
  const result = await registeredTool.execute("question-call-1", {
    questions: [{ id: "scope", prompt: "Which scope?", options: [{ value: "small", label: "Small" }] }],
  }, undefined, undefined, context);
  assert.equal(result.content[0].text, "Error: UI not available (running in non-interactive mode)");
  assert.equal(result.details.cancelled, true);
});
