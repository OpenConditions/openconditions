/**
 * Boot entry for the federation service: applies migrations, opens the
 * shared postgres pool, builds the Fastify app, and listens. Tests import
 * build() from server.ts instead of running this file.
 */
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { build } from "./server.js";

const PORT = parseInt(process.env["PORT"] || "4300", 10);
const HOST = process.env["HOST"] || "0.0.0.0";

async function boot() {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  console.info("[federation-api] applying database migrations…");
  await runMigrations(url);
  console.info("[federation-api] migrations applied");

  const sql = postgres(url, { max: 5, idle_timeout: 30, connect_timeout: 10 });
  const app = await build({ sql });

  const close = async () => {
    await app.close();
    await sql.end();
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);

  await app.listen({ port: PORT, host: HOST });
  console.info(`[federation-api] listening on ${HOST}:${PORT}`);
}

boot().catch((err) => {
  console.error("[federation-api] fatal:", err);
  process.exit(1);
});
