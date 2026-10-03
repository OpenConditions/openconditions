/**
 * Boot entry for the federation service: applies migrations, opens the
 * shared postgres pool, builds the Fastify app, and listens. Tests import
 * build() from server.ts instead of running this file.
 */

import { assertStoredCodesRegistered, runMigrations } from "@openconditions/core/server";
import {
  loadActiveKeys,
  OUTBOX_PRUNE_INTERVAL_HOURS,
  pruneOutbox,
  refreshPeerCapabilities,
  runWebhookDeliveryCycle,
} from "@openconditions/federation";
import { guardedFetch } from "@openconditions/ingest-framework";
import { schemaVersions } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import postgres from "postgres";
import { resolveFederationSettings } from "./config.js";
import { build } from "./server.js";

const PORT = parseInt(process.env["PORT"] || "4300", 10);
const HOST = process.env["HOST"] || "0.0.0.0";

/** How often the webhook push cron drains active webhook subscriptions. */
const WEBHOOK_CYCLE_MS = 5_000;

/** How often the retention cron trims the append-only outbox journal. */
const PRUNE_CYCLE_MS = OUTBOX_PRUNE_INTERVAL_HOURS * 60 * 60 * 1000;

/** How often each pinned peer's capabilities are re-verified. */
const CAPABILITIES_CYCLE_MS = 60 * 60 * 1000;

async function boot() {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  console.info("[federation-api] applying database migrations…");
  await runMigrations(url);
  console.info("[federation-api] migrations applied");

  const sql = postgres(url, { max: 5, idle_timeout: 30, connect_timeout: 10 });
  await assertStoredCodesRegistered(sql, productionRegistry(), { sourceFormats: false });
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

  // Retention cron: trims the append-only outbox journal on the tier-bounded time
  // floor (never a subscriber cursor). Single-flight, and it runs regardless of
  // push settings — the journal grows on every observation mutation. The default
  // retention keeps the widest serve window plus a safety margin; an operator
  // running the static archive can later thread its high-water mark here.
  let pruneRunning = false;
  const runPrune = async () => {
    if (pruneRunning) return;
    pruneRunning = true;
    try {
      const { deleted, floorIso } = await pruneOutbox(sql, { now: new Date().toISOString() });
      if (deleted > 0) {
        console.info(
          `[federation-api] outbox prune: deleted ${deleted} rows older than ${floorIso}`,
        );
      }
    } catch (err) {
      console.error("[federation-api] outbox prune failed:", err);
    } finally {
      pruneRunning = false;
    }
  };
  const pruneTimer = setInterval(() => void runPrune(), PRUNE_CYCLE_MS);

  // Peer capabilities: what each pinned peer's actor document advertises,
  // verified against its pin and negotiated, at boot and hourly after. Its
  // records are admitted against them; a peer not yet verified is asked to
  // retry its inbox delivery.
  let capabilitiesTimer: NodeJS.Timeout | undefined;
  if (settings.enabled) {
    const actor = settings.actor!;
    const local = {
      ...actor.capabilities,
      schemaVersions: schemaVersions(productionRegistry()),
    };
    const egress = guardedFetch();
    const refreshAll = async () => {
      for (const peer of settings.peers) {
        const result = await refreshPeerCapabilities(sql, peer, {
          local,
          fetchImpl: egress,
          now: new Date().toISOString(),
        }).catch((err: unknown) => ({ ok: false as const, reason: String(err) }));
        if (!result.ok) {
          console.warn(
            `[federation-api] capabilities of ${peer.instanceId} not refreshed: ${result.reason}`,
          );
        }
      }
    };
    void refreshAll();
    capabilitiesTimer = setInterval(() => void refreshAll(), CAPABILITIES_CYCLE_MS);
  }

  const close = async () => {
    if (webhookTimer) clearInterval(webhookTimer);
    if (capabilitiesTimer) clearInterval(capabilitiesTimer);
    clearInterval(pruneTimer);
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
