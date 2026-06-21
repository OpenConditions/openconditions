import Fastify from "fastify";
import { MIGRATION_SQL } from "@openconditions/core";
import { sql } from "./db.js";
import { startScheduler } from "./scheduler.js";

const PORT = parseInt(process.env["PORT"] || "4100", 10);
const HOST = process.env["HOST"] || "0.0.0.0";

async function boot() {
  console.info("[ingest] applying database migrations…");
  for (const statement of MIGRATION_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    await sql.unsafe(statement);
  }
  console.info("[ingest] migrations applied");

  const app = Fastify({ logger: true });

  app.get("/status", async (_req, reply) => {
    return reply.send({ status: "ok", service: "openconditions-ingest" });
  });

  const stopScheduler = startScheduler(sql);

  const close = async () => {
    stopScheduler();
    await app.close();
    await sql.end();
  };

  process.on("SIGTERM", close);
  process.on("SIGINT", close);

  await app.listen({ port: PORT, host: HOST });
  console.info(`[ingest] listening on ${HOST}:${PORT}`);
}

boot().catch((err) => {
  console.error("[ingest] fatal:", err);
  process.exit(1);
});
