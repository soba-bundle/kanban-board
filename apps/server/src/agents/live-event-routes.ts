import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { LiveEvent } from "@kanban-board/shared";
import { AgentManager } from "./agent-manager.js";

export async function registerLiveEventRoutes(app: FastifyInstance, db: Database.Database, agents: AgentManager) {
  await app.register(websocket);

  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId/live/history", (request, reply) => {
    try {
      return agents.historySnapshot(request.params.taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.endsWith("not found.") ? 404 : 500).send({ error: message });
    }
  });

  app.get<{ Params: { taskId: string; runId: string }; Querystring: { after?: string } }>(
    "/api/tasks/:taskId/runs/:runId/events", { websocket: true }, (socket, request) => {
      const run = db.prepare("SELECT task_id FROM task_runs WHERE id = ? AND task_id = ?")
        .get(request.params.runId, request.params.taskId) as { task_id: string } | undefined;
      if (!run) {
        socket.close(1008, "Run not found");
        return;
      }
      const after = request.query.after === undefined ? 0 : Number(request.query.after);
      if (!Number.isSafeInteger(after) || after < 0) {
        socket.close(1008, "Invalid event cursor");
        return;
      }

      let lastSent = after;
      let catchingUp = true;
      const pending: LiveEvent[] = [];
      const send = (event: LiveEvent) => {
        if (event.type !== "replay_gap" && event.sequence <= lastSent) return;
        if (socket.readyState !== socket.OPEN) return;
        socket.send(JSON.stringify(event));
        if (event.type !== "replay_gap") lastSent = event.sequence;
      };
      const unsubscribe = agents.subscribe(run.task_id, request.params.runId, (event) => {
        if (catchingUp) pending.push(event);
        else send(event);
      });

      setImmediate(() => {
        const snapshot = agents.streamSnapshot(request.params.runId);
        const oldest = snapshot.oldestSequence;
        if (after > snapshot.cursor || (oldest !== null && after < oldest - 1)) {
          const gap: LiveEvent = {
            eventId: `${request.params.runId}:gap:${after}:${snapshot.cursor}`,
            sequence: Math.max(snapshot.cursor, 1),
            taskId: run.task_id,
            runId: request.params.runId,
            type: "replay_gap",
            timestamp: new Date().toISOString(),
            data: { after, cursor: snapshot.cursor, oldest_available: oldest },
          };
          send(gap);
        }
        for (const event of snapshot.events) if (event.sequence > after) send(event);
        catchingUp = false;
        for (const event of pending) send(event);
      });
      socket.on("close", unsubscribe);
    },
  );
}
