import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { AgentManager } from "./agent-manager.js";

export async function registerLiveEventRoutes(app: FastifyInstance, db: Database.Database, agents: AgentManager) {
  await app.register(websocket);
  app.get<{ Params: { runId: string } }>("/api/runs/:runId/events", { websocket: true }, (socket, request) => {
    const run = db.prepare("SELECT task_id FROM task_runs WHERE id = ?").get(request.params.runId) as { task_id: string } | undefined;
    if (!run) {
      socket.close(1008, "Run not found");
      return;
    }
    const unsubscribe = agents.subscribe(run.task_id, request.params.runId, (event) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    });
    socket.on("close", unsubscribe);
  });
}
