import type { FastifyInstance } from "fastify";
import { TaskOperationCoordinator } from "../task-operation-coordinator.js";

interface ValidationStarter {
  start(taskId: string): Promise<{ run_id: string; status: string }>;
}

function statusFor(error: unknown): number {
  if (typeof error === "object" && error !== null && "statusCode" in error &&
    typeof error.statusCode === "number") return error.statusCode;
  const message = error instanceof Error ? error.message : String(error);
  if (message.endsWith("not found.")) return 404;
  return 409;
}

export function registerValidationRoutes(
  app: FastifyInstance,
  validation: ValidationStarter,
  operations = new TaskOperationCoordinator(),
) {
  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/validation", async (request, reply) => {
    const release = operations.tryAcquire(request.params.taskId);
    if (!release) return reply.code(409).send({ error: "Another operation is in progress for this task." });
    try {
      const result = await validation.start(request.params.taskId);
      return reply.code(202).send(result);
    } catch (error) {
      return reply.code(statusFor(error)).send({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      release();
    }
  });
}
