import Fastify from "fastify";
import lockfile from "proper-lockfile";
import { dirname, resolve } from "node:path";
import { openDatabase } from "./db.js";
import { installLocalRequestGuards } from "./security.js";
import { registerProjectRoutes } from "./projects.js";

const databasePath = process.env.KANBAN_DB_PATH ?? "data/kanban.sqlite";
const db = openDatabase(databasePath);
const releaseLock = await lockfile.lock(resolve(dirname(databasePath)), {
  realpath: false,
  retries: 0,
}).catch(() => {
  db.close();
  throw new Error("Another backend instance already owns this application state.");
});
const app = Fastify();
installLocalRequestGuards(app, Number(process.env.PORT ?? 3000));
registerProjectRoutes(app, db);

app.get("/health", async () => {
  db.prepare("SELECT 1").get();
  return { status: "ok" };
});

const port = Number(process.env.PORT ?? 3000);
try {
  await app.listen({ host: "127.0.0.1", port });
} catch (error) {
  db.close();
  await releaseLock();
  throw error;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    db.close();
    await releaseLock();
    process.exit(0);
  });
}
