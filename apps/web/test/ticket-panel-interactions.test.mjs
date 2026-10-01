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

test("current validation requires explicit confirmation before merging to the recorded base", async (t) => {
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
      eligible: true, base_moved: false, base_branch: "main", validated_base_sha: "b".repeat(40), candidate_sha: "c".repeat(40),
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
  assert.equal(mergeButton.disabled, false);
  assert.equal(requests.some((request) => request.options.method === "POST" && request.path.endsWith("/merge")), false,
    "a current passing snapshot never merges automatically");
  testing.fireEvent.click(mergeButton);
  const confirmation = await testing.screen.findByRole("dialog", { name: /confirm merge back/i });
  assert.match(confirmation.textContent, /main/);
  assert.equal(requests.some((request) => request.options.method === "POST" && request.path.endsWith("/merge")), false,
    "opening confirmation has no Git side effect");
  testing.fireEvent.click(testing.within(confirmation).getByRole("button", { name: /cancel/i }));
  assert.equal(requests.some((request) => request.options.method === "POST" && request.path.endsWith("/merge")), false,
    "cancel leaves merge state untouched");
  testing.fireEvent.click(await testing.screen.findByRole("button", { name: /Merge back to working branch/i }));
  testing.fireEvent.click(await testing.screen.findByRole("button", { name: /Confirm merge/i }));
  await testing.waitFor(() => assert.ok(requests.some((request) => request.options.method === "POST" && request.path.endsWith("/merge"))));
  const posted = requests.find((request) => request.options.method === "POST" && request.path.endsWith("/merge"));
  assert.deepEqual(JSON.parse(posted.options.body), { confirmed: true });
  await testing.waitFor(() => assert.ok(changed > 0, "successful merge refreshes the board state"));
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
    if (path.endsWith("/merge-preview")) return response(url, { eligible: true, base_branch: "main", candidate_sha: "c".repeat(40) });
    if (path.endsWith("/merge")) return new Response(JSON.stringify({ error: "Validation snapshot is stale." }), {
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

test("base-moved merge confirmation shows both base SHAs and queues fresh Validation only after approval", async (t) => {
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
      eligible: true, action: "SYNC_BASE", base_moved: true, base_branch: "main",
      validated_base_sha: "b".repeat(40), live_base_sha: "d".repeat(40), candidate_sha: "c".repeat(40),
    });
    if (path.endsWith("/merge")) return response(url, { merge_attempt_id: "merge-2", status: "VALIDATION_QUEUED" });
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
  assert.match(confirmation.textContent, /main/);
  assert.match(confirmation.textContent, new RegExp("b".repeat(12)));
  assert.match(confirmation.textContent, new RegExp("d".repeat(12)));
  assert.equal(requests.some((request) => request.options.method === "POST" && request.path.endsWith("/merge")), false,
    "base sync requires the same explicit confirmation as integration");
  testing.fireEvent.click(testing.within(confirmation).getByRole("button", { name: /Confirm merge/i }));
  await testing.waitFor(() => assert.ok(requests.some((request) => request.options.method === "POST" && request.path.endsWith("/merge"))));
  const posted = requests.find((request) => request.options.method === "POST" && request.path.endsWith("/merge"));
  assert.deepEqual(JSON.parse(posted.options.body), { confirmed: true });
  await testing.waitFor(() => assert.ok(changed > 0));
  assert.doesNotMatch(testing.screen.getByRole("complementary").textContent, /MERGED/,
    "approval starts sync and revalidation; it does not imply integration");
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

  const commit = await testing.screen.findByRole("button", { name: "Commit changes" });
  assert.equal(testing.screen.queryByRole("button", { name: "Mark as done" }), null);
  assert.equal(commit.disabled, false);
  testing.fireEvent.click(commit);
  const confirmation = await testing.screen.findByRole("dialog", { name: "Confirm checkpoint" });
  assert.match(confirmation.textContent, /src\/dirty\.ts/);
  testing.fireEvent.click(testing.within(confirmation).getByRole("button", { name: "Cancel" }));
  assert.equal(requests.some((request) => request.method === "POST" && request.url.endsWith("/checkpoint")), false);
  assert.equal(requests.some((request) => request.method === "POST" && request.url.endsWith("/complete")), false);
});

test("task-branch changes do not merge until a current passing Validation exists", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method ?? "GET" });
    if (String(url).endsWith("/complete-preview")) return response(url, { ready: false, reason: "BRANCH_CHANGES" });
    if (String(url).endsWith("/merge-preview")) return response(url, { eligible: false, reason: "VALIDATION_REQUIRED" });
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

  assert.match(testing.screen.getByText(/validation required/i).textContent, /validation required/i,
    "the UI should explain why merge is unavailable");
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

test("untracked-file confirmation is explicit; checkpointing alone does not enable merge", async (t) => {
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
    if (String(url).endsWith("/merge-preview")) return response(url, { eligible: false, reason: "VALIDATION_REQUIRED" });
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
  const mergeBack = await testing.screen.findByRole("button", { name: /Merge back to working branch/i });
  assert.equal(mergeBack.disabled, true, "checkpoint success without a current Validation never enables merge");
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
  const eligibleTask = { ...task("REVIEW", "IMPLEMENTATION_COMPLETE"), base_commit_sha: "b".repeat(40),
    latest_task_commit_sha: "c".repeat(40), worktree_path: "C:/work/task-1", base_branch: "main" };
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

test("failed Validation retries require a clean worktree at the saved checkpoint", async (t) => {
  const testing = await setupDom(t);
  const { TicketPanel, ToastProvider } = await loadComponents(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/live/history")) return response(url, history());
    if (String(url).endsWith("/checkpoint-preview")) return response(url, {
      tracked_changes: String(url).includes("task-dirty") ? ["changed.ts"] : [],
      untracked_files: [], branch: "agent/task-1",
      commit_sha: String(url).includes("task-stale") ? "d".repeat(40) : "c".repeat(40), state_token: "clean",
    });
    if (String(url).endsWith("/complete-preview")) return response(url, { ready: false, reason: null });
    return response(url, []);
  };
  const baseTask = { ...task("REVIEW", "VALIDATION_FAILED"), base_commit_sha: "b".repeat(40),
    latest_task_commit_sha: "c".repeat(40), worktree_path: "C:/work/task-1", base_branch: "main" };
  for (const [id, shouldEnable] of [["task-clean", true], ["task-dirty", false], ["task-stale", false]]) {
    const view = testing.render(createElement(ToastProvider, null,
      createElement(TicketPanel, { task: { ...baseTask, id }, queue: null, onClose() {}, onChanged() {} })));
    const validate = await testing.screen.findByRole("button", { name: "Validate" });
    await testing.waitFor(() => assert.equal(validate.disabled, !shouldEnable));
    view.unmount();
  }
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
  const baseTask = { ...task("REVIEW", "IMPLEMENTATION_COMPLETE"), base_commit_sha: "b".repeat(40),
    latest_task_commit_sha: "c".repeat(40), worktree_path: "C:/work/task-1", base_branch: "main" };
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
