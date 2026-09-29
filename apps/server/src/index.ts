import Fastify from "fastify";
import lockfile from "proper-lockfile";
import { dirname, resolve } from "node:path";
import { openDatabase } from "./db.js";
import { installLocalRequestGuards } from "./security.js";
import { registerProjectRoutes } from "./projects.js";
import { registerTaskRoutes } from "./tasks.js";
import { registerTaskRunRoutes } from "./task-runs.js";
import { AgentManager } from "./agents/agent-manager.js";
import { HumanRequestService } from "./agents/human-requests.js";
import { registerHumanRequestRoutes } from "./agents/human-request-routes.js";
import { registerLiveEventRoutes } from "./agents/live-event-routes.js";
import { RunManager } from "./agents/run-manager.js";
import { registerRunRoutes } from "./agents/run-routes.js";
import { QueueManager } from "./queue/queue-manager.js";
import { WorktreeManager } from "./git/worktree-manager.js";
import { registerQueueRoutes } from "./queue/queue-routes.js";
import { TaskOperationCoordinator } from "./task-operation-coordinator.js";

const databasePath = process.env.KANBAN_DB_PATH ?? "data/kanban.sqlite";
const db = openDatabase(databasePath);
const releaseLock = await lockfile.lock(resolve(dirname(databasePath)), {
  realpath: false,
  retries: 0,
}).catch(() => {
  db.close();
  throw new Error("Another backend instance already owns this application state.");
});
const app = Fastify();
installLocalRequestGuards(app, Number(process.env.PORT ?? 3000));
registerProjectRoutes(app, db);
const worktreeManager = new WorktreeManager(db);
const taskOperations = new TaskOperationCoordinator();
registerTaskRoutes(app, db, worktreeManager, taskOperations);
registerTaskRunRoutes(app, db);
let queueManager: QueueManager;
const humanRequests = new HumanRequestService(db, {
  onWaiting: (request) => queueManager.parkForHuman(request.run_id, request.id),
  onAnswered: (request) => queueManager.resumeHumanRun(request.run_id, request.id),
});
const agentManager = new AgentManager(db, undefined, undefined, undefined, humanRequests);
await registerLiveEventRoutes(app, db, agentManager);
const runManager = new RunManager(db, agentManager, humanRequests);
registerRunRoutes(app, runManager);
queueManager = new QueueManager(db, runManager, undefined, worktreeManager);
await runManager.reconcileHumanRequests();
queueManager.initialize();
registerQueueRoutes(app, queueManager, taskOperations);
registerHumanRequestRoutes(app, db, humanRequests, (runId) => queueManager.stopRun(runId));

app.get("/health", async () => {
  db.prepare("SELECT 1").get();
  return { status: "ok" };
});

const port = Number(process.env.PORT ?? 3000);
try {
  await app.listen({ host: "127.0.0.1", port });
} catch (error) {
  db.close();
  await releaseLock();
  throw error;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    db.close();
    await releaseLock();
    process.exit(0);
  });
}
