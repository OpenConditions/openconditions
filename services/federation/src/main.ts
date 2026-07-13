/**
 * Boot entry for the federation service: applies migrations, opens the
 * shared postgres pool, builds the Fastify app, and listens. Tests import
 * build() from server.ts instead of running this file.
 */
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { loadActiveKeys, runWebhookDeliveryCycle } from "@openconditions/federation";
import { guardedFetch } from "@openconditions/ingest-framework";
import { build } from "./server.js";
import { resolveFederationSettings } from "./config.js";

const PORT = parseInt(process.env["PORT"] || "4300", 10);
const HOST = process.env["HOST"] || "0.0.0.0";

/** How often the webhook push cron drains active webhook subscriptions. */
const WEBHOOK_CYCLE_MS = 5_000;

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

  // Webhook push cron: a latency optimization over pull. Egress is SSRF-guarded
  // (guardedFetch), and a run only advances a subscription's cursor on a 2xx —
  // so a dropped push leaves the peer's pull catch-up gap-free.
  const settings = resolveFederationSettings(process.env);
  let webhookTimer: NodeJS.Timeout | undefined;
  if (settings.enabled) {
    const partOf = `${settings.actor!.baseUrl}/peer/outbox`;
    const egress = guardedFetch();
    // Single-flight: skip a tick while the previous cycle is still running, so a
    // slow cycle can never overlap itself and regress a subscription's cursor or
    // failure counter.
    let cycleRunning = false;
    const runCycle = async () => {
      if (cycleRunning) return;
      cycleRunning = true;
      try {
        const [signingKey] = await loadActiveKeys(sql, new Date().toISOString());
        if (!signingKey) return;
        await runWebhookDeliveryCycle(sql, { signingKey, fetchImpl: egress, partOf });
      } catch (err) {
        console.error("[federation-api] webhook cycle failed:", err);
      } finally {
        cycleRunning = false;
      }
    };
    webhookTimer = setInterval(() => void runCycle(), WEBHOOK_CYCLE_MS);
  }

  const close = async () => {
    if (webhookTimer) clearInterval(webhookTimer);
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
