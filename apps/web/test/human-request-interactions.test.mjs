import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import Fastify from "fastify";
import { openDatabase } from "../../server/dist/db.js";
import { AgentManager } from "../../server/dist/agents/agent-manager.js";
import { registerLiveEventRoutes } from "../../server/dist/agents/live-event-routes.js";

let HumanRequestService;
let registerHumanRequestRoutes;
let requestApiLoadError;
try {
  ({ HumanRequestService } = await import("../../server/dist/agents/human-requests.js"));
  ({ registerHumanRequestRoutes } = await import("../../server/dist/agents/human-request-routes.js"));
} catch (error) {
  requestApiLoadError = error;
}

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const emptyHistory = (taskId) => ({
  task_id: taskId, active_run_id: null, cursor: 0, entries: [], inputs: [],
  provisional_events: [], provisional_truncated: false,
});

async function mountPanel(t, requestState, fetchOverride) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:5173" });
  const saved = new Map();
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "MutationObserver", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  const previousFetch = globalThis.fetch;
  const calls = [];
  let persistedRequest = structuredClone(requestState);
  let vite;
  let testing;
  let view;
  t.after(async () => {
    try {
      view?.unmount();
      testing?.cleanup();
      if (vite) await vite.close();
    } finally {
      dom.window.close();
      globalThis.fetch = previousFetch;
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  const mockFetch = async (url, options = {}) => {
    const method = options.method ?? "GET";
    if (method === "GET" && String(url).endsWith("/runs")) return Response.json([]);
    if (method === "GET" && String(url).endsWith("/live/history")) return Response.json(emptyHistory("task-1"));
    if (method === "GET" && String(url).endsWith("/human-requests")) return Response.json([persistedRequest]);
    if (method === "POST" && String(url).endsWith("/answer")) {
      const answers = JSON.parse(options.body).answers.map((answer) => {
        const question = persistedRequest.questions.find((candidate) => candidate.id === answer.id);
        const optionIndex = question.options.findIndex((option) => option.value === answer.value);
        const option = question.options[optionIndex];
        return {
          ...answer,
          label: option?.label ?? answer.value,
          wasCustom: !option,
          ...(option ? { index: optionIndex + 1 } : {}),
        };
      });
      persistedRequest = { ...persistedRequest, status: "ANSWERED", answers, answered_at: new Date().toISOString() };
      return Response.json(persistedRequest);
    }
    if (method === "POST" && String(url).endsWith("/stop")) {
      persistedRequest = { ...persistedRequest, status: "CANCELLED" };
      return Response.json({ status: "stopped" });
    }
    return Response.json({ error: `Unexpected request: ${method} ${url}` }, { status: 404 });
  };
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? "GET";
    calls.push({ method, url: String(url), body: options.body ? JSON.parse(options.body) : undefined });
    return fetchOverride ? fetchOverride(url, options) : mockFetch(url, options);
  };

  vite = await createServer({
    root: webRoot,
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { middlewareMode: true },
    appType: "custom",
  });
  const [{ TicketPanel }, { ToastProvider }, testingLibrary] = await Promise.all([
    vite.ssrLoadModule("/src/components/TicketPanel.tsx"),
    vite.ssrLoadModule("/src/components/ToastContext.tsx"),
    import("@testing-library/react"),
  ]);
  testing = testingLibrary;
  const task = {
    id: "task-1", project_id: "project-1", title: "Clarify rollout", description: "",
    workflow_state: "REQUIRES_HUMAN", review_tag: null, worktree_path: null,
    working_session_id: "session-1", working_session_file: null,
    base_branch: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const renderPanel = () => testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task, queue: null, onClose() {}, onChanged() {} })));
  view = renderPanel();
  return {
    ...testing,
    get screen() { return testing.within(view.container); },
    reopen() { view.unmount(); view = renderPanel(); return testing.within(view.container); },
    calls,
    get request() { return persistedRequest; },
  };
}

function pendingRequest() {
  return {
    id: "request-1", task_id: "task-1", run_id: "run-1", session_id: "session-1",
    tool_call_id: "call-1", status: "PENDING", created_at: new Date().toISOString(), answered_at: null,
    questions: [
      {
        id: "scope", label: "Scope", prompt: "Which scope?",
        options: [{ value: "small", label: "Small" }, { value: "large", label: "Large" }], allowOther: false,
      },
      {
        id: "risk", label: "Risk", prompt: "What trade-off is acceptable?",
        options: [{ value: "conservative", label: "Conservative" }], allowOther: true,
      },
    ],
    answers: null,
  };
}

test("multi-question panel collects choices and free text across tabs, reviews, then submits one answer batch", async (t) => {
  const panel = await mountPanel(t, pendingRequest());
  const { screen, fireEvent, waitFor } = panel;
  await screen.findByText("Which scope?");
  const requestCard = screen.getByText("Needs your input").closest(".human-request-card");
  assert.equal(requestCard.nextElementSibling.classList.contains("ticket-composer"), true,
    "the request card sits directly above the prompt box without covering the transcript");
  assert.equal(screen.getByPlaceholderText("What should the agent do?").disabled, true,
    "ordinary guidance must not bypass a pending Human Request");
  assert.equal(panel.calls.some((call) => call.method === "POST" && /\/(queue|inputs)$/.test(call.url)), false);
  assert.ok(screen.getByRole("tab", { name: /Scope/ }));
  assert.ok(screen.getByRole("tab", { name: /Risk/ }));
  assert.equal(screen.getByRole("tab", { name: /Review and submit/i }).getAttribute("aria-disabled"), "true");

  fireEvent.click(screen.getByRole("radio", { name: "Large" }));
  fireEvent.click(screen.getByRole("tab", { name: /Risk/ }));
  await screen.findByText("What trade-off is acceptable?");
  fireEvent.click(screen.getByRole("radio", { name: /Type something/i }));
  fireEvent.change(screen.getByRole("textbox", { name: /Your answer/i }), { target: { value: "A controlled rollout" } });
  fireEvent.click(screen.getByRole("tab", { name: /Scope/ }));
  assert.equal(screen.getByRole("radio", { name: "Large" }).checked, true,
    "changing tabs must retain already selected options");
  fireEvent.click(screen.getByRole("tab", { name: /Risk/ }));
  assert.equal(screen.getByRole("textbox", { name: /Your answer/i }).value, "A controlled rollout",
    "changing tabs must retain free-text drafts");
  fireEvent.click(screen.getByRole("tab", { name: /Review and submit/i }));
  assert.ok(screen.getByText("Large"));
  assert.ok(screen.getByText("A controlled rollout"));

  fireEvent.click(screen.getByRole("button", { name: /Submit answers/i }));
  await waitFor(() => assert.equal(panel.request.status, "ANSWERED"));
  const answerCall = panel.calls.find((call) => call.method === "POST" && call.url.endsWith("/answer"));
  assert.deepEqual(answerCall.body, { answers: [
    { id: "scope", value: "large" },
    { id: "risk", value: "A controlled rollout" },
  ] });
  assert.ok(await screen.findByText(/Answered/i));
  assert.ok(screen.getByText("A controlled rollout"), "the persisted answer remains visible in Live");
});

test("Live reloads a persisted Human Request from the real API after closing and reopening the panel", async (t) => {
  assert.equal(typeof HumanRequestService, "function",
    `Expected HumanRequestService export; ${requestApiLoadError?.message ?? "export is missing"}`);
  assert.equal(typeof registerHumanRequestRoutes, "function",
    `Expected Human Request routes; ${requestApiLoadError?.message ?? "export is missing"}`);
  const db = openDatabase(":memory:");
  const sessionDir = mkdtempSync(join(tmpdir(), "kanban-human-live-api-"));
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', '/tmp/project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Clarify rollout', '', 'REQUIRES_HUMAN', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO task_runs (id, task_id, stage, sequence, status)
    VALUES ('run-1', 'task-1', 'INVESTIGATION', 1, 'WAITING_FOR_HUMAN')`).run();
  db.prepare("UPDATE projects SET root_path = ? WHERE id = 'project-1'").run(tmpdir());
  const questions = [
    { id: "scope", label: "Scope", prompt: "Which scope?", options: [
      { value: "small", label: "Small" }, { value: "large", label: "Large" },
    ], allowOther: false },
    { id: "risk", label: "Risk", prompt: "What risk is acceptable?", options: [], allowOther: true },
  ];
  const sessionManager = SessionManager.create(tmpdir(), sessionDir);
  sessionManager.appendMessage({ role: "user", content: "Clarify rollout", timestamp: Date.now() });
  sessionManager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call-1",
    name: "kanban_questionnaire", arguments: { questions } }], provider: "test", model: "test",
    api: "openai-completions", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0,
      cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse" });
  db.prepare(`UPDATE tasks SET working_session_id = ?, working_session_file = ? WHERE id = 'task-1'`)
    .run(sessionManager.getSessionId(), sessionManager.getSessionFile());
  db.prepare(`UPDATE task_runs SET session_id = ?, session_file = ? WHERE id = 'run-1'`)
    .run(sessionManager.getSessionId(), sessionManager.getSessionFile());
  const agents = new AgentManager(db, sessionDir, async () => assert.fail("history reads must not start a Pi session"));
  const app = Fastify();
  const service = new HumanRequestService(db, {
    onWaiting: async () => {},
    onAnswered: async (request) => {
      sessionManager.appendMessage({ role: "toolResult", toolCallId: request.tool_call_id,
        toolName: "kanban_questionnaire", content: [{ type: "text",
          text: "Scope: user selected: 2. Large\nRisk: user wrote: A controlled rollout" }],
        isError: false, timestamp: Date.now() });
      db.prepare("UPDATE tasks SET workflow_state = 'IN_PROGRESS', updated_at = ? WHERE id = 'task-1'")
        .run(new Date().toISOString());
    },
  });
  const waiting = service.ask({ taskId: "task-1", runId: "run-1", sessionId: sessionManager.getSessionId(),
    toolCallId: "call-1", questions });
  void waiting.catch(() => {});
  registerHumanRequestRoutes(app, db, service, async () => {});
  app.get("/api/tasks/:taskId/runs", async () => []);
  await registerLiveEventRoutes(app, db, agents);
  await app.ready();
  t.after(async () => {
    await app.close();
    await service.cancelForRun("run-1");
    agents.dispose("task-1");
    db.close();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  const fetchApi = async (url, options = {}) => {
    const pathname = new URL(String(url), "http://localhost").pathname;
    if (pathname.endsWith("/runs")) return Response.json([]);
    const response = await app.inject({ method: options.method ?? "GET", url: pathname,
      payload: options.body ? JSON.parse(options.body) : undefined });
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  };
  const panel = await mountPanel(t, pendingRequest(), fetchApi);
  await panel.screen.findByText("Which scope?");
  const reopenedPending = panel.reopen();
  await reopenedPending.findByText("Which scope?");
  assert.equal(service.listForTask("task-1")[0].status, "PENDING",
    "closing and reopening Live must preserve an unanswered durable request");
  panel.fireEvent.click(reopenedPending.getByRole("radio", { name: "Large" }));
  panel.fireEvent.click(reopenedPending.getByRole("tab", { name: /Risk/ }));
  panel.fireEvent.click(reopenedPending.getByRole("radio", { name: /Type something/i }));
  panel.fireEvent.change(reopenedPending.getByRole("textbox", { name: /Your answer/i }),
    { target: { value: "A controlled rollout" } });
  panel.fireEvent.click(reopenedPending.getByRole("tab", { name: /Review and submit/i }));
  panel.fireEvent.click(reopenedPending.getByRole("button", { name: /Submit answers/i }));
  await panel.waitFor(() => assert.equal(service.listForTask("task-1")[0].status, "ANSWERED"));
  const request = service.listForTask("task-1")[0];
  assert.deepEqual(request.answers.map((answer) => answer.value), ["large", "A controlled rollout"]);
  await service.resume(request.id);

  const reopened = panel.reopen();
  await reopened.findByText(/Answered/i);
  assert.ok(reopened.getByText("A controlled rollout"));
  assert.ok(reopened.getByText(/Scope: user selected: 2\. Large/),
    "reopened Live must rebuild the correlated questionnaire tool result from persisted session history");
  assert.equal(panel.calls.filter((call) => call.method === "GET" && call.url.endsWith("/human-requests")).length, 4,
    "initial open, answer refresh, and both pending/answered reopens must reload the durable request from the API");
});

test("Stop cancels a pending multi-question form without submitting partial answers", async (t) => {
  const panel = await mountPanel(t, pendingRequest());
  const { screen, fireEvent, waitFor } = panel;
  await screen.findByText("Which scope?");
  fireEvent.click(screen.getByRole("radio", { name: "Small" }));
  fireEvent.click(screen.getByRole("button", { name: /Stop waiting/i }));
  await waitFor(() => assert.equal(panel.request.status, "CANCELLED"));
  await screen.findByText(/No answers were submitted/);
  assert.ok(panel.calls.some((call) => call.method === "POST" && call.url.endsWith("/stop")));
  assert.equal(panel.calls.some((call) => call.method === "POST" && call.url.endsWith("/answer")), false);
});
