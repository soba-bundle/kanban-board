// Optional real-browser acceptance. All API traffic is intercepted; no backend or agent is started.
// PLAYWRIGHT_MODULE: path/URL to playwright-core (or install it locally).
// CHROME_PATH: installed Chromium/Chrome/Edge executable.
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

const modulePath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : "playwright-core");
const server = await createServer({
  root: fileURLToPath(new URL("../", import.meta.url)),
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, hmr: false },
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const timestamp = "2026-01-02T03:04:05Z";
  const task = {
    id: "task-1", project_id: "project-1", title: "Browser acceptance ticket", description: "Review the retry behavior and preserve safe recovery.",
    workflow_state: "REVIEW", review_tag: "WORK_COMPLETE", worktree_path: "C:/acceptance/worktrees/retry-task",
    base_branch: "main", base_commit_sha: "b".repeat(40), latest_task_commit_sha: "c".repeat(40),
    created_at: timestamp, updated_at: timestamp,
  };
  const displayTitle = `${task.title[0].toUpperCase()}${task.title.slice(1)}`;
  const entry = (id, role, content) => ({ id, entry_id: id, session_id: "session-1", run_id: "run-1", timestamp, role, message: { role, content } });
  const snapshot = {
    task_id: task.id, session_id: "session-1", active_run_id: null, cursor: 1, inputs: [], provisional_truncated: false,
    entries: [entry("u", "user", "Check retries"), entry("a", "assistant", [{ type: "text", text: "**Review**\nFirst line\nSecond line\n\n- Tests pass\n\n```ts\nconst safe = true;\n```" }]),
      entry("b", "assistant", [{ type: "text", text: "Ready for human review." }])],
    provisional_events: [{ type: "compaction_start", data: {}, timestamp }], provisional_output: { text: "", thinking: "" }, compaction_summaries: [],
  };
  const requests = [];
  let running = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push({ path, method: route.request().method() });
    let body;
    if (path.endsWith("/board")) body = { columns: { TODO: [], IN_PROGRESS: [], REQUIRES_HUMAN: [], REVIEW: [task], DONE: [] } };
    else if (path.endsWith("/projects")) body = [{ id: "project-1", name: "Acceptance", repo_path: "C:/acceptance/repo" }];
    else if (path.endsWith("/queue")) body = { jobs: running ? [{ task_id: task.id, job_id: "job-1", run_id: "run-1", title: task.title, job_status: "CLAIMED", run_status: "RUNNING" }] : [], active_count: running ? 1 : 0, max_concurrent_agents: 2 };
    else if (path.endsWith("/live/history")) body = snapshot;
    else if (path.endsWith("/runs")) body = [{ id: "run-1", sequence: 1, stage: "WORK", status: "COMPLETED", started_at: timestamp, completed_at: timestamp }];
    else if (path.endsWith("/human-requests")) body = [];
    else if (path.endsWith("/sync-recovery")) body = { recovery: null };
    else if (path.endsWith("/checkpoint-preview")) body = { tracked_changes: ["src/retry.ts"], untracked_files: [], branch: "task/retry", commit_sha: "c".repeat(40), state_token: "fixture", diff: "diff --git a/src/retry.ts b/src/retry.ts\n-old\n+new" };
    else if (path.endsWith("/complete-preview")) body = { ready: false, reason: "WORKTREE_CHANGES" };
    else if (path.endsWith("/merge-preview")) body = { eligible: true, preview_id: "fixture-preview", checked_base_sha: "b".repeat(40), task_sha: "c".repeat(40) };
    else if (path.endsWith("/checkpoint-diff")) body = { files: ["src/retry.ts"], diff: "diff --git a/src/retry.ts b/src/retry.ts\n-old\n+new", to_sha: "c".repeat(40) };
    else if (path.endsWith("/check-sync")) body = { status: "IN_SYNC", base_sha: "b".repeat(40), task_sha: "c".repeat(40), checked_at: timestamp, reasons: [] };
    else throw new Error(`Unexpected API request: ${path}`);
    await route.fulfill({ json: body });
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole("heading", { name: displayTitle }).click();
  const panel = page.getByRole("complementary", { name: `Ticket ${displayTitle}` });
  await panel.getByRole("tabpanel", { name: "Live" }).getByText("Ready for human review.").waitFor();
  assert.equal(await panel.locator(".live-message-header").count(), 0);
  assert.equal(await panel.locator(".astryx-markdown strong").first().textContent(), "Review");
  assert.ok(await panel.locator(".astryx-markdown br").count() >= 2);
  const detailsToggle = panel.getByRole("button", { name: "Show ticket details" });
  assert.equal(await detailsToggle.getAttribute("aria-expanded"), "false");
  await panel.locator(".ticket-title-text").click();
  assert.equal(await detailsToggle.getAttribute("aria-expanded"), "false", "only the chevron toggles Details");
  await detailsToggle.click();
  assert.equal(await panel.getByRole("button", { name: "Hide ticket details" }).getAttribute("aria-expanded"), "true");
  assert.equal(await panel.locator(".ticket-details-content").isVisible(), true);
  await panel.getByRole("button", { name: "Hide ticket details" }).click();
  await panel.getByRole("progressbar", { name: "Compacting context…" }).waitFor();
  const animations = await panel.locator(".astryx-progress-bar-fill").evaluateAll((elements) => elements.map((el) => getComputedStyle(el).animationName));
  assert.ok(animations.every((name) => name === "none"), `Reduced motion: ${animations}`);
  assert.equal(await panel.locator(".ticket-panel-header").getByText(task.worktree_path).count(), 1);
  await panel.getByRole("tab", { name: "Runs (1)" }).click();
  await panel.getByRole("tabpanel", { name: "Runs" }).waitFor();
  await panel.getByRole("tab", { name: "Live", exact: true }).click();
  const input = panel.getByRole("textbox", { name: "Message input" });
  await input.fill("Keep this draft");
  await input.press("Shift+Enter");
  assert.equal(await page.getByRole("dialog", { name: "Start a run" }).count(), 0);
  await input.press("Enter");
  await page.getByRole("dialog", { name: "Start a run" }).getByRole("button", { name: "Cancel", exact: true }).click();
  assert.match(await input.inputValue(), /Keep this draft/);
  const tools = panel.getByRole("button", { name: "Git tools", exact: true });
  await tools.click();
  await page.getByRole("dialog", { name: "Git tools" }).getByRole("button", { name: "Check sync", exact: true }).click();
  await panel.getByText("Git sync check", { exact: true }).waitFor();
  await tools.click();
  await page.keyboard.press("Escape");
  assert.equal(await tools.evaluate((el) => el === document.activeElement), true);
  await tools.click();
  await page.getByRole("dialog", { name: "Git tools" }).getByRole("button", { name: "View checkpoint diff" }).click();
  await page.getByRole("dialog", { name: "Checkpoint diff" }).getByRole("button", { name: "Close", exact: true }).click();
  await panel.getByRole("button", { name: "Update checkpoint", exact: true }).click();
  await page.getByRole("dialog", { name: "Confirm checkpoint" }).getByRole("button", { name: "Cancel", exact: true }).click();
  await panel.getByRole("button", { name: "Merge back to working branch" }).click();
  await page.getByRole("dialog", { name: "Confirm merge back" }).getByRole("button", { name: "Cancel", exact: true }).click();
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    assert.equal(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth), true, `Panel overflows at ${viewport.width}`);
    const body = panel.locator(".ticket-panel-body");
    const bounds = await body.boundingBox();
    assert.ok(bounds.height > 100, `Conversation has usable height at ${viewport.width}: ${bounds.height}`);
    await tools.click();
    const menuBounds = await page.getByRole("dialog", { name: "Git tools" }).boundingBox();
    assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= viewport.width);
    await page.keyboard.press("Escape");
    const close = panel.getByRole("button", { name: "Close ticket", exact: true });
    await close.hover();
    await page.getByRole("tooltip", { name: "Close ticket", exact: true }).waitFor();
    if (process.env.ACCEPTANCE_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.ACCEPTANCE_SCREENSHOT_DIR}/ticket-${viewport.width}.png` });
  }
  // Exercise streamed updates and replacement by persisted history, without a real socket backend.
  running = true;
  snapshot.active_run_id = "run-1";
  snapshot.provisional_events = [];
  let resolveSocket;
  const connected = new Promise((resolve) => { resolveSocket = resolve; });
  await page.routeWebSocket("**/api/**", (socket) => resolveSocket(socket));
  await page.reload();
  await page.getByRole("heading", { name: displayTitle }).click();
  const socket = await connected;
  const send = (sequence, type, data) => socket.send(JSON.stringify({ sequence, type, data, timestamp, eventId: `event-${sequence}`, taskId: task.id, runId: "run-1" }));
  send(2, "message_update", { subtype: "thinking_delta", delta: "Private reasoning stays plain." });
  send(3, "message_update", { subtype: "text_delta", delta: "**Streamed" });
  send(4, "message_update", { subtype: "text_delta", delta: " answer**\nSecond streamed line" });
  await page.waitForFunction(() => document.querySelector(".live-provisional .astryx-markdown strong")?.textContent === "Streamed answer");
  assert.equal(await panel.locator(".live-message-header").count(), 0);
  assert.equal(await panel.locator(".live-provisional .astryx-markdown").getByText("Private reasoning stays plain.").count(), 0);
  snapshot.entries.push(entry("streamed", "assistant", [{ type: "text", text: "**Streamed answer**\nSecond streamed line" }]));
  snapshot.cursor = 5;
  send(5, "entry_appended", {});
  await page.waitForFunction(() => !document.querySelector(".live-provisional") && [...document.querySelectorAll(".astryx-markdown strong")].some((el) => el.textContent === "Streamed answer"));
  assert.equal(await panel.locator(".live-message-header").count(), 0);
  assert.equal(requests.some(({ method }) => method !== "GET"), false, "Preview acceptance must not mutate Git or start agents");
  assert.deepEqual(errors, []);
  console.log("Browser acceptance passed: desktop/narrow, Markdown, title/disclosure, unlabeled chat messages, composer, tabs, progress/reduced motion, Git previews, popover focus and tooltips.");
} finally {
  await browser?.close();
  await server.close();
}
