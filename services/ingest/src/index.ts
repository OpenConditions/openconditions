import Fastify from "fastify";
import { runMigrations } from "@openconditions/core/server";
import { DATABASE_URL, sql } from "./db.js";
import { buildDomainRegistry } from "./domains.js";
import { FeedStatusStore } from "./feed-status.js";
import { registerPublishRoutes } from "./publish-routes.js";
import { RateLimiter } from "./rate-limit.js";
import { startScheduler } from "./scheduler.js";

const PORT = parseInt(process.env["PORT"] || "4100", 10);
const HOST = process.env["HOST"] || "0.0.0.0";

// Public emitter feeds are rate-limited per client. Defaults suit a public
// commons feed; operators tune them via the service env.
const RATE_LIMIT_MAX = parseInt(process.env["RATE_LIMIT_MAX"] || "120", 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env["RATE_LIMIT_WINDOW_MS"] || "60000", 10);
// Hops of trusted reverse proxy in front of us (Traefik = 1), so `req.ip` is the
// real client. 0 = directly exposed. Never the boolean `true` on a public host.
const TRUST_PROXY_HOPS = parseInt(process.env["TRUST_PROXY_HOPS"] || "1", 10);

// Internal callers (the container healthcheck, a co-located CLI) reach us over
// the loopback peer and skip the limiter entirely.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

async function boot() {
  console.info("[ingest] applying database migrations…");
  await runMigrations(DATABASE_URL);
  console.info("[ingest] migrations applied");

  const app = Fastify({ logger: true, trustProxy: TRUST_PROXY_HOPS });

  const limiter = new RateLimiter({ max: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS });
  const rateLimit = limiter.hook();
  app.addHook("onRequest", async (req, reply) => {
    // `/status` is the health probe; loopback is internal traffic — both exempt.
    if (req.url === "/status" || req.url.startsWith("/status?")) return;
    const peer = req.socket?.remoteAddress;
    if (peer && LOOPBACK.has(peer)) return;
    return rateLimit(req, reply);
  });

  app.get("/status", async (_req, reply) => {
    return reply.send({ status: "ok", service: "openconditions-ingest" });
  });

  const statusStore = new FeedStatusStore();
  const registry = await buildDomainRegistry();
  registerPublishRoutes(app, sql, statusStore, registry);

  const stopScheduler = startScheduler(sql, statusStore, registry);
  const close = async () => {
    stopScheduler();
    limiter.destroy();
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
