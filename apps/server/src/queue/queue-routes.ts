import type { FastifyInstance } from "fastify";
import { EnqueueTaskSchema, ReorderQueueJobSchema } from "@kanban-board/shared";
import { QueueManager } from "./queue-manager.js";

function statusFor(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message.endsWith("not found.")) return 404;
  if (message.includes("must be") || message.includes("out of range")) return 400;
  return 409;
}

export function registerQueueRoutes(app: FastifyInstance, queue: QueueManager) {
  app.get("/api/queue", async () => queue.getSnapshot());

  app.post<{ Params: { runId: string } }>("/api/runs/:runId/stop", async (request, reply) => {
    try {
      await queue.stopRun(request.params.runId);
      return { status: "stopped" };
    } catch (error) {
      return reply.code(statusFor(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/queue", async (request, reply) => {
    const parsed = EnqueueTaskSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      return reply.code(201).send(queue.enqueueTask(request.params.taskId, parsed.data.stage));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(statusFor(error)).send({ error: message });
    }
  });

  app.patch<{ Params: { jobId: string } }>("/api/queue/:jobId", async (request, reply) => {
    const parsed = ReorderQueueJobSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      queue.reorder(request.params.jobId, parsed.data.position);
      return queue.getSnapshot();
    } catch (error) {
      return reply.code(statusFor(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete<{ Params: { jobId: string } }>("/api/queue/:jobId", async (request, reply) => {
    try {
      queue.remove(request.params.jobId);
      return reply.code(204).send();
    } catch (error) {
      return reply.code(statusFor(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
