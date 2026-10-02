import { assertStoredCodesRegistered, runMigrations } from "@openconditions/core/server";
import { productionRegistry } from "@openconditions/model-registry";
import { resolveInstanceId } from "@openconditions/normalize";
import { syncSources } from "@openconditions/storage";
import Fastify from "fastify";
import { registerApiRoutes } from "./api/routes.js";
import { DATABASE_URL, sql } from "./db.js";
import { buildDomainRegistry } from "./domains.js";
import { FeedStatusStore } from "./feed-status.js";
import { startMemTelemetry } from "./mem.js";
import { closeAbandonedPollAttempts } from "./pipeline/source-status.js";
import { registerPublishRoutes } from "./publish-routes.js";
import { RateLimiter } from "./rate-limit.js";
import { maintainPartitions, startRecordJobs } from "./record-jobs.js";
import { startScheduler } from "./scheduler.js";
import { catalogueSources } from "./sources.js";
import { createTrustProxy } from "./trust-proxy.js";

const PORT = parseInt(process.env["PORT"] || "4100", 10);
const HOST = process.env["HOST"] || "0.0.0.0";

// Public emitter feeds are rate-limited per client. Defaults suit a public
// commons feed; operators tune them via the service env.
const RATE_LIMIT_MAX = parseInt(process.env["RATE_LIMIT_MAX"] || "120", 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env["RATE_LIMIT_WINDOW_MS"] || "60000", 10);
const TRUST_PROXY_CIDRS = process.env["TRUST_PROXY_CIDRS"];

// Internal callers (the container healthcheck, a co-located CLI) reach us over
// the loopback peer and skip the limiter entirely.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

async function boot() {
  console.info(`[ingest] instance id ${resolveInstanceId()}`);
  console.info("[ingest] applying database migrations…");
  await runMigrations(DATABASE_URL);
  console.info("[ingest] migrations applied");
  const model = productionRegistry();
  await assertStoredCodesRegistered(sql, model);

  const app = Fastify({ logger: true, trustProxy: createTrustProxy(TRUST_PROXY_CIDRS) });

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
  await syncSources(sql, catalogueSources(registry));
  await maintainPartitions(sql, model, new Date());
  const abandoned = await closeAbandonedPollAttempts(sql);
  if (abandoned > 0) console.warn(`[ingest] closed ${abandoned} poll attempt(s) left running`);
  registerPublishRoutes(app, sql, statusStore, registry);
  registerApiRoutes(app, sql, { registry: model });

  const stopScheduler = startScheduler(sql, statusStore, registry);
  const stopRecordJobs = startRecordJobs(sql, {
    registry: model,
    instanceId: resolveInstanceId(),
  });
  const stopMemTelemetry = startMemTelemetry();
  const close = async () => {
    stopScheduler();
    stopRecordJobs();
    stopMemTelemetry();
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
