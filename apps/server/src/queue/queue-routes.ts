import type { FastifyInstance } from "fastify";
import { ReorderQueueJobSchema, StartRunSchema } from "@kanban-board/shared";
import { TaskOperationCoordinator } from "../task-operation-coordinator.js";
import { QueueManager } from "./queue-manager.js";

function statusFor(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message.endsWith("not found.")) return 404;
  if (message.includes("must be") || message.includes("out of range")) return 400;
  return 409;
}

export function registerQueueRoutes(
  app: FastifyInstance,
  queue: QueueManager,
  operations = new TaskOperationCoordinator(),
) {
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
    const parsed = StartRunSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (parsed.data.task_id !== request.params.taskId) {
      return reply.code(400).send({ error: "Task ID in the request must match the URL." });
    }
    const release = operations.tryAcquire(request.params.taskId);
    if (!release) return reply.code(409).send({ error: "Another operation is in progress for this task." });
    try {
      const result = queue.enqueueTask(
        request.params.taskId,
        parsed.data.prompt,
        parsed.data.idempotency_key,
        parsed.data.reused_from_input_id,
      );
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(statusFor(error)).send({ error: message });
    } finally {
      release();
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
