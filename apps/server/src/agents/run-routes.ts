import type { FastifyInstance } from "fastify";
import { RunMessageSchema } from "@kanban-board/shared";
import { RunManager } from "./run-manager.js";

export function registerRunRoutes(app: FastifyInstance, runs: RunManager) {
  app.post<{ Params: { runId: string } }>("/api/runs/:runId/inputs", async (request, reply) => {
    const parsed = RunMessageSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const result = await runs.steer(
        request.params.runId,
        parsed.data.input_id,
        parsed.data.text,
        parsed.data.reused_from_input_id,
      );
      return reply.code(result.created ? 201 : 200).send(result.input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.endsWith("not found.") ? 404 : 409).send({ error: message });
    }
  });
}
