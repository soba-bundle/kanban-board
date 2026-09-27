import type { FastifyInstance } from "fastify";
import { SteerRunSchema } from "@kanban-board/shared";
import { RunManager } from "./run-manager.js";

export function registerRunRoutes(app: FastifyInstance, runs: RunManager) {
  app.post<{ Params: { runId: string } }>("/api/runs/:runId/steer", async (request, reply) => {
    const parsed = SteerRunSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      return reply.code(201).send(await runs.steer(request.params.runId, parsed.data.text));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.endsWith("not found.") ? 404 : 409).send({ error: message });
    }
  });
}
