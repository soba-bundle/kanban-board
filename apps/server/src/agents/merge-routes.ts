import type { FastifyInstance } from "fastify";
import type { MergeManager } from "./merge-manager.js";

function errorResponse(reply: { code(status: number): { send(body: unknown): unknown } }, error: unknown) {
  const value = error as { statusCode?: number; message?: string };
  return reply.code(value.statusCode ?? 409).send({ error: value.message ?? String(error) });
}

export function registerMergeRoutes(app: FastifyInstance, merge: Pick<MergeManager,
  "checkSync" | "preview" | "start" | "abort" | "retry" | "viewConflicts">) {
  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId/check-sync", async (request, reply) => {
    try { return await merge.checkSync(request.params.taskId); }
    catch (error) { return errorResponse(reply, error); }
  });
  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId/merge-preview", async (request, reply) => {
    try { return await merge.preview(request.params.taskId); }
    catch (error) { return errorResponse(reply, error); }
  });
  app.post<{ Params: { taskId: string }; Body: { confirmed?: boolean; preview_id?: string } }>("/api/tasks/:taskId/merge", async (request, reply) => {
    if (request.body?.confirmed !== true) return reply.code(400).send({ error: "Explicit merge approval is required." });
    if (!request.body.preview_id) return reply.code(400).send({ error: "Refresh the merge preview and confirm the current Check sync state." });
    try {
      const input = request.body.preview_id === undefined
        ? { confirmed: true }
        : { confirmed: true, preview_id: request.body.preview_id };
      return reply.code(202).send(await merge.start(request.params.taskId, input));
    }
    catch (error) { return errorResponse(reply, error); }
  });
  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/merge/abort", async (request, reply) => {
    try { return await merge.abort(request.params.taskId); } catch (error) { return errorResponse(reply, error); }
  });
  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/merge/retry", async (request, reply) => {
    try { return await merge.retry(request.params.taskId); } catch (error) { return errorResponse(reply, error); }
  });
  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/merge/view-conflicts", async (request, reply) => {
    try { return await merge.viewConflicts(request.params.taskId); } catch (error) { return errorResponse(reply, error); }
  });
}
