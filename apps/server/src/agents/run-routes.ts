import type { FastifyInstance } from "fastify";
import { RunManager } from "./run-manager.js";

export function registerRunRoutes(app: FastifyInstance, runs: RunManager) {
  app.post<{ Params: { runId: string }; Body: { prompt?: unknown } }>("/api/runs/:runId/start", async (request, reply) => {
    if (typeof request.body?.prompt !== "string" || !request.body.prompt.trim()) {
      return reply.code(400).send({ error: "A non-empty prompt is required." });
    }
    try {
      await runs.start(request.params.runId, request.body.prompt);
      return reply.code(202).send({ status: "accepted" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = message.endsWith("not found.") ? 404 : 409;
      return reply.code(statusCode).send({ error: message });
    }
  });
}
