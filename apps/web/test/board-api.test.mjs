import assert from "node:assert/strict";
import test from "node:test";
import { completeTask, createProject, createTask, deleteProject, deleteTask, loadBoard, loadTaskCompletionStatus, removeQueueJob, reorderQueueJob, stopRun } from "../src/board-api.js";

test("board loading explains empty or non-JSON backend responses", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => new Response(null, { status: 200 });
  await assert.rejects(loadBoard(), /\/api\/board returned an empty response.*current backend/i);

  globalThis.fetch = async () => new Response("<html>dev server</html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  await assert.rejects(loadBoard(), /\/api\/board returned non-JSON data.*current backend/i);

  globalThis.fetch = async () => new Response(JSON.stringify({
    message: "Route GET:/api/board not found", error: "Not Found", statusCode: 404,
  }), { status: 404 });
  await assert.rejects(loadBoard(), /running backend is missing \/api\/board.*restart it/i);

  globalThis.fetch = async () => new Response(null, { status: 500 });
  await assert.rejects(loadBoard(), /KANBAN_BACKEND_PORT.*default 3000/i);
});

test("board actions use the task and queue API contracts", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await createProject("New project", "C:\\repo", "C:\\worktrees");
  await createTask("project/1", "A task", "Task context");
  await deleteTask("task/1");
  await loadTaskCompletionStatus("task/1");
  await completeTask("task/1");
  await reorderQueueJob("job/1", 2);
  await removeQueueJob("job/1");
  await stopRun("run/1");
  await deleteProject("project/1");

  assert.deepEqual(requests.map(({ url, options }) => [url, options.method]), [
    ["/api/projects", "POST"],
    ["/api/tasks", "POST"],
    ["/api/tasks/task%2F1", "DELETE"],
    ["/api/tasks/task%2F1/complete-preview", undefined],
    ["/api/tasks/task%2F1/complete", "POST"],
    ["/api/queue/job%2F1", "PATCH"],
    ["/api/queue/job%2F1", "DELETE"],
    ["/api/runs/run%2F1/stop", "POST"],
    ["/api/projects/project%2F1", "DELETE"],
  ]);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    name: "New project", root_path: "C:\\repo", worktree_root: "C:\\worktrees",
  });
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    project_id: "project/1", title: "A task", description: "Task context",
  });
  assert.deepEqual(JSON.parse(requests[5].options.body), { position: 2 });
});
