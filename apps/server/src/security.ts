import type { FastifyInstance } from "fastify";

function isLocalHost(hostHeader: string, port: number): boolean {
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/i.exec(hostHeader);
  if (!match) return false;
  const hostPort = match[2] ? Number(match[2]) : 80;
  return hostPort === port || hostPort === 5173;
}

function isLocalOrigin(origin: string, port: number): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && isLocalHost(url.host, port);
  } catch {
    return false;
  }
}

export function installLocalRequestGuards(app: FastifyInstance, port: number) {
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host;
    if (!host || !isLocalHost(host, port)) {
      return reply.code(403).send({ error: "Host not allowed" });
    }

    const origin = request.headers.origin;
    if (origin && !isLocalOrigin(origin, port)) {
      return reply.code(403).send({ error: "Origin not allowed" });
    }
  });
}
