import type { FastifyInstance, FastifyReply } from "fastify";
import type { GitSyncManager } from "./git-sync-manager.js";

function sendFailure(reply: FastifyReply, error: unknown) {
  const statusCode = typeof error === "object" && error !== null && "statusCode" in error
    ? Number((error as { statusCode: unknown }).statusCode) : 409;
  return reply.code(statusCode >= 400 && statusCode < 600 ? statusCode : 409)
    .send({ error: error instanceof Error ? error.message : String(error) });
}

export function registerGitSyncRoutes(app: FastifyInstance, sync: Pick<GitSyncManager,
  "syncWithBase" | "getSyncRecovery" | "viewSyncConflicts" | "retrySync" | "abortSync">): void {
  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/sync", async (request, reply) => {
    try { return await sync.syncWithBase(request.params.taskId); }
    catch (error) { return sendFailure(reply, error); }
  });
  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId/sync-recovery", async (request, reply) => {
    try { return { recovery: await sync.getSyncRecovery(request.params.taskId) }; }
    catch (error) { return sendFailure(reply, error); }
  });
  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/sync/view-conflicts", async (request, reply) => {
    try { return await sync.viewSyncConflicts(request.params.taskId); }
    catch (error) { return sendFailure(reply, error); }
  });
  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/sync/retry", async (request, reply) => {
    try { return await sync.retrySync(request.params.taskId); }
    catch (error) { return sendFailure(reply, error); }
  });
  app.post<{ Params: { taskId: string }; Body: { confirmed?: boolean } }>("/api/tasks/:taskId/sync/abort", async (request, reply) => {
    try { return await sync.abortSync(request.params.taskId, request.body?.confirmed === true); }
    catch (error) { return sendFailure(reply, error); }
  });
}
