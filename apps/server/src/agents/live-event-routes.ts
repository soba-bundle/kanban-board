import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { LiveEvent } from "@kanban-board/shared";
import { AgentManager } from "./agent-manager.js";

export async function registerLiveEventRoutes(app: FastifyInstance, db: Database.Database, agents: AgentManager) {
  await app.register(websocket);
  app.get<{ Params: { runId: string } }>("/api/runs/:runId/events", { websocket: true }, (socket, request) => {
    const run = db.prepare("SELECT task_id FROM task_runs WHERE id = ?").get(request.params.runId) as { task_id: string } | undefined;
    if (!run) {
      socket.close(1008, "Run not found");
      return;
    }

    const send = (event: LiveEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };

    // Replay is flushed on the next tick so a client that attaches its message
    // handler after the upgrade still receives the backlog. Events emitted during
    // that gap are already in the replay buffer, so nothing is lost or duplicated.
    let streaming = false;
    const unsubscribe = agents.subscribe(run.task_id, request.params.runId, (event) => {
      if (streaming) send(event);
    });
    setImmediate(() => {
      for (const event of agents.replay(request.params.runId)) send(event);
      streaming = true;
    });

    socket.on("close", unsubscribe);
  });
}
