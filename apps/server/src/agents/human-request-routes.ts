import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply } from "fastify";
import { HumanRequestAnswerBatchSchema } from "@kanban-board/shared";
import { HumanRequestService } from "./human-requests.js";

type StopRun = (runId: string) => Promise<void>;

function sendServiceError(reply: FastifyReply, error: unknown, fallbackStatus = 500) {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.endsWith("not found.") ? 404
    : /already answered|cancelled|no longer pending|not active|not running/i.test(message) ? 409
      : /answer every question|answers cannot be empty|must be an allowed option/i.test(message) ? 400
        : fallbackStatus;
  return reply.code(status).send({ error: message });
}

export function registerHumanRequestRoutes(
  app: FastifyInstance,
  db: Database.Database,
  requests: HumanRequestService,
  stopRun: StopRun,
) {
  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId/human-requests", async (request, reply) => {
    const task = db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(request.params.taskId);
    if (!task) return reply.code(404).send({ error: `Task ${request.params.taskId} not found.` });
    return requests.listForTask(request.params.taskId);
  });

  app.post<{ Params: { requestId: string } }>("/api/human-requests/:requestId/answer", async (request, reply) => {
    const parsed = HumanRequestAnswerBatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      return await requests.answer(request.params.requestId, parsed.data.answers);
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.post<{ Params: { requestId: string } }>("/api/human-requests/:requestId/stop", async (request, reply) => {
    const row = db.prepare("SELECT run_id FROM human_requests WHERE id = ?")
      .get(request.params.requestId) as { run_id: string } | undefined;
    if (!row) return reply.code(404).send({ error: `Human Request ${request.params.requestId} not found.` });
    try {
      await stopRun(row.run_id);
      return { status: "stopped" };
    } catch (error) {
      return sendServiceError(reply, error, 409);
    }
  });
}
