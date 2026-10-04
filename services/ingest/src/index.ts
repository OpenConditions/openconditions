import {
  assertStoredCodesRegistered,
  resolveInstanceId,
  runMigrations,
} from "@openconditions/core/server";
import { productionRegistry } from "@openconditions/model-registry";
import { reconcileFederation, refreshOutdatedFusions, syncSources } from "@openconditions/storage";
import Fastify from "fastify";
import { fetch as undiciFetch } from "undici";
import { registerApiRoutes } from "./api/routes.js";
import { operatorTokenFromEnv, registerScope } from "./api/scope.js";
import { DATABASE_URL, sql } from "./db.js";
import { loadIngestCatalog } from "./domains.js";
import { startFederationReconcile } from "./federation-reconcile.js";
import { FeedStatusStore } from "./feed-status.js";
import { startFusedRefresh } from "./fused-refresh.js";
import { startMemTelemetry } from "./mem.js";
import { onDemandDeadlineMsFromEnv } from "./on-demand/read-through.js";
import { closeAbandonedPollAttempts } from "./pipeline/source-status.js";
import { registerPublishRoutes } from "./publish-routes.js";
import { RateLimiter, registerRateLimit } from "./rate-limit.js";
import { maintainPartitions, startRecordJobs } from "./record-jobs.js";
import { startScheduler } from "./scheduler.js";
import { InFlight, onceShutdown } from "./shutdown.js";
import { catalogueSources } from "./sources.js";
import { createTrustProxy } from "./trust-proxy.js";

const PORT = parseInt(process.env["PORT"] || "4100", 10);
const HOST = process.env["HOST"] || "0.0.0.0";

// Public emitter feeds are rate-limited per client. Defaults suit a public
// commons feed; operators tune them via the service env.
const RATE_LIMIT_MAX = parseInt(process.env["RATE_LIMIT_MAX"] || "120", 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env["RATE_LIMIT_WINDOW_MS"] || "60000", 10);
const TRUST_PROXY_CIDRS = process.env["TRUST_PROXY_CIDRS"];

async function boot() {
  // A malformed operator token fails boot before anything else runs.
  const operatorToken = operatorTokenFromEnv();
  console.info(`[ingest] instance id ${resolveInstanceId()}`);
  console.info("[ingest] applying database migrations…");
  await runMigrations(DATABASE_URL);
  console.info("[ingest] migrations applied");
  const model = productionRegistry();
  const catalog = await loadIngestCatalog();
  // The catalogue is synced first: a source this release dropped, with its
  // format, is marked inactive before the check reads the loaded formats.
  await syncSources(sql, catalogueSources(catalog));
  await assertStoredCodesRegistered(sql, model);

  const app = Fastify({ logger: true, trustProxy: createTrustProxy(TRUST_PROXY_CIDRS) });

  // The scope hook runs first: the limiter lets the operator through.
  registerScope(app, operatorToken);
  const limiter = new RateLimiter({ max: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS });
  registerRateLimit(app, limiter);

  app.get("/status", async (_req, reply) => {
    return reply.send({ status: "ok", service: "openconditions-ingest" });
  });

  const statusStore = new FeedStatusStore();
  await maintainPartitions(sql, model, new Date());
  const abandoned = await closeAbandonedPollAttempts(sql);
  if (abandoned > 0) console.warn(`[ingest] closed ${abandoned} poll attempt(s) left running`);
  registerPublishRoutes(app, sql, statusStore, catalog);
  // The on-demand cell fetches and feed polls shutdown waits for.
  const inFlight = new InFlight();
  registerApiRoutes(app, sql, {
    registry: model,
    catalog,
    // undici's fetch, not the global: the egress guard pins its sockets.
    onDemand: {
      catalog,
      fetch: undiciFetch as unknown as typeof fetch,
      deadlineMs: onDemandDeadlineMsFromEnv(),
      instanceId: resolveInstanceId(),
      inFlight,
    },
  });

  const stopScheduler = startScheduler(sql, statusStore, catalog, inFlight);
  const stopRecordJobs = startRecordJobs(sql, {
    registry: model,
    instanceId: resolveInstanceId(),
  });
  const stopMemTelemetry = startMemTelemetry();
  // The fusions a catalogue change (or an unfinished refresh) left outdated,
  // in the background; until a feature's batch commits, the read-time check
  // on `fused_sources` withholds a public fused reading a now-restricted source
  // contributed to.
  const fusedRefresh = startFusedRefresh((opts) =>
    refreshOutdatedFusions(sql, {
      registry: model,
      instanceId: resolveInstanceId(),
      now: () => new Date().toISOString(),
      ...opts,
    }),
  );
  // The outbox entries a catalogue flip of `restricted` (or an unfinished
  // reconcile) left owed, in the background: deletes for a source turned
  // restricted, creates for one turned public. Until then the outbox
  // withholds a now-restricted source's earlier changes.
  const federationReconcile = startFederationReconcile((opts) => reconcileFederation(sql, opts));
  const close = onceShutdown({
    stop: [stopScheduler, stopRecordJobs, stopMemTelemetry, () => limiter.destroy()],
    background: [fusedRefresh, federationReconcile, inFlight],
    app,
    sql,
  });
  process.on("SIGTERM", close);
  process.on("SIGINT", close);

  await app.listen({ port: PORT, host: HOST });
  console.info(`[ingest] listening on ${HOST}:${PORT}`);
}

boot().catch((err) => {
  console.error("[ingest] fatal:", err);
  process.exit(1);
});
