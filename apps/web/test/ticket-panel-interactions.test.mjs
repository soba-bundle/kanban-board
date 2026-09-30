import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
let sharedDom;
let sharedTesting;

async function setupDom(t) {
  if (!sharedDom) sharedDom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const values = {
    window: sharedDom.window,
    document: sharedDom.window.document,
    navigator: sharedDom.window.navigator,
    HTMLElement: sharedDom.window.HTMLElement,
    Node: sharedDom.window.Node,
    MutationObserver: sharedDom.window.MutationObserver,
    getComputedStyle: sharedDom.window.getComputedStyle.bind(sharedDom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  sharedTesting ??= await import("@testing-library/react");
  t.after(() => sharedTesting.cleanup());
  return sharedTesting;
}

async function loadComponents(t) {
  const vite = await createServer({
    root: webRoot,
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  t.after(() => vite.close());
  return {
    ...(await vite.ssrLoadModule("/src/components/TicketPanel.tsx")),
    ...(await vite.ssrLoadModule("/src/components/ToastContext.tsx")),
    ...(await vite.ssrLoadModule("/src/components/ToastViewport.tsx")),
  };
}

function task(workflowState = "TODO", reviewTag = null) {
  return {
    id: "task-1", project_id: "project-1", title: "Improve retries", description: "Avoid duplicate requests.",
    workflow_state: workflowState, review_tag: reviewTag, latest_task_commit_sha: null,
    worktree_path: null, working_session_id: null, working_session_file: null,
    base_branch: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
}

function history(inputs = []) {
  return {
    task_id: "task-1", session_id: null, active_run_id: null, cursor: 0, provisional_truncated: false,
    entries: [], inputs, provisional_events: [],
  };
}

function response(_url, body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

test("composer gates on prompt/stage, keeps Shift+Enter, and preserves draft through confirmation cancel", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  globalThis.fetch = async (url) => response(url, String(url).includes("/live/history") ? history() : []);
  const view = testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: task(), queue: null, onClose() {}, onChanged() {} })));

  const composer = await testing.screen.findByPlaceholderText("What should the agent do?");
  const startButton = testing.screen.getByRole("button", { name: "Start run" });
  assert.equal(startButton.disabled, true);
  testing.fireEvent.change(composer, { target: { value: "Fix retries" } });
  assert.equal(startButton.disabled, true);
  testing.fireEvent.click(testing.screen.getByRole("radio", { name: "Investigation" }));
  assert.equal(startButton.disabled, false);

  testing.fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
  assert.equal(testing.screen.queryByRole("dialog", { name: "Start a run" }), null);
  testing.fireEvent.keyDown(composer, { key: "Enter" });
  const startDialog = testing.screen.getByRole("dialog", { name: "Start a run" });
  assert.equal(testing.within(startDialog).getByLabelText("Initial prompt").value, "Fix retries");
  testing.fireEvent.click(testing.within(startDialog).getByRole("button", { name: "Send" }));
  const confirm = testing.screen.getByRole("alertdialog", { name: "Confirm run" });
  assert.match(confirm.textContent, /Investigation/);
  testing.fireEvent.click(testing.within(confirm).getByRole("button", { name: "Cancel" }));
  testing.fireEvent.click(testing.within(startDialog).getByRole("button", { name: "Cancel" }));
  assert.equal(composer.value, "Fix retries");
  view.unmount();
});

test("Review can be closed as Done while retaining the task and its run history", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const requests = [];
  let changed = 0;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method ?? "GET" });
    if (String(url).endsWith("/live/history")) return response(url, history());
    if (String(url).endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: [], untracked_files: [], branch: "agent/task-task-1", commit_sha: "a".repeat(40), state_token: "clean",
    });
    if (String(url).endsWith("/complete-preview")) return response(url, { ready: true, reason: null });
    if (String(url).endsWith("/complete")) return response(url, { status: "done" });
    return response(url, []);
  };
  const view = testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, {
      task: task("REVIEW", "INVESTIGATION_COMPLETE"), queue: null, onClose() {}, onChanged() { changed++; },
    })));

  const closeButton = await testing.screen.findByRole("button", { name: "Mark as done" });
  testing.fireEvent.click(closeButton);
  await testing.waitFor(() => assert.ok(requests.some((request) => request.method === "POST" &&
    request.url === "/api/tasks/task-1/complete")));
  await testing.waitFor(() => assert.ok(changed > 0, "the board refreshes so the task moves from Review to Done"));
  view.unmount();
});

test("Review with task-branch changes shows Merge back, not Mark as done", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method ?? "GET" });
    if (String(url).endsWith("/complete-preview")) return response(url, { ready: false, reason: "BRANCH_CHANGES" });
    if (String(url).endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: [], untracked_files: [], branch: "agent/task-task-1", commit_sha: "a".repeat(40), state_token: "clean",
    });
    if (String(url).endsWith("/live/history")) return response(url, history());
    return response(url, []);
  };
  const view = testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, {
      task: task("REVIEW", "INVESTIGATION_COMPLETE"), queue: null, onClose() {}, onChanged() {},
    })));

  const mergeButton = await testing.screen.findByRole("button", { name: /Merge back to source/ });
  assert.equal(mergeButton.disabled, true, "merge-back remains gated until the planned validation/approval phase");
  assert.equal(testing.screen.queryByRole("button", { name: "Mark as done" }), null);
  assert.equal(requests.some((request) => request.method === "POST" && request.url.endsWith("/complete")), false);
  view.unmount();
});

test("explicit reuse starts a new run linked to the unresolved source input", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const requests = [];
  const unresolved = {
    id: "input-original", task_id: "task-1", run_id: "old-run", sequence: 1, idempotency_key: "old-key",
    content: "Preserve this guidance", delivery_type: "STEERING", delivery_status: "DELIVERY_UNKNOWN",
    accepted_at: new Date().toISOString(), delivered_at: null, session_id: null, session_sequence: null,
    transcript_boundary_entry_id: null, transcript_entry_id: null, failure_reason: "Delivery was uncertain.", reused_from_input_id: null,
  };
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (String(url).endsWith("/live/history")) return response(url, history([unresolved]));
    if (String(url).endsWith("/runs")) return response(url, [{
      id: "old-run", stage: "IMPLEMENTATION", sequence: 1, status: "INTERRUPTED", reason_code: null,
      error_message: null, started_at: null, completed_at: null, handover: null,
    }]);
    if (String(url).endsWith("/queue")) return new Response(JSON.stringify({ job_id: "job-new", run_id: "new-run", queue_position: 1, created: true }), { status: 201 });
    return response(url, []);
  };
  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: task("REVIEW", "INTERRUPTED"), queue: null, onClose() {}, onChanged() {} })));

  await testing.screen.findByRole("button", { name: "Runs (1)" });
  testing.fireEvent.click(await testing.screen.findByRole("button", { name: "Reuse / Send again" }));
  const startDialog = testing.screen.getByRole("dialog", { name: "Start a run" });
  assert.equal(testing.within(startDialog).getByLabelText("Initial prompt").value, unresolved.content);
  assert.equal(testing.within(startDialog).getByRole("radio", { name: "Implementation" }).checked, true);
  testing.fireEvent.click(testing.within(startDialog).getByRole("button", { name: "Send" }));
  const confirm = testing.screen.getByRole("alertdialog", { name: "Confirm run" });
  assert.match(confirm.textContent, /without an investigation run/);
  testing.fireEvent.click(testing.within(confirm).getByRole("button", { name: "Confirm and queue" }));

  await testing.waitFor(() => assert.ok(requests.some((request) => String(request.url).endsWith("/queue"))));
  await testing.act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const queueRequest = requests.find((request) => String(request.url).endsWith("/queue"));
  assert.equal(JSON.parse(queueRequest.options.body).prompt, unresolved.content);
  assert.equal(JSON.parse(queueRequest.options.body).reused_from_input_id, unresolved.id);
});

test("Commit always requires confirmation, including tracked-only changes", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (String(url).endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: ["src/retry.ts"], untracked_files: [], commit_sha: "a".repeat(40),
    });
    if (String(url).endsWith("/live/history")) return response(url, history());
    if (String(url).endsWith("/checkpoint")) return response(url, { commit_sha: "b".repeat(40) });
    return response(url, []);
  };
  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: task("REVIEW", "IMPLEMENTATION_COMPLETE"), queue: null, onClose() {}, onChanged() {} })));

  testing.fireEvent.click(await testing.screen.findByRole("button", { name: "Commit changes" }));
  const confirmation = await testing.screen.findByRole("dialog", { name: "Confirm checkpoint" });
  assert.match(confirmation.textContent, /src\/retry.ts/);
  assert.equal(requests.some((request) => String(request.url).endsWith("/checkpoint")), false);
  testing.fireEvent.click(testing.within(confirmation).getByRole("button", { name: "Cancel" }));
  assert.equal(requests.some((request) => String(request.url).endsWith("/checkpoint")), false);
});

test("untracked-file confirmation is explicit; after checkpoint merge stays unavailable", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const requests = [];
  const preview = {
    tracked_changes: ["src/retry.ts"], untracked_files: ["tests/retry.test.ts"],
    branch: "agent/task-task-1", commit_sha: "a".repeat(40), state_token: "preview-state",
  };
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (String(url).endsWith("/checkpoint-preview")) return response(url, preview);
    if (String(url).endsWith("/live/history")) return response(url, history());
    if (String(url).endsWith("/checkpoint")) return response(url, { commit_sha: "b".repeat(40) });
    return response(url, []);
  };
  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: task("REVIEW", "IMPLEMENTATION_COMPLETE"), queue: null, onClose() {}, onChanged() {} })));

  testing.fireEvent.click(await testing.screen.findByRole("button", { name: "Commit changes" }));
  const confirmation = await testing.screen.findByRole("dialog", { name: "Confirm checkpoint" });
  assert.match(confirmation.textContent, /tests\/retry.test.ts/);
  assert.equal(testing.within(confirmation).getByRole("button", { name: "Include files and commit" }).disabled, false);
  testing.fireEvent.click(testing.within(confirmation).getByRole("button", { name: "Cancel" }));
  assert.equal(requests.some((request) => String(request.url).endsWith("/checkpoint")), false);
  await testing.waitFor(() => assert.equal(testing.screen.getByRole("button", { name: "Commit changes" }).disabled, false));

  testing.fireEvent.click(testing.screen.getByRole("button", { name: "Commit changes" }));
  const refreshedConfirmation = await testing.screen.findByRole("dialog", { name: "Confirm checkpoint" });
  testing.fireEvent.click(testing.within(refreshedConfirmation).getByRole("button", { name: "Include files and commit" }));
  await testing.waitFor(() => assert.ok(requests.some((request) => String(request.url).endsWith("/checkpoint"))));
  const post = requests.find((request) => String(request.url).endsWith("/checkpoint"));
  assert.deepEqual(JSON.parse(post.options.body), {
    tracked_changes: preview.tracked_changes,
    include_untracked_files: preview.untracked_files,
    branch: preview.branch,
    commit_sha: preview.commit_sha,
    state_token: preview.state_token,
  });
  await testing.screen.findByRole("button", { name: "Merge back (unavailable until Phase 9)" });
});

test("concurrent ticket panels render only their own conversation history", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const timestamp = new Date().toISOString();
  globalThis.fetch = async (url) => {
    const taskId = String(url).includes("task-2") ? "task-2" : "task-1";
    if (String(url).includes("/live/history")) return response(url, {
      ...history(), task_id: taskId,
      entries: [{
        id: `${taskId}:entry`, entry_id: "entry", session_id: `${taskId}-session`, run_id: null, timestamp,
        role: "assistant", message: { role: "assistant", content: [{ type: "text", text: `Response for ${taskId}` }] },
      }],
    });
    return response(url, []);
  };
  const otherTask = { ...task(), id: "task-2", title: "Other ticket" };
  testing.render(createElement(ToastProvider, null, createElement("div", null,
    createElement(TicketPanel, { task: task(), queue: null, onClose() {}, onChanged() {} }),
    createElement(TicketPanel, { task: otherTask, queue: null, onClose() {}, onChanged() {} }))));

  const firstPanel = testing.screen.getByLabelText("Ticket Improve retries");
  const secondPanel = testing.screen.getByLabelText("Ticket Other ticket");
  await testing.within(firstPanel).findByText("Response for task-1");
  await testing.within(secondPanel).findByText("Response for task-2");
  assert.equal(testing.within(firstPanel).queryByText("Response for task-2"), null);
  assert.equal(testing.within(secondPanel).queryByText("Response for task-1"), null);
});

test("eligible Implementation Complete task exposes Validate and queues an explicit validation", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/live/history")) return response(url, history());
    if (String(url).endsWith("/checkpoint-preview")) return response(url, { tracked_changes: [], untracked_files: [],
      branch: "agent/task-1", commit_sha: "c".repeat(40), state_token: "clean" });
    if (String(url).endsWith("/complete-preview")) return response(url, { ready: false, reason: null });
    if (String(url).endsWith("/validation")) return response(url, { run_id: "validation-1", status: "QUEUED" });
    return response(url, []);
  };
  const eligibleTask = { ...task("REVIEW", "IMPLEMENTATION_COMPLETE"), latest_task_commit_sha: "c".repeat(40),
    worktree_path: "C:/work/task-1", base_branch: "main" };
  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: eligibleTask, queue: null, onClose() {}, onChanged() {} })));
  const validate = await testing.screen.findByRole("button", { name: "Validate" });
  assert.equal(validate.disabled, false);
  testing.fireEvent.click(validate);
  await testing.waitFor(() => assert.ok(requests.some((request) => request.url.endsWith("/validation"))));
  const post = requests.find((request) => request.url.endsWith("/validation"));
  assert.equal(post.options.method, "POST");
  assert.deepEqual(JSON.parse(post.options.body), {});
  await testing.screen.findByText(/validation.*queued/i);
});

test("Validate is unavailable for ineligible tasks, missing checkpoints, or conflicting queued work", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/live/history")) return response(url, history());
    if (String(url).endsWith("/checkpoint-preview")) return response(url, { tracked_changes: [], untracked_files: [],
      branch: "agent/task-1", commit_sha: String(url).includes("/task-1/") ? null : "c".repeat(40), state_token: "clean" });
    if (String(url).endsWith("/complete-preview")) return response(url, { ready: false, reason: null });
    return response(url, []);
  };
  const baseTask = { ...task("REVIEW", "IMPLEMENTATION_COMPLETE"), latest_task_commit_sha: "c".repeat(40),
    worktree_path: "C:/work/task-1", base_branch: "main" };
  const cases = [
    { task: { ...baseTask, review_tag: "INVESTIGATION_COMPLETE" }, queue: null },
    { task: { ...baseTask, latest_task_commit_sha: null }, queue: null },
    { task: { ...baseTask, review_tag: "VALIDATION_ISSUES" }, queue: null },
    { task: baseTask, queue: { jobs: [{ task_id: "task-3", run_id: "running", run_status: "RUNNING" }] } },
  ];
  for (const [index, item] of cases.entries()) {
    const view = testing.render(createElement(ToastProvider, null,
      createElement(TicketPanel, { task: { ...item.task, id: `task-${index}` }, queue: item.queue,
        onClose() {}, onChanged() {} })));
    const action = testing.screen.queryByRole("button", { name: "Validate" });
    assert.ok(!action || action.disabled, `ineligible case ${index} must not offer enabled validation`);
    view.unmount();
  }
});

test("validation findings are visible in Runs and copied by attribution category", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider, ToastViewport } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  const priorClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
  const copied = [];
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true, value: { writeText: async (text) => { copied.push(text); } },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (priorClipboard) Object.defineProperty(globalThis.navigator, "clipboard", priorClipboard);
    else delete globalThis.navigator.clipboard;
  });
  const findings = [
    { id: "direct-1", attribution: "DIRECT", summary: "Changed parser rejects valid input",
      rationale: "The implementation changed this path.", evidence: "Reproduction fails after the checkpoint.", locations: [{ file: "src/parser.ts", line: 12 }] },
    { id: "indirect-1", attribution: "INDIRECT", summary: "Existing timeout is too short",
      rationale: "This behavior predates the change.", evidence: "The unchanged caller times out under load.", locations: [{ file: "src/client.ts", line: 44 }] },
  ];
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith("/live/history")) return response(url, history());
    if (path.endsWith("/runs")) return response(url, [{
      id: "validation-1", stage: "VALIDATION_REVIEW", sequence: 3, status: "COMPLETED",
      reason_code: null, error_message: null, started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
      handover: { summary: "Validation completed." }, validation_result: { result: "ISSUES_FOUND", findings },
    }]);
    if (path.endsWith("/checkpoint-preview")) return response(url, { tracked_changes: [], untracked_files: [],
      branch: "agent/task-1", commit_sha: "c".repeat(40), state_token: "clean" });
    if (path.endsWith("/complete-preview")) return response(url, { ready: false, reason: null });
    return response(url, []);
  };
  testing.render(createElement(ToastProvider, null, createElement("div", null,
    createElement(TicketPanel, { task: { ...task("REVIEW", "VALIDATION_ISSUES"), latest_task_commit_sha: "c".repeat(40) },
      queue: null, onClose() {}, onChanged() {} }), createElement(ToastViewport))));
  testing.fireEvent.click(await testing.screen.findByRole("button", { name: "Runs (1)" }));
  await testing.screen.findByText("Changed parser rejects valid input");
  await testing.screen.findByText("Existing timeout is too short");
  testing.fireEvent.click(testing.screen.getByRole("button", { name: "Copy direct findings" }));
  testing.fireEvent.click(testing.screen.getByRole("button", { name: "Copy indirect findings" }));
  await testing.waitFor(() => assert.equal(copied.length, 2));
  await testing.screen.findByText(/copied/i);
  assert.match(copied[0], /Changed parser rejects valid input/);
  assert.doesNotMatch(copied[0], /Existing timeout is too short/);
  assert.match(copied[1], /Existing timeout is too short/);
  assert.doesNotMatch(copied[1], /Changed parser rejects valid input/);
});

test("Validation Review progress is identified in the Runs history while it is running", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith("/live/history")) return response(url, history());
    if (path.endsWith("/runs")) return response(url, [{
      id: "validation-running", stage: "VALIDATION_REVIEW", sequence: 4, status: "RUNNING",
      reason_code: null, error_message: null, started_at: new Date().toISOString(), completed_at: null,
      handover: null,
    }]);
    if (path.endsWith("/checkpoint-preview")) return response(url, { tracked_changes: [], untracked_files: [],
      branch: "agent/task-1", commit_sha: "c".repeat(40), state_token: "clean" });
    if (path.endsWith("/complete-preview")) return response(url, { ready: false, reason: null });
    return response(url, []);
  };
  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: task("REVIEW", "IMPLEMENTATION_COMPLETE"), queue: null, onClose() {}, onChanged() {} })));
  testing.fireEvent.click(await testing.screen.findByRole("button", { name: "Runs (1)" }));
  await testing.screen.findByText("Validation #4");
  await testing.screen.findByText("RUNNING");
});
