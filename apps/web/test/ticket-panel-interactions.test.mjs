import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    server: { middlewareMode: true, hmr: false },
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
    entries: [], inputs, provisional_events: [], compaction_summaries: [],
  };
}

function response(_url, body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

test("composer gates on prompt, keeps Shift+Enter, and preserves draft through confirmation cancel", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  globalThis.fetch = async (url) => response(url, String(url).includes("/live/history") ? history() : []);
  const view = testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: task(), queue: null, onClose() {}, onChanged() {} })));

  const composer = await testing.screen.findByPlaceholderText("What should the agent do?");
  const startButton = testing.screen.getByRole("button", { name: "Start run" });
  assert.equal(startButton.disabled, true);
  assert.equal(testing.screen.queryByRole("radio", { name: /Investigation|Implementation/ }), null);
  testing.fireEvent.change(composer, { target: { value: "Fix retries" } });
  assert.equal(startButton.disabled, false);

  testing.fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
  assert.equal(testing.screen.queryByRole("dialog", { name: "Start a run" }), null);
  testing.fireEvent.keyDown(composer, { key: "Enter" });
  const startDialog = testing.screen.getByRole("dialog", { name: "Start a run" });
  assert.equal(testing.within(startDialog).getByLabelText("Initial prompt").value, "Fix retries");
  testing.fireEvent.click(testing.within(startDialog).getByRole("button", { name: "Send" }));
  const confirm = testing.screen.getByRole("alertdialog", { name: "Confirm run" });
  assert.doesNotMatch(confirm.textContent, /Investigation|Implementation/);
  testing.fireEvent.click(testing.within(confirm).getByRole("button", { name: "Cancel" }));
  testing.fireEvent.click(testing.within(startDialog).getByRole("button", { name: "Cancel" }));
  assert.equal(composer.value, "Fix retries");
  view.unmount();
});

test("TODO starts from a prompt without requiring an Investigation or Implementation choice", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/live/history")) return response(url, history());
    if (String(url).endsWith("/queue")) return response(url, { job_id: "job-1", run_id: "run-1", created: true });
    return response(url, []);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: task(), queue: null, onClose() {}, onChanged() {} })));

  const composer = await testing.screen.findByPlaceholderText("What should the agent do?");
  assert.equal(testing.screen.queryByRole("radio", { name: /Investigation|Implementation/ }), null);
  testing.fireEvent.change(composer, { target: { value: "Explore the retry bug and fix it if needed" } });
  const start = testing.screen.getByRole("button", { name: "Start run" });
  assert.equal(start.disabled, false);
  testing.fireEvent.click(start);
  const startDialog = await testing.screen.findByRole("dialog", { name: "Start a run" });
  testing.fireEvent.click(testing.within(startDialog).getByRole("button", { name: "Send" }));
  const confirmation = await testing.screen.findByRole("alertdialog", { name: "Confirm run" });
  assert.match(confirmation.textContent, /Explore the retry bug and fix it if needed/);
  assert.doesNotMatch(confirmation.textContent, /Investigation|Implementation/);
  testing.fireEvent.click(testing.within(confirmation).getByRole("button", { name: /Confirm and queue/i }));
  await testing.waitFor(() => assert.ok(requests.some((request) => request.options.method === "POST" && String(request.url).endsWith("/queue"))));
  const queued = requests.find((request) => request.options.method === "POST" && String(request.url).endsWith("/queue"));
  assert.deepEqual(Object.keys(JSON.parse(queued.options.body)).sort(), ["idempotency_key", "prompt", "task_id"]);
});

test("no-code work shows the agent's ordinary response without a Changes to review card", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  const live = { ...history(), entries: [{ id: "entry-1", entry_id: "entry-1", session_id: "session-1", run_id: "run-1",
    timestamp: new Date().toISOString(), role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "The retry path is already safe." }] } }] };
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/live/history")) return response(url, live);
    if (String(url).endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: [], untracked_files: [], branch: "agent/task-task-1", commit_sha: "a".repeat(40), state_token: "clean", diff: "",
    });
    if (String(url).endsWith("/complete-preview")) return response(url, { ready: false, reason: "BRANCH_CHANGES" });
    if (String(url).endsWith("/merge-preview")) return response(url, { eligible: false, reason: "SYNC_REQUIRED" });
    return response(url, []);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  testing.render(createElement(ToastProvider, null, createElement(TicketPanel, {
    task: task("REVIEW", "IMPLEMENTATION_COMPLETE"), queue: null, onClose() {}, onChanged() {},
  })));
  assert.ok(await testing.screen.findByText("The retry path is already safe."));
  assert.equal(testing.screen.queryByText("Changes to review"), null);
});

test("code changes show a review card with the summary, paths, and uncheckpointed diff", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  const live = { ...history(), entries: [
    { id: "entry-old", entry_id: "entry-old", session_id: "session-1", run_id: "run-old",
      timestamp: new Date().toISOString(), role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "An earlier response must not be shown." }] } },
    { id: "entry-code", entry_id: "entry-code", session_id: "session-1", run_id: "run-1",
      timestamp: new Date().toISOString(), role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Updated the retry guard and added a regression case." }] } },
  ] };
  const patch = ["diff --git a/src/retry.ts b/src/retry.ts", "--- a/src/retry.ts", "+++ b/src/retry.ts",
    "@@ -1 +1 @@", "-old guard", "+new guard", "diff --git a/test/retry.test.ts b/test/retry.test.ts",
    "--- /dev/null", "+++ b/test/retry.test.ts", "@@ -0,0 +1 @@", "+test regression", ""].join("\n");
  const completedRuns = [
    { id: "run-old", stage: "WORK", sequence: 1, status: "COMPLETED", reason_code: null, error_message: null,
      started_at: "2025-01-01T00:00:00.000Z", completed_at: "2025-01-01T00:01:00.000Z", handover: null },
    { id: "run-1", stage: "WORK", sequence: 2, status: "COMPLETED", reason_code: null, error_message: null,
      started_at: "2025-01-02T00:00:00.000Z", completed_at: "2025-01-02T00:01:00.000Z", handover: null },
  ];
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/live/history")) return response(url, live);
    if (String(url).endsWith("/runs")) return response(url, completedRuns);
    if (String(url).endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: ["src/retry.ts"], untracked_files: ["test/retry.test.ts"], branch: "agent/task-task-1",
      commit_sha: "a".repeat(40), state_token: "dirty-state", diff: patch,
    });
    if (String(url).endsWith("/complete-preview")) return response(url, { ready: false, reason: "WORKTREE_CHANGES" });
    if (String(url).endsWith("/merge-preview")) return response(url, { eligible: false, reason: "CHECKPOINT_REQUIRED" });
    return response(url, []);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const props = { task: task("REVIEW", "IMPLEMENTATION_COMPLETE"), queue: null, onClose() {}, onChanged() {} };
  const view = testing.render(createElement(ToastProvider, null, createElement(TicketPanel, props)));

  assert.ok(await testing.screen.findByText("Changes to review"));
  const card = testing.screen.getByRole("region", { name: "Changes to review" });
  assert.ok(testing.within(card).getByText(/Updated the retry guard/));
  assert.equal(testing.within(card).queryByText("An earlier response must not be shown."), null);
  assert.ok(testing.within(card).getByText("src/retry.ts"));
  assert.ok(testing.within(card).getByText("test/retry.test.ts"));
  testing.fireEvent.click(testing.within(card).getByRole("button", { name: /Preview changes/i }));
  const preview = await testing.screen.findByRole("dialog", { name: /Changes to review/i });
  assert.match(preview.textContent, /new guard/);
  testing.fireEvent.click(testing.within(preview).getByRole("button", { name: "test/retry.test.ts" }));
  assert.match(preview.textContent, /test regression/);
  assert.equal(testing.within(preview).queryByRole("button", { name: /Update checkpoint/i }), null,
    "checkpoint confirmation belongs to W-09, not the diff preview");

  view.unmount();
  testing.render(createElement(ToastProvider, null, createElement(TicketPanel, props)));
  assert.ok(await testing.screen.findByText("Changes to review"));
  const refreshedCard = testing.screen.getByRole("region", { name: "Changes to review" });
  assert.ok(testing.within(refreshedCard).getByText(/Updated the retry guard/),
    "the response excerpt is recovered from persisted run history");
});

test("changed-work review data does not leak when the ticket switches", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith("/live/history")) return response(url, path.includes("task-1")
      ? { ...history(), entries: [{ id: "entry-1", entry_id: "entry-1", session_id: "session-1", run_id: "run-1",
        timestamp: new Date().toISOString(), role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Task one's private summary." }] } }] }
      : { ...history(), task_id: "task-2" });
    if (path.endsWith("/runs")) return response(url, path.includes("task-1")
      ? [{ id: "run-1", stage: "WORK", sequence: 1, status: "COMPLETED", reason_code: null, error_message: null,
        started_at: null, completed_at: null, handover: null }]
      : []);
    if (path.endsWith("/checkpoint-preview")) return response(url, path.includes("task-1")
      ? { tracked_changes: ["private.ts"], untracked_files: [], branch: "agent/task-1", commit_sha: "a".repeat(40),
        state_token: "dirty", diff: "diff --git a/private.ts b/private.ts\n+private change" }
      : { tracked_changes: [], untracked_files: [], branch: "agent/task-2", commit_sha: "b".repeat(40), state_token: "clean", diff: "" });
    return response(url, []);
  };

  const firstTask = { ...task("REVIEW", "WORK_COMPLETE"), id: "task-1" };
  const view = testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: firstTask, queue: null, onClose() {}, onChanged() {} })));
  assert.ok(await testing.screen.findByText("Changes to review"));
  view.rerender(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: { ...firstTask, id: "task-2" }, queue: null, onClose() {}, onChanged() {} })));
  await testing.waitFor(() => assert.equal(testing.screen.queryByText("Changes to review"), null));
  assert.equal(testing.screen.queryByText("Task one's private summary."), null);
  assert.equal(testing.screen.queryByText("private.ts"), null);
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

test("Review exposes explicit Sync with main without running agent Validation", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push({ path, options });
    if (path.endsWith("/live/history")) return response(url, history());
    if (path.endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: [], untracked_files: [], branch: "agent/task-1", commit_sha: "c".repeat(40), state_token: "clean", diff: "",
    });
    if (path.endsWith("/sync")) return response(url, { status: "SYNCED", synced_base_sha: "d".repeat(40), candidate_sha: "e".repeat(40) });
    return response(url, []);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const reviewTask = { ...task("REVIEW", "IMPLEMENTATION_COMPLETE"), base_commit_sha: "b".repeat(40),
    latest_task_commit_sha: "c".repeat(40), worktree_path: "C:/work/task-1", base_branch: "main" };
  testing.render(createElement(ToastProvider, null, createElement(TicketPanel, {
    task: reviewTask, queue: null, onClose() {}, onChanged() {},
  })));

  const sync = await testing.screen.findByRole("button", { name: /Sync with main/i });
  assert.equal(sync.disabled, false);
  assert.equal(requests.some((request) => request.options.method === "POST" && request.path.endsWith("/sync")), false,
    "sync must wait for an explicit user action");
  testing.fireEvent.click(sync);
  await testing.waitFor(() => assert.ok(requests.some((request) => request.options.method === "POST" && request.path.endsWith("/sync"))));
  assert.match((await testing.screen.findByRole("status")).textContent, /Synced main at d{12}/);
  assert.equal(requests.some((request) => request.path.endsWith("/validation")), false,
    "sync must not start automated agent Validation");
});

test("persisted sync conflict recovery offers IDE inspection and a guarded abort", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  const requests = [];
  let recovery = {
    attempt_id: "sync-attempt-1", state: "CONFLICT", base_sha: "d".repeat(40), prior_task_sha: "c".repeat(40),
    current_candidate_sha: "c".repeat(40), can_abort: true, error_message: null,
  };
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push({ path, options });
    if (path.endsWith("/live/history")) return response(url, history());
    if (path.endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: [], untracked_files: [], branch: "agent/task-1", commit_sha: "c".repeat(40), state_token: "clean", diff: "",
    });
    if (path.endsWith("/sync-recovery")) return response(url, { recovery });
    if (path.endsWith("/sync/view-conflicts")) return response(url, { status: "OPENED" });
    if (path.endsWith("/sync/abort")) {
      assert.equal(JSON.parse(options.body).confirmed, true);
      recovery = null;
      return response(url, { status: "ABORTED" });
    }
    return response(url, []);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const reviewTask = { ...task("REVIEW", "IMPLEMENTATION_COMPLETE"), base_commit_sha: "b".repeat(40),
    latest_task_commit_sha: "c".repeat(40), worktree_path: "C:/work/task-1", base_branch: "main" };
  testing.render(createElement(ToastProvider, null, createElement(TicketPanel, {
    task: reviewTask, queue: null, onClose() {}, onChanged() {},
  })));

  const recoveryNotice = await testing.screen.findByRole("alert");
  assert.match(recoveryNotice.textContent, /sync stopped on conflicts/i);
  testing.fireEvent.click(testing.screen.getByRole("button", { name: "View Conflicts" }));
  await testing.waitFor(() => assert.ok(requests.some((request) => request.path.endsWith("/sync/view-conflicts"))));
  testing.fireEvent.click(testing.screen.getByRole("button", { name: "Abort sync" }));
  const confirmation = await testing.screen.findByRole("dialog", { name: "Abort sync" });
  assert.match(confirmation.textContent, /clear its conflict markers\/index state/i);
  assert.match(confirmation.textContent, /does not discard edits made after the conflict snapshot/i);
  assert.equal(requests.some((request) => request.path.endsWith("/sync/abort")), false);
  testing.fireEvent.click(testing.within(confirmation).getByRole("button", { name: "Confirm abort" }));
  await testing.waitFor(() => assert.ok(requests.some((request) => request.path.endsWith("/sync/abort"))));
  assert.equal(testing.screen.queryByText(/sync stopped on conflicts/i), null);
  assert.ok(testing.screen.getByRole("button", { name: "Sync with main" }));
});

test("committed manual sync resolution can be finalized but not aborted", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push({ path, options });
    if (path.endsWith("/live/history")) return response(url, history());
    if (path.endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: [], untracked_files: [], branch: "agent/task-1", commit_sha: "e".repeat(40), state_token: "clean", diff: "",
    });
    if (path.endsWith("/sync-recovery")) return response(url, { recovery: {
      attempt_id: "sync-attempt-2", state: "RESOLUTION_COMMITTED", base_sha: "d".repeat(40), prior_task_sha: "c".repeat(40),
      current_candidate_sha: "e".repeat(40), can_abort: false, error_message: null,
    } });
    if (path.endsWith("/sync/retry")) return response(url, {
      status: "SYNCED", synced_base_sha: "d".repeat(40), candidate_sha: "e".repeat(40),
    });
    return response(url, []);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const reviewTask = { ...task("REVIEW", "IMPLEMENTATION_COMPLETE"), base_commit_sha: "b".repeat(40),
    latest_task_commit_sha: "c".repeat(40), worktree_path: "C:/work/task-1", base_branch: "main" };
  testing.render(createElement(ToastProvider, null, createElement(TicketPanel, {
    task: reviewTask, queue: null, onClose() {}, onChanged() {},
  })));
  assert.ok(await testing.screen.findByRole("button", { name: "Finish sync" }));
  assert.equal(testing.screen.queryByRole("button", { name: "Abort sync" }), null);
  testing.fireEvent.click(testing.screen.getByRole("button", { name: "Finish sync" }));
  await testing.waitFor(() => assert.ok(requests.some((request) => request.path.endsWith("/sync/retry"))));
  assert.equal(requests.filter((request) => request.path.endsWith("/sync" )).length, 0,
    "finalizing a manual resolution must not replay the merge operation");
});

test("merge eligibility uses current Check sync without a Validation snapshot", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push({ path, options });
    if (path.endsWith("/live/history")) return response(url, history());
    if (path.endsWith("/runs")) return response(url, []);
    if (path.endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: [], untracked_files: [], branch: "agent/task-1", commit_sha: "c".repeat(40), state_token: "clean",
    });
    if (path.endsWith("/complete-preview")) return response(url, { ready: false, reason: "BRANCH_CHANGES" });
    if (path.endsWith("/merge-preview")) return response(url, {
      eligible: true, sync_status: "IN_SYNC", preview_id: "preview-no-validation", base_branch: "main",
      checked_base_sha: "b".repeat(40), task_sha: "c".repeat(40), candidate_sha: "c".repeat(40),
    });
    return response(url, []);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const reviewTask = { ...task("REVIEW", "IMPLEMENTATION_COMPLETE"), base_commit_sha: "b".repeat(40),
    latest_task_commit_sha: "c".repeat(40), worktree_path: "C:/work/task-1", base_branch: "main", active_validation_snapshot_id: null };
  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: reviewTask, queue: null, onClose() {}, onChanged() {} })));
  const mergeButton = await testing.screen.findByRole("button", { name: /Merge back to working branch/i });
  assert.equal(mergeButton.disabled, false);
  testing.fireEvent.click(mergeButton);
  const confirmation = await testing.screen.findByRole("dialog", { name: /confirm merge back/i });
  assert.equal(testing.within(confirmation).getByRole("button", { name: /Confirm merge/i }).disabled, false);
  assert.equal(requests.some((request) => /\/validation|\/test/.test(request.path)), false);
});

test("Review and merge confirmation remind developers without adding an acknowledgement gate", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  const requests = [];
  let changed = 0;
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push({ path, options });
    if (path.endsWith("/live/history")) return response(url, history());
    if (path.endsWith("/runs")) return response(url, []);
    if (path.endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: [], untracked_files: [], branch: "agent/task-1", commit_sha: "c".repeat(40), state_token: "clean",
    });
    if (path.endsWith("/complete-preview")) return response(url, { ready: false, reason: "BRANCH_CHANGES" });
    if (path.endsWith("/merge-preview")) return response(url, {
      eligible: true, sync_status: "IN_SYNC", preview_id: "preview-1", base_branch: "main",
      checked_base_sha: "b".repeat(40), task_sha: "c".repeat(40), checked_at: "2026-01-01T00:00:00.000Z", candidate_sha: "c".repeat(40),
    });
    if (path.endsWith("/merge")) return response(url, { merge_attempt_id: "merge-1", status: "MERGED", resolution: "MERGED" });
    return response(url, []);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const readyTask = { ...task("REVIEW", "READY_TO_MERGE"), base_commit_sha: "b".repeat(40),
    latest_task_commit_sha: "c".repeat(40), worktree_path: "C:/work/task-1", base_branch: "main",
    active_validation_snapshot_id: "snapshot-1", validation_snapshot_current: true };
  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: readyTask, queue: null, onClose() {}, onChanged() { changed += 1; } })));

  const mergeButton = await testing.screen.findByRole("button", { name: /Merge back to working branch/i });
  const reviewReminder = await testing.screen.findByRole("note", { name: "Developer testing reminder" });
  assert.match(reviewReminder.textContent, /test the app.*task worktree.*review the implemented code/i);
  assert.match(reviewReminder.textContent, /Check sync.*Git state only/i);
  assert.equal(mergeButton.disabled, false);
  assert.equal(requests.some((request) => request.options.method === "POST" && request.path.endsWith("/merge")), false,
    "a fresh Check sync state still requires explicit merge approval");
  testing.fireEvent.click(mergeButton);
  const confirmation = await testing.screen.findByRole("dialog", { name: /confirm merge back/i });
  assert.match(confirmation.textContent, /main/);
  const mergeReminder = testing.within(confirmation).getByRole("note", { name: "Before merge reminder" });
  assert.match(mergeReminder.textContent, /test the app.*task worktree.*review the implemented code/i,
    "merge confirmation reminds the developer to test the task worktree and review the code");
  assert.match(mergeReminder.textContent, /Check sync.*Git state only/i);
  assert.equal(testing.within(confirmation).queryByRole("checkbox"), null,
    "testing and review remain developer-owned; no acknowledgement is required");
  assert.equal(requests.some((request) => /\/validation|\/test/.test(request.path)), false,
    "the reminder does not trigger Validation or app tests");
  assert.equal(requests.some((request) => request.options.method === "POST" && request.path.endsWith("/merge")), false,
    "opening confirmation has no Git side effect");
  testing.fireEvent.click(testing.within(confirmation).getByRole("button", { name: /cancel/i }));
  assert.equal(requests.some((request) => request.options.method === "POST" && request.path.endsWith("/merge")), false,
    "cancel leaves merge state untouched");
  testing.fireEvent.click(await testing.screen.findByRole("button", { name: /Merge back to working branch/i }));
  testing.fireEvent.click(await testing.screen.findByRole("button", { name: /Confirm merge/i }));
  await testing.waitFor(() => assert.ok(requests.some((request) => request.options.method === "POST" && request.path.endsWith("/merge"))));
  const posted = requests.find((request) => request.options.method === "POST" && request.path.endsWith("/merge"));
  assert.deepEqual(JSON.parse(posted.options.body), { confirmed: true, preview_id: "preview-1" });
  await testing.waitFor(() => assert.ok(changed > 0, "successful merge refreshes the board state"));
  assert.equal(requests.some((request) => /\/validation|\/test/.test(request.path)), false,
    "confirming merge does not trigger Validation or application testing");
});

test("stale merge response remains visible and never refreshes as successfully merged", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  const requests = [];
  let changed = 0;
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push({ path, options });
    if (path.endsWith("/live/history")) return response(url, history());
    if (path.endsWith("/runs")) return response(url, []);
    if (path.endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: [], untracked_files: [], branch: "agent/task-1", commit_sha: "c".repeat(40), state_token: "clean",
    });
    if (path.endsWith("/complete-preview")) return response(url, { ready: false, reason: "BRANCH_CHANGES" });
    if (path.endsWith("/merge-preview")) return response(url, { eligible: true, preview_id: "preview-stale", base_branch: "main", candidate_sha: "c".repeat(40) });
    if (path.endsWith("/merge")) return new Response(JSON.stringify({ error: "Check sync is stale; Sync with main and try again." }), {
      status: 409, headers: { "content-type": "application/json" },
    });
    return response(url, []);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const readyTask = { ...task("REVIEW", "READY_TO_MERGE"), base_commit_sha: "b".repeat(40),
    latest_task_commit_sha: "c".repeat(40), worktree_path: "C:/work/task-1", base_branch: "main",
    active_validation_snapshot_id: "snapshot-1", validation_snapshot_current: true };
  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: readyTask, queue: null, onClose() {}, onChanged() { changed += 1; } })));
  testing.fireEvent.click(await testing.screen.findByRole("button", { name: /Merge back to working branch/i }));
  const confirmation = await testing.screen.findByRole("dialog", { name: /confirm merge back/i });
  testing.fireEvent.click(testing.within(confirmation).getByRole("button", { name: /Confirm merge/i }));
  await testing.waitFor(() => assert.match(testing.screen.getByRole("status").textContent, /stale/i));
  assert.equal(changed, 0, "failed integration must not be presented as a completed merge");
});

test("merge back blocks a base that moved since Check sync and directs Sync with main", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push({ path, options });
    if (path.endsWith("/live/history")) return response(url, history());
    if (path.endsWith("/runs")) return response(url, []);
    if (path.endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: [], untracked_files: [], branch: "agent/task-1", commit_sha: "c".repeat(40), state_token: "clean",
    });
    if (path.endsWith("/complete-preview")) return response(url, { ready: false, reason: "BRANCH_CHANGES" });
    if (path.endsWith("/merge-preview")) return response(url, {
      eligible: false, sync_status: "STALE", reasons: ["The current base moved. Sync with main, then Check sync again."],
      base_branch: "main", checked_base_sha: "d".repeat(40), recorded_base_sha: "b".repeat(40), candidate_sha: "c".repeat(40),
    });
    return response(url, []);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const reviewTask = { ...task("REVIEW", "IMPLEMENTATION_COMPLETE"), base_commit_sha: "b".repeat(40),
    latest_task_commit_sha: "c".repeat(40), worktree_path: "C:/work/task-1", base_branch: "main", active_validation_snapshot_id: null };
  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: reviewTask, queue: null, onClose() {}, onChanged() {} })));
  const mergeButton = await testing.screen.findByRole("button", { name: /Merge back to working branch/i });
  assert.equal(mergeButton.disabled, true);
  assert.match(testing.screen.getByText(/Sync with main, then Check sync again/i).textContent, /Sync with main/i);
  assert.equal(testing.screen.queryByRole("dialog", { name: /confirm merge back/i }), null);
  assert.equal(requests.some((request) => request.options.method === "POST" && request.path.endsWith("/merge")), false);
});

test("merge-conflict UI exposes safe recovery actions and reports a rejected Retry", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push({ path, options });
    if (path.endsWith("/live/history")) return response(url, history());
    if (path.endsWith("/runs")) return response(url, []);
    if (path.endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: [], untracked_files: [], branch: "agent/task-1", commit_sha: "c".repeat(40), state_token: "clean",
    });
    if (path.endsWith("/complete-preview")) return response(url, { ready: false, reason: "BRANCH_CHANGES" });
    if (path.endsWith("/merge-preview")) return response(url, {
      eligible: false, reason: "MERGE_CONFLICT", status: "MERGE_CONFLICT", merge_attempt_id: "merge-conflict-1",
    });
    if (path.endsWith("/merge/view-conflicts")) return response(url, { status: "OPENED" });
    if (path.endsWith("/merge/retry")) return new Response(JSON.stringify({ error: "Resolve and commit the conflicts before retrying." }), {
      status: 409, headers: { "content-type": "application/json" },
    });
    if (path.endsWith("/merge/abort")) return response(url, { status: "ABORTED" });
    return response(url, []);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const conflictTask = { ...task("REVIEW", "MERGE_CONFLICT"), base_commit_sha: "b".repeat(40),
    latest_task_commit_sha: "c".repeat(40), worktree_path: "C:/work/task-1", base_branch: "main" };
  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: conflictTask, queue: null, onClose() {}, onChanged() {} })));

  const panel = testing.screen.getByRole("complementary");
  const abort = testing.within(panel).getByRole("button", { name: /Abort merge/i });
  assert.ok(abort);
  assert.ok(testing.within(panel).getByRole("button", { name: /Retry/i }));
  assert.equal(requests.some((request) => request.options.method === "POST"), false,
    "conflict recovery controls must not perform Git operations before a user choice");
  testing.fireEvent.click(testing.within(panel).getByRole("button", { name: /View Conflicts/i }));
  await testing.waitFor(() => assert.ok(requests.some((request) => request.options.method === "POST" && request.path.endsWith("/merge/view-conflicts"))));
  testing.fireEvent.click(testing.within(panel).getByRole("button", { name: /Retry/i }));
  await testing.waitFor(() => assert.ok(testing.screen.getAllByRole("status")
    .some((status) => /resolve and commit/i.test(status.textContent))));
  assert.equal(requests.some((request) => request.options.method === "POST" && request.path.endsWith("/merge/retry")), true);
  assert.equal(requests.some((request) => request.options.method === "POST" && request.path.endsWith("/merge/abort")), false,
    "Retry must not implicitly abort the in-progress merge");
  testing.fireEvent.click(abort);
  await testing.waitFor(() => assert.ok(requests.some((request) => request.options.method === "POST" && request.path.endsWith("/merge/abort"))));
});

test("dirty worktree cannot be closed or silently discarded and still offers explicit checkpointing", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method ?? "GET" });
    if (String(url).endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: ["src/dirty.ts"], untracked_files: [], branch: "agent/task-1",
      commit_sha: "a".repeat(40), state_token: "dirty-state",
    });
    if (String(url).endsWith("/complete-preview")) return response(url, { ready: false, reason: "WORKTREE_CHANGES" });
    if (String(url).endsWith("/live/history")) return response(url, history());
    return response(url, []);
  };
  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: task("REVIEW", "IMPLEMENTATION_COMPLETE"), queue: null, onClose() {}, onChanged() {} })));

  const commit = await testing.screen.findByRole("button", { name: "Update checkpoint" });
  assert.equal(testing.screen.queryByRole("button", { name: "Mark as done" }), null);
  assert.equal(commit.disabled, false);
  testing.fireEvent.click(commit);
  const confirmation = await testing.screen.findByRole("dialog", { name: "Confirm checkpoint" });
  assert.match(confirmation.textContent, /src\/dirty\.ts/);
  testing.fireEvent.click(testing.within(confirmation).getByRole("button", { name: "Cancel" }));
  assert.equal(requests.some((request) => request.method === "POST" && request.url.endsWith("/checkpoint")), false);
  assert.equal(requests.some((request) => request.method === "POST" && request.url.endsWith("/complete")), false);
});

test("merge remains blocked until Check sync sees the recorded clean task checkpoint", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method ?? "GET" });
    if (String(url).endsWith("/complete-preview")) return response(url, { ready: false, reason: "BRANCH_CHANGES" });
    if (String(url).endsWith("/merge-preview")) return response(url, {
      eligible: false, sync_status: "BLOCKED", reasons: ["Task HEAD differs from the recorded checkpoint."],
    });
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

  assert.match((await testing.screen.findByText(/Task HEAD differs from the recorded checkpoint/i)).textContent,
    /Task HEAD differs from the recorded checkpoint/i, "the UI should explain why Git readiness is blocked");
  const mergeButton = await testing.screen.findByRole("button", { name: /Merge back to working branch/i });
  assert.equal(mergeButton.disabled, true, "branch changes alone are not merge authorization");
  assert.equal(testing.screen.queryByRole("button", { name: "Mark as done" }), null);
  assert.equal(requests.some((request) => request.method === "POST" && request.url.endsWith("/complete")), false);
  view.unmount();
});

test("checkpoint diff navigates changed files and toggles unified and side-by-side views", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  const requests = [];
  const diff = [
    "diff --git a/src/alpha.ts b/src/alpha.ts", "--- a/src/alpha.ts", "+++ b/src/alpha.ts",
    "@@ -1 +1 @@", "-const alpha = 1;", "+const alpha = 2;", "",
    "diff --git a/src/beta.ts b/src/beta.ts", "--- a/src/beta.ts", "+++ b/src/beta.ts",
    "@@ -1 +1 @@", "-const beta = 1;", "+const beta = 2;", "+<img src=x onerror=alert(1)>", "",
    "diff --git a/src/old-name.ts b/src/new-name.ts", "similarity index 100%",
    "rename from src/old-name.ts", "rename to src/new-name.ts", "",
    "diff --git a/assets/icon.bin b/assets/icon.bin", "Binary files a/assets/icon.bin and b/assets/icon.bin differ", "",
  ].join("\n");
  globalThis.fetch = async (url) => {
    const path = String(url);
    requests.push(path);
    if (path.endsWith("/live/history")) return response(url, history());
    if (path.endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: [], untracked_files: [], branch: "agent/task-1", commit_sha: "c".repeat(40), state_token: "clean",
    });
    if (path.endsWith("/checkpoint-diff")) return response(url, {
      files: ["src/alpha.ts", "src/beta.ts", "src/new-name.ts", "assets/icon.bin"], diff,
      from_sha: "b".repeat(40), to_sha: "c".repeat(40),
    });
    if (path.endsWith("/complete-preview")) return response(url, { ready: false, reason: null });
    if (path.endsWith("/merge-preview")) return response(url, { eligible: true, reason: null });
    return response(url, []);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const reviewTask = { ...task("REVIEW", "IMPLEMENTATION_COMPLETE"), base_commit_sha: "b".repeat(40),
    latest_task_commit_sha: "c".repeat(40), worktree_path: "C:/work/task-1", base_branch: "main",
    active_validation_snapshot_id: "snapshot-1", validation_snapshot_current: false };
  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: reviewTask, queue: null, onClose() {}, onChanged() {} })));

  testing.fireEvent.click(await testing.screen.findByRole("button", { name: /View checkpoint diff/i }));
  const dialog = await testing.screen.findByRole("dialog", { name: /checkpoint diff/i });
  assert.match(testing.screen.getByText("IMPLEMENTATION COMPLETE").textContent, /IMPLEMENTATION COMPLETE/);
  assert.doesNotMatch(dialog.textContent, /MERGED/);
  assert.match(dialog.textContent, /src\/alpha\.ts/);
  assert.match(dialog.textContent, /src\/beta\.ts/);
  assert.match(dialog.textContent, /src\/new-name\.ts/);
  assert.match(dialog.textContent, /assets\/icon\.bin/);
  assert.match(dialog.textContent, /const alpha = 1/);
  testing.fireEvent.click(testing.within(dialog).getByRole("button", { name: "src/beta.ts" }));
  assert.match(dialog.textContent, /const beta = 1/);
  assert.doesNotMatch(dialog.textContent, /const alpha = 1/);
  assert.equal(dialog.querySelector("img"), null, "patch text must not be interpreted as HTML");
  assert.match(dialog.textContent, /<img src=x onerror=alert\(1\)>/);
  testing.fireEvent.click(testing.within(dialog).getByRole("button", { name: /Side by side/i }));
  assert.equal(testing.within(dialog).getByRole("button", { name: /Side by side/i }).getAttribute("aria-pressed"), "true");
  testing.fireEvent.click(testing.within(dialog).getByRole("button", { name: /Unified/i }));
  assert.equal(testing.within(dialog).getByRole("button", { name: /Unified/i }).getAttribute("aria-pressed"), "true");
  testing.fireEvent.click(testing.within(dialog).getByRole("button", { name: "src/new-name.ts" }));
  assert.match(dialog.textContent, /rename from src\/old-name\.ts/);
  testing.fireEvent.click(testing.within(dialog).getByRole("button", { name: "assets/icon.bin" }));
  assert.match(dialog.textContent, /Binary files .* differ/);
  assert.equal(requests.filter((path) => path.endsWith("/checkpoint-diff")).length, 1,
    "file/view selection stays on the pinned diff snapshot");
});

test("empty checkpoint diffs render a clear no-changes state", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith("/live/history")) return response(url, history());
    if (path.endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: [], untracked_files: [], branch: "agent/task-1", commit_sha: "c".repeat(40), state_token: "clean",
    });
    if (path.endsWith("/complete-preview")) return response(url, { ready: false, reason: null });
    if (path.endsWith("/checkpoint-diff")) return response(url, {
      files: [], diff: "", from_sha: "b".repeat(40), to_sha: "c".repeat(40),
    });
    return response(url, []);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const reviewTask = { ...task("REVIEW", "IMPLEMENTATION_COMPLETE"), base_commit_sha: "b".repeat(40),
    latest_task_commit_sha: "c".repeat(40), worktree_path: "C:/work/task-1", base_branch: "main" };
  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: reviewTask, queue: null, onClose() {}, onChanged() {} })));

  testing.fireEvent.click(await testing.screen.findByRole("button", { name: /View checkpoint diff/i }));
  const dialog = await testing.screen.findByRole("dialog", { name: /checkpoint diff/i });
  assert.match(dialog.textContent, /no (changed )?files|no differences/i);
  assert.doesNotMatch(dialog.textContent, /MERGED/);
});

test("closing the diff viewer discards a pending response before reopening", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  let diffCalls = 0;
  let resolveFirstDiff;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith("/live/history")) return response(url, history());
    if (path.endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: [], untracked_files: [], branch: "agent/task-1", commit_sha: "c".repeat(40), state_token: "clean",
    });
    if (path.endsWith("/complete-preview")) return response(url, { ready: false, reason: null });
    if (path.endsWith("/checkpoint-diff")) {
      diffCalls += 1;
      if (diffCalls === 1) return new Promise((resolve) => {
        resolveFirstDiff = () => resolve(response(url, {
          files: ["stale.ts"], diff: "diff --git a/stale.ts b/stale.ts", to_sha: "c".repeat(40),
        }));
      });
      return response(url, { files: ["fresh.ts"], diff: "diff --git a/fresh.ts b/fresh.ts", to_sha: "c".repeat(40) });
    }
    return response(url, []);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const reviewTask = { ...task("REVIEW", "IMPLEMENTATION_COMPLETE"), base_commit_sha: "b".repeat(40),
    latest_task_commit_sha: "c".repeat(40), worktree_path: "C:/work/task-1", base_branch: "main" };
  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: reviewTask, queue: null, onClose() {}, onChanged() {} })));

  testing.fireEvent.click(await testing.screen.findByRole("button", { name: /View checkpoint diff/i }));
  const firstDialog = await testing.screen.findByRole("dialog", { name: /checkpoint diff/i });
  testing.fireEvent.click(testing.within(firstDialog).getByRole("button", { name: "Close" }));
  await testing.waitFor(() => assert.equal(testing.screen.queryByRole("dialog", { name: /checkpoint diff/i }), null));
  await testing.act(async () => { resolveFirstDiff(); });
  assert.equal(testing.screen.queryByText(/stale\.ts/), null, "closed viewers discard pending responses");

  testing.fireEvent.click(await testing.screen.findByRole("button", { name: /View checkpoint diff/i }));
  const reopenedDialog = await testing.screen.findByRole("dialog", { name: /checkpoint diff/i });
  await testing.waitFor(() => assert.match(reopenedDialog.textContent, /fresh\.ts/));
  assert.doesNotMatch(reopenedDialog.textContent, /stale\.ts/);
  assert.equal(diffCalls, 2);
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
  assert.equal(testing.within(startDialog).queryByRole("radio", { name: /Investigation|Implementation/ }), null);
  testing.fireEvent.click(testing.within(startDialog).getByRole("button", { name: "Send" }));
  const confirm = testing.screen.getByRole("alertdialog", { name: "Confirm run" });
  assert.doesNotMatch(confirm.textContent, /without an investigation run|Investigation|Implementation/);
  testing.fireEvent.click(testing.within(confirm).getByRole("button", { name: "Confirm and queue" }));

  await testing.waitFor(() => assert.ok(requests.some((request) => String(request.url).endsWith("/queue"))));
  await testing.act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const queueRequest = requests.find((request) => String(request.url).endsWith("/queue"));
  assert.equal(JSON.parse(queueRequest.options.body).prompt, unresolved.content);
  assert.equal(JSON.parse(queueRequest.options.body).reused_from_input_id, unresolved.id);
});

test("Update checkpoint requires confirmation against the exact displayed diff", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (String(url).endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: ["src/retry.ts"], untracked_files: [], branch: "agent/task-task-1", commit_sha: "a".repeat(40),
      state_token: "tracked-state", diff: "diff --git a/src/retry.ts b/src/retry.ts\n-old guard\n+new guard",
    });
    if (String(url).endsWith("/live/history")) return response(url, history());
    if (String(url).endsWith("/checkpoint")) return response(url, { commit_sha: "b".repeat(40) });
    return response(url, []);
  };
  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: task("REVIEW", "IMPLEMENTATION_COMPLETE"), queue: null, onClose() {}, onChanged() {} })));

  testing.fireEvent.click(await testing.screen.findByRole("button", { name: "Update checkpoint" }));
  const confirmation = await testing.screen.findByRole("dialog", { name: "Confirm checkpoint" });
  assert.match(confirmation.textContent, /src\/retry.ts/);
  assert.match(confirmation.textContent, /new guard/);
  assert.equal(requests.some((request) => String(request.url).endsWith("/checkpoint")), false);
  assert.ok(testing.within(confirmation).getByRole("button", { name: "Update checkpoint" }));
  testing.fireEvent.click(testing.within(confirmation).getByRole("button", { name: "Cancel" }));
  assert.equal(requests.some((request) => String(request.url).endsWith("/checkpoint")), false);
});

test("untracked-file confirmation is explicit; checkpointing alone does not enable merge", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const requests = [];
  const preview = {
    tracked_changes: ["src/retry.ts"], untracked_files: ["tests/retry.test.ts"],
    branch: "agent/task-task-1", commit_sha: "a".repeat(40), state_token: "preview-state",
    diff: "diff --git a/src/retry.ts b/src/retry.ts\n-old guard\n+new guard\ndiff --git a/tests/retry.test.ts b/tests/retry.test.ts\n+new test",
  };
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (String(url).endsWith("/checkpoint-preview")) return response(url, preview);
    if (String(url).endsWith("/live/history")) return response(url, history());
    if (String(url).endsWith("/checkpoint")) return response(url, { commit_sha: "b".repeat(40) });
    if (String(url).endsWith("/merge-preview")) return response(url, { eligible: false, reason: "VALIDATION_REQUIRED" });
    return response(url, []);
  };
  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: task("REVIEW", "IMPLEMENTATION_COMPLETE"), queue: null, onClose() {}, onChanged() {} })));

  testing.fireEvent.click(await testing.screen.findByRole("button", { name: "Update checkpoint" }));
  const confirmation = await testing.screen.findByRole("dialog", { name: "Confirm checkpoint" });
  assert.match(confirmation.textContent, /tests\/retry.test.ts/);
  testing.fireEvent.click(testing.within(confirmation).getByRole("button", { name: "tests\/retry.test.ts" }));
  await testing.waitFor(() => assert.match(confirmation.textContent, /new test/));
  assert.equal(testing.within(confirmation).getByRole("button", { name: "Include files and update checkpoint" }).disabled, false);
  testing.fireEvent.click(testing.within(confirmation).getByRole("button", { name: "Cancel" }));
  assert.equal(requests.some((request) => String(request.url).endsWith("/checkpoint")), false);
  await testing.waitFor(() => assert.equal(testing.screen.getByRole("button", { name: "Update checkpoint" }).disabled, false));

  testing.fireEvent.click(testing.screen.getByRole("button", { name: "Update checkpoint" }));
  const refreshedConfirmation = await testing.screen.findByRole("dialog", { name: "Confirm checkpoint" });
  testing.fireEvent.click(testing.within(refreshedConfirmation).getByRole("button", { name: "Include files and update checkpoint" }));
  await testing.waitFor(() => assert.ok(requests.some((request) => String(request.url).endsWith("/checkpoint"))));
  const post = requests.find((request) => String(request.url).endsWith("/checkpoint"));
  assert.deepEqual(JSON.parse(post.options.body), {
    tracked_changes: preview.tracked_changes,
    include_untracked_files: preview.untracked_files,
    branch: preview.branch,
    commit_sha: preview.commit_sha,
    state_token: preview.state_token,
  });
  const mergeBack = await testing.screen.findByRole("button", { name: /Merge back to working branch/i });
  assert.equal(mergeBack.disabled, true, "checkpoint success without a current Validation never enables merge");
});

test("stale checkpoint confirmation refreshes the preview and requires a new confirmation", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const requests = [];
  let previewReads = 0;
  let checkpointPosts = 0;
  const initialPreview = {
    tracked_changes: ["src/comment.ts"], untracked_files: [], branch: "agent/task-1", commit_sha: "a".repeat(40),
    state_token: "initial-state", diff: "diff --git a/src/comment.ts b/src/comment.ts\n-old comment\n+agent comment",
  };
  const latestPreview = {
    ...initialPreview, state_token: "latest-state",
    diff: "diff --git a/src/comment.ts b/src/comment.ts\n-old comment\n+user-edited comment",
  };
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push({ path, options });
    if (path.endsWith("/checkpoint-preview")) {
      previewReads++;
      return response(url, previewReads <= 2 ? initialPreview : latestPreview);
    }
    if (path.endsWith("/live/history")) return response(url, history());
    if (path.endsWith("/checkpoint")) {
      checkpointPosts++;
      return checkpointPosts === 1
        ? new Response(JSON.stringify({ error: "Task worktree or Git state changed; review the checkpoint contents again." }),
          { status: 409, headers: { "content-type": "application/json" } })
        : response(url, { commit_sha: "b".repeat(40) });
    }
    return response(url, []);
  };

  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: task("REVIEW", "WORK_COMPLETE"), queue: null, onClose() {}, onChanged() {} })));
  testing.fireEvent.click(await testing.screen.findByRole("button", { name: "Update checkpoint" }));
  let confirmation = await testing.screen.findByRole("dialog", { name: "Confirm checkpoint" });
  assert.match(confirmation.textContent, /agent comment/);
  testing.fireEvent.click(testing.within(confirmation).getByRole("button", { name: "Update checkpoint" }));

  await testing.waitFor(() => assert.equal(checkpointPosts, 1));
  confirmation = await testing.screen.findByRole("dialog", { name: "Confirm checkpoint" });
  await testing.waitFor(() => assert.match(confirmation.textContent, /user-edited comment/));
  assert.doesNotMatch(confirmation.textContent, /agent comment/);
  assert.equal(checkpointPosts, 1, "refreshing a stale preview must not retry the commit automatically");
  testing.fireEvent.click(testing.within(confirmation).getByRole("button", { name: "Update checkpoint" }));
  await testing.waitFor(() => assert.equal(checkpointPosts, 2));
  const posts = requests.filter((request) => request.path.endsWith("/checkpoint"));
  assert.equal(JSON.parse(posts[1].options.body).state_token, "latest-state");
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

test("a late checkpoint-diff response cannot leak across a ticket switch", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  let resolveFirstDiff;
  let firstDiffRequested = false;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith("/live/history")) return response(url, history());
    if (path.endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: [], untracked_files: [], branch: "agent/task", commit_sha: "c".repeat(40), state_token: "clean",
    });
    if (path.endsWith("/checkpoint-diff") && path.includes("task-1")) {
      firstDiffRequested = true;
      return new Promise((resolve) => { resolveFirstDiff = () => resolve(response(url, {
        files: ["first-only.ts"], diff: "diff --git a/first-only.ts b/first-only.ts", to_sha: "c".repeat(40),
      })); });
    }
    if (path.endsWith("/checkpoint-diff")) return response(url, {
      files: ["second-only.ts"], diff: "diff --git a/second-only.ts b/second-only.ts", to_sha: "d".repeat(40),
    });
    if (path.endsWith("/complete-preview")) return response(url, { ready: false, reason: null });
    return response(url, []);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const makeTask = (id) => ({ ...task("REVIEW", "IMPLEMENTATION_COMPLETE"), id, base_commit_sha: "b".repeat(40),
    latest_task_commit_sha: "c".repeat(40), worktree_path: `C:/work/${id}`, base_branch: "main" });
  const view = testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: makeTask("task-1"), queue: null, onClose() {}, onChanged() {} })));
  testing.fireEvent.click(await testing.screen.findByRole("button", { name: /View checkpoint diff/i }));
  await testing.waitFor(() => assert.equal(firstDiffRequested, true));
  view.rerender(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: makeTask("task-2"), queue: null, onClose() {}, onChanged() {} })));
  await testing.act(async () => { resolveFirstDiff(); });
  assert.equal(testing.screen.queryAllByText(/first-only\.ts/).length, 0,
    "a response for the previous task must be discarded");
  testing.fireEvent.click(await testing.screen.findByRole("button", { name: /View checkpoint diff/i }));
  const dialog = await testing.screen.findByRole("dialog", { name: /checkpoint diff/i });
  assert.match(dialog.textContent, /second-only\.ts/);
  assert.doesNotMatch(dialog.textContent, /first-only\.ts/);
});

test("Review exposes a read-only Check sync action instead of agent Validation", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  let checkResponse = { status: "IN_SYNC", in_sync: true, base_sha: "b".repeat(40),
    recorded_base_sha: "b".repeat(40), task_sha: "c".repeat(40), branch: "agent/task-1", base_moved: false,
    checked_at: "2026-01-01T00:00:00.000Z", reasons: [] };
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/live/history")) return response(url, history());
    if (String(url).endsWith("/checkpoint-preview")) return response(url, { tracked_changes: [], untracked_files: [],
      branch: "agent/task-1", commit_sha: "c".repeat(40), state_token: "clean" });
    if (String(url).endsWith("/complete-preview")) return response(url, { ready: false, reason: null });
    if (String(url).endsWith("/check-sync")) return response(url, checkResponse);
    return response(url, []);
  };
  const eligibleTask = { ...task("REVIEW", "IMPLEMENTATION_COMPLETE"), base_commit_sha: "b".repeat(40),
    latest_task_commit_sha: "c".repeat(40), worktree_path: "C:/work/task-1", base_branch: "main" };
  testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: eligibleTask, queue: null, onClose() {}, onChanged() {} })));
  assert.equal(testing.screen.queryByRole("button", { name: "Validate" }), null);
  const check = await testing.screen.findByRole("button", { name: "Check sync" });
  assert.equal(check.disabled, false);
  assert.equal(requests.some((request) => request.url.endsWith("/check-sync")), false,
    "the readiness check waits for an explicit user action");
  testing.fireEvent.click(check);
  await testing.waitFor(() => assert.ok(requests.some((request) => request.url.endsWith("/check-sync"))));
  const get = requests.find((request) => request.url.endsWith("/check-sync"));
  assert.equal(get.options.method ?? "GET", "GET");
  assert.equal(requests.some((request) => request.url.endsWith("/validation")), false,
    "Check sync must not start an agent Validation run");
  const checked = await testing.screen.findByRole("status");
  assert.match(checked.textContent, /Git.*in sync/i);
  assert.match(checked.textContent, /Git-state check only, not application testing or code review/i);

  checkResponse = { status: "STALE", in_sync: false, base_sha: "d".repeat(40), recorded_base_sha: "b".repeat(40),
    task_sha: "c".repeat(40), branch: "agent/task-1", base_moved: true,
    checked_at: "2026-01-01T00:05:00.000Z", reasons: ["The current base is not an ancestor."] };
  testing.fireEvent.click(check);
  const stale = await testing.screen.findByRole("alert");
  assert.match(stale.textContent, /current base d{12} is not in the task history/i);
  assert.match(stale.textContent, /base moved from recorded b{12} to d{12}/i);
  assert.equal(requests.filter((request) => request.url.endsWith("/check-sync")).length, 2);
});

test("Review never exposes the agent Validate action", async (t) => {
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
  const baseTask = { ...task("REVIEW", "IMPLEMENTATION_COMPLETE"), base_commit_sha: "b".repeat(40),
    latest_task_commit_sha: "c".repeat(40), worktree_path: "C:/work/task-1", base_branch: "main" };
  const cases = [
    { task: { ...baseTask, review_tag: "INVESTIGATION_COMPLETE" }, queue: null },
    { task: { ...baseTask, latest_task_commit_sha: null }, queue: null },
    { task: { ...baseTask, review_tag: "VALIDATION_FAILED" }, queue: null },
    { task: baseTask, queue: { jobs: [{ task_id: "task-3", run_id: "running", run_status: "RUNNING" }] } },
  ];
  for (const [index, item] of cases.entries()) {
    const view = testing.render(createElement(ToastProvider, null,
      createElement(TicketPanel, { task: { ...item.task, id: `task-${index}` }, queue: item.queue,
        onClose() {}, onChanged() {} })));
    assert.equal(testing.screen.queryByRole("button", { name: "Validate" }), null,
      `Review case ${index} must not offer agent Validation`);
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

async function mountPanelWithHistorySnapshot(t, snapshot, runs = []) {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => response(url, String(url).endsWith("/live/history") ? snapshot
    : String(url).endsWith("/runs") ? runs : []);
  t.after(() => { globalThis.fetch = originalFetch; });
  const view = testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: task("IN_PROGRESS", "WORK_COMPLETE"), queue: null, onClose() {}, onChanged() {} })));
  t.after(() => view.unmount());
  return { testing, view };
}

async function mountPanelWithRunningSocket(t) {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const sockets = [];
  class FakeWebSocket {
    constructor(url) { this.url = url; this.listeners = new Map(); sockets.push(this); }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    close() { for (const listener of this.listeners.get("close") ?? []) listener({}); }
    emit(frame) {
      for (const listener of this.listeners.get("message") ?? []) listener({ data: JSON.stringify(frame) });
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  Object.defineProperty(globalThis, "location", { configurable: true, value: sharedDom.window.location });
  let snapshot = { ...history(), session_id: "session-1", active_run_id: "run-1" };
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith("/live/history")) return response(url, snapshot);
    if (path.endsWith("/runs")) return response(url, [{
      id: "run-1", stage: "WORK", sequence: 1, status: "RUNNING", reason_code: null,
      error_message: null, started_at: new Date().toISOString(), completed_at: null, handover: null,
    }]);
    return response(url, []);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
    else delete globalThis.location;
  });
  const view = testing.render(createElement(ToastProvider, null, createElement(TicketPanel, {
    task: { ...task("IN_PROGRESS", "WORK_COMPLETE"), working_session_id: "session-1" },
    queue: { max_concurrent_agents: 1, active_count: 1, jobs: [{
      job_id: "job-1", run_id: "run-1", task_id: "task-1", title: "Task", stage: "WORK",
      queue_position: null, job_status: "CLAIMED", run_status: "RUNNING",
    }] },
    onClose() {}, onChanged() {},
  })));
  t.after(() => view.unmount());
  await testing.waitFor(() => assert.ok(sockets.length > 0));
  await testing.waitFor(() => assert.ok(sockets.at(-1).listeners.get("message")?.size));
  return { testing, socket: sockets.at(-1), getSocket: () => sockets.at(-1), setSnapshot: (next) => { snapshot = next; }, view };
}

test("Live history removes failed-attempt deltas when Pi schedules a retry", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  const events = [
    { sequence: 1, type: "message_update", data: { subtype: "text_delta", delta: "discard this partial answer" } },
    { sequence: 2, type: "auto_retry_start", data: { attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "HTTP 503" } },
    { sequence: 3, type: "message_update", data: { subtype: "text_delta", delta: "final answer" } },
  ].map((event) => ({
    ...event, eventId: `event-${event.sequence}`, taskId: "task-1", runId: "run-1",
    timestamp: new Date().toISOString(),
  }));
  const snapshot = { ...history(), session_id: "session-1", cursor: 3, provisional_events: events };
  globalThis.fetch = async (url) => response(url, String(url).endsWith("/live/history") ? snapshot : []);
  t.after(() => { globalThis.fetch = originalFetch; });
  const view = testing.render(createElement(ToastProvider, null,
    createElement(TicketPanel, { task: task("IN_PROGRESS", "WORK_COMPLETE"), queue: null, onClose() {}, onChanged() {} })));
  t.after(() => view.unmount());

  await testing.screen.findByText(/final answer/);
  assert.equal(view.container.querySelector(".live-provisional")?.textContent, "final answer");
  assert.equal(testing.screen.queryByText(/discard this partial answer/), null);
});

test("Live shows a formatted running tool row and reveals its output when the tool result arrives", async (t) => {
  const { testing, getSocket, setSnapshot, view } = await mountPanelWithRunningSocket(t);
  const timestamp = new Date().toISOString();
  const assistantEntry = {
    id: "session-1:assistant-tool", entry_id: "assistant-tool", session_id: "session-1", run_id: "run-1", timestamp,
    role: "assistant", message: { role: "assistant", content: [
      { type: "toolCall", id: "bash-call-1", name: "bash", arguments: { command: "python -c print('hello')" } },
    ] },
  };
  const appCss = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");

  await testing.act(async () => getSocket().emit({ sequence: 1, type: "tool_execution_start", data: {
    toolCallId: "bash-call-1", toolName: "bash", args: { command: "python -c print('hello')" },
  } }));
  assert.equal(view.container.querySelector(".live-provisional"), null,
    "tool start is represented by the call row, not a raw provisional log line");
  setSnapshot({ ...history(), session_id: "session-1", active_run_id: "run-1", cursor: 2, entries: [assistantEntry] });
  await testing.act(async () => getSocket().emit({ sequence: 2, type: "entry_appended", data: { entryId: assistantEntry.entry_id } }));
  await testing.screen.findByText("python -c print('hello')");
  const runningCalls = view.container.querySelector(".live-tool-calls-running");
  assert.ok(runningCalls, "the assistant tool call should appear while the run is active");
  const activeTarget = [...runningCalls.querySelectorAll("span.x1g3ib7")]
    .find((target) => target.parentElement?.querySelector("span.xqwr325"));
  assert.equal(activeTarget?.textContent, "python -c print('hello')",
    "the shimmer selector resolves to the target of the running tool row");
  assert.equal(runningCalls.querySelector('[role="button"]'), null,
    "a running tool has no result disclosure yet");
  assert.match(appCss, /live-tool-calls-running div:has\(> span\.xqwr325\) > span\.x1g3ib7/,
    "the running command target receives the shimmer treatment");
  assert.doesNotMatch(view.container.textContent, /\[tool\] bash/,
    "tool execution events should not be duplicated as raw log lines");

  const toolResult = {
    id: "session-1:bash-result", entry_id: "bash-result", session_id: "session-1", run_id: "run-1", timestamp,
    role: "tool", message: { role: "toolResult", toolCallId: "bash-call-1", toolName: "bash",
      content: [{ type: "text", text: "Current directory:\nhello" }], isError: false },
  };
  setSnapshot({ ...history(), session_id: "session-1", active_run_id: "run-1", cursor: 3, entries: [assistantEntry, toolResult] });
  await testing.act(async () => getSocket().emit({ sequence: 3, type: "entry_appended", data: { entryId: toolResult.entry_id } }));
  const resultRow = await testing.waitFor(() => {
    const row = view.container.querySelector(".live-tool-calls [role=button]");
    assert.equal(row?.getAttribute("aria-expanded"), "false");
    return row;
  });
  testing.fireEvent.click(resultRow);
  await testing.waitFor(() => assert.equal(view.container.querySelector(".live-tool-output")?.textContent, "Current directory:\nhello"));
  assert.ok(view.container.querySelector(".live-tool-output"), "the completed call reveals terminal-formatted output");
  assert.equal(view.container.querySelector(".live-tool-calls-running"), null);
});

test("Live shows compaction while active, then a collapsed expandable summary", async (t) => {
  const { testing, socket } = await mountPanelWithRunningSocket(t);
  await testing.act(async () => socket.emit({ sequence: 1, type: "compaction_start", data: { reason: "threshold" } }));
  const status = await testing.screen.findByText(/Compacting context/i);
  assert.ok(status.classList.contains("compaction-status"));
  const appCss = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
  assert.match(appCss, /\.compaction-status::after\s*\{[^}]*animation:\s*compaction-shimmer/);
  const summary = "Goal: keep retries bounded. Next: run the regression tests.";
  await testing.act(async () => socket.emit({ sequence: 2, type: "compaction_end", data: {
    reason: "threshold", aborted: false, willRetry: false, summary,
  } }));
  await testing.waitFor(() => assert.equal(testing.screen.queryByText(/Compacting context/i), null));
  const disclosure = await testing.screen.findByText("Compaction summary");
  const details = disclosure.closest("details");
  assert.ok(details);
  assert.equal(details.open, false);
  testing.fireEvent.click(disclosure);
  assert.equal(details.open, true);
  await testing.screen.findByText(summary);
  assert.equal(testing.screen.queryByText(summary, { selector: ".live-provisional" }), null);
});

test("Live shows persisted compaction failure after refresh without replay events", async (t) => {
  const { testing } = await mountPanelWithHistorySnapshot(t, history(), [{
    id: "run-1", stage: "WORK", sequence: 1, status: "FAILED", reason_code: null,
    error_message: "Summarization failed: generation hit the token cap", started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(), handover: null,
  }]);
  const alert = await testing.screen.findByRole("alert");
  assert.match(alert.textContent, /Summarization failed: generation hit the token cap/);
});

test("Live explains when Pi's compaction ends without producing a summary", async (t) => {
  const { testing, socket, view } = await mountPanelWithRunningSocket(t);
  await testing.act(async () => socket.emit({ sequence: 1, type: "compaction_start", data: { reason: "overflow" } }));
  await testing.screen.findByText(/Compacting context/i);
  await testing.act(async () => socket.emit({ sequence: 2, type: "compaction_end", data: {
    reason: "overflow", aborted: false, willRetry: false,
    errorMessage: "Context overflow recovery failed: summary request exceeded the model context window.",
  } }));
  await testing.waitFor(() => assert.equal(testing.screen.queryByText(/Compacting context/i), null));
  const alert = await testing.screen.findByRole("alert");
  assert.match(alert.textContent, /summary request exceeded the model context window/);
  assert.equal(view.container.querySelectorAll(".compaction-summary").length, 0);
});

test("Live history shows compaction as active work after reconnecting mid-compaction", async (t) => {
  const snapshot = {
    ...history(), session_id: "session-1", provisional_events: [{
      eventId: "event-1", sequence: 1, taskId: "task-1", runId: "run-1",
      timestamp: new Date().toISOString(), type: "compaction_start", data: { reason: "threshold" },
    }],
  };
  const { testing } = await mountPanelWithHistorySnapshot(t, snapshot);
  await testing.screen.findByText(/Compacting context/i);
});

test("persisted compaction summaries appear in transcript order after Live history refresh", async (t) => {
  const timestamp = new Date().toISOString();
  const summary1 = "First Pi compaction summary.";
  const summary2 = "Second Pi compaction summary.";
  const entry = (id, role, text) => ({
    id: `session-1:${id}`, entry_id: id, session_id: "session-1", run_id: "run-1", timestamp, role,
    message: { role, content: [{ type: "text", text }] },
  });
  const snapshot = {
    ...history(), session_id: "session-1", entries: [
      entry("assistant-1", "assistant", "Response before first compaction."),
      entry("user-2", "user", "Follow-up after first compaction."),
      entry("assistant-2", "assistant", "Response before second compaction."),
      entry("user-3", "user", "Follow-up after second compaction."),
    ],
    compaction_summaries: [
      { id: "session-1:compaction-1", timestamp, summary: summary1, tokens_before: 4704, after_entry_id: "session-1:assistant-1" },
      { id: "session-1:compaction-2", timestamp, summary: summary2, tokens_before: 8192, after_entry_id: "session-1:assistant-2" },
    ],
    provisional_events: [{ eventId: "event-compact-1", sequence: 1, taskId: "task-1", runId: "run-1",
      timestamp, type: "compaction_end", data: { reason: "threshold", aborted: false, summary: summary1, tokensBefore: 4704 } }],
  };
  const warnings = [];
  const originalConsoleError = console.error;
  console.error = (...args) => {
    if (String(args[0]).includes("unique \"key\" prop")) warnings.push(args);
    originalConsoleError(...args);
  };
  t.after(() => { console.error = originalConsoleError; });
  const { testing, view } = await mountPanelWithHistorySnapshot(t, snapshot);
  await testing.screen.findAllByText("Compaction summary");
  assert.equal(warnings.length, 0, "Live timeline must not emit duplicate React key warnings");
  const details = view.container.querySelectorAll(".compaction-summary");
  assert.equal(details.length, 2, "the persisted summary and its live event are rendered once");
  assert.equal(details[0].open, false);
  assert.equal(details[1].open, false);
  const timeline = [...view.container.querySelectorAll(".live-conversation > .live-message, .live-conversation > .compaction-summary")]
    .map((item) => item.classList.contains("compaction-summary")
      ? `summary:${item.querySelector(".compaction-summary-text")?.textContent}`
      : item.querySelector(".live-message-text")?.textContent);
  assert.deepEqual(timeline, [
    "Response before first compaction.",
    `summary:${summary1}`,
    "Follow-up after first compaction.",
    "Response before second compaction.",
    `summary:${summary2}`,
    "Follow-up after second compaction.",
  ]);
  testing.fireEvent.click(details[0].querySelector("summary"));
  assert.equal(details[0].open, true);
  await testing.screen.findByText(summary1);
});

test("Live places an older-server compaction summary by timestamp when its transcript anchor is absent", async (t) => {
  const base = Date.now();
  const timestamp = (offset) => new Date(base + offset).toISOString();
  const entry = (id, role, text, at) => ({
    id: `session-1:${id}`, entry_id: id, session_id: "session-1", run_id: "run-1", timestamp: timestamp(at), role,
    message: { role, content: [{ type: "text", text }] },
  });
  const snapshot = {
    ...history(), session_id: "session-1", entries: [
      entry("assistant-1", "assistant", "Response before compaction.", 0),
      entry("user-2", "user", "Follow-up after compaction.", 2000),
    ],
    compaction_summaries: [{ id: "session-1:compaction-1", timestamp: timestamp(1000),
      summary: "Legacy server summary.", tokens_before: 4704 }],
  };
  const { testing, view } = await mountPanelWithHistorySnapshot(t, snapshot);
  await testing.screen.findByText("Compaction summary");
  const timeline = [...view.container.querySelectorAll(".live-conversation > .live-message, .live-conversation > .compaction-summary")]
    .map((item) => item.classList.contains("compaction-summary")
      ? `summary:${item.querySelector(".compaction-summary-text")?.textContent}`
      : item.querySelector(".live-message-text")?.textContent);
  assert.deepEqual(timeline, ["Response before compaction.", "summary:Legacy server summary.", "Follow-up after compaction."]);
});

test("completed compaction summary is collapsed by default and expandable", async (t) => {
  const summary = "Goal: keep retries bounded. Next: verify the retry regression.";
  const snapshot = {
    ...history(), session_id: "session-1", provisional_events: [
      { eventId: "event-1", sequence: 1, taskId: "task-1", runId: "run-1",
        timestamp: new Date().toISOString(), type: "compaction_start", data: { reason: "threshold" } },
      { eventId: "event-2", sequence: 2, taskId: "task-1", runId: "run-1",
        timestamp: new Date().toISOString(), type: "compaction_end", data: { reason: "threshold", aborted: false, summary } },
    ],
  };
  const { testing, view } = await mountPanelWithHistorySnapshot(t, snapshot);
  const disclosure = await testing.screen.findByText("Compaction summary");
  const details = disclosure.closest("details");
  assert.ok(details);
  assert.equal(details.open, false);
  testing.fireEvent.click(disclosure);
  assert.equal(details.open, true);
  await testing.screen.findByText(summary);
  assert.equal(view.container.querySelector(".live-provisional")?.textContent ?? "", "");
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
