import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../dist/db.js";

test("production server does not register retired comment read/write routes", { timeout: 30000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kanban-retired-routes-"));
  const databasePath = join(directory, "kanban.sqlite");
  const db = openDatabase(databasePath);
  let child;
  let exited;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (exited) await exited;
    db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('project-1', 'Project', ?, ?, ?)`).run(directory, now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, workflow_state, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'Task', 'Details', 'TODO', ?, ?)`).run(now, now);

  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
    cwd: directory,
    env: { ...process.env, PORT: String(port), KANBAN_DB_PATH: databasePath },
    stdio: ["ignore", "ignore", "pipe"],
  });
  exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    assert.equal(child.exitCode, null, `Server exited during startup: ${stderr}`);
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
      ready = response.ok && (await response.json()).status === "ok";
    } catch { /* Wait for the isolated server to bind its port. */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, `Server did not become ready: ${stderr}`);
  const tasks = await fetch(`${baseUrl}/api/tasks`);
  assert.equal(tasks.status, 200);
  assert.ok((await tasks.json()).some((task) => task.id === "task-1"));

  for (const [method, path] of [
    ["GET", "/api/tasks/task-1/comments"],
    ["POST", "/api/tasks/task-1/comments"],
    ["PATCH", "/api/comments/retired-comment"],
    ["DELETE", "/api/comments/retired-comment"],
  ]) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      ...(["POST", "PATCH"].includes(method) ? {
        headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "must not be saved" }),
      } : {}),
    });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal((await response.json()).message, `Route ${method}:${path} not found`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM run_inputs").get().count, 0);
});
