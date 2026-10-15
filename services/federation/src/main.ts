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
  runWebhookDeliveryCycle,
} from "@openconditions/federation";
import { guardedFetch, requireCredential } from "@openconditions/ingest-framework";
import { productionRegistry } from "@openconditions/model-registry";
import postgres from "postgres";
import { backfillFloorIso } from "./backfill.js";
import { resolveFederationSettings } from "./config.js";
import { refreshPeers } from "./peering.js";
import { build } from "./server.js";

const PORT = parseInt(process.env["PORT"] || "4300", 10);
const HOST = process.env["HOST"] || "0.0.0.0";

/** How often the webhook push cron drains active webhook subscriptions. */
const WEBHOOK_CYCLE_MS = 5_000;

/** How often the retention cron trims the append-only outbox journal. */
const PRUNE_CYCLE_MS = OUTBOX_PRUNE_INTERVAL_HOURS * 60 * 60 * 1000;

/** How often each pinned peer's capabilities are re-verified and its subscription mended. */
const CAPABILITIES_CYCLE_MS = 60 * 60 * 1000;

async function boot() {
  const url = requireCredential(process.env, "DATABASE_URL");
  console.info("[federation-api] applying database migrations…");
  await runMigrations(url);
  console.info("[federation-api] migrations applied");

  // Requests and batched crons only: a statement past 30 s or a lock wait past
  // 10 s fails rather than holding one of the five connections. Startup
  // parameters, as the database and role may be shared with another application.
  const sql = postgres(url, {
    max: 5,
    idle_timeout: 30,
    connect_timeout: 10,
    connection: {
      application_name: "openconditions-federation-api",
      statement_timeout: 30_000,
      lock_timeout: 10_000,
      idle_in_transaction_session_timeout: 60_000,
    },
  });
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
    // A subscriber is pushed its pinned tier's window, as it is served
    // everywhere else, and nothing once it is no longer pinned.
    const tiers = new Map(settings.peers.map((peer) => [peer.instanceId, peer.trustTier]));
    const floorFor = (peerId: string) => {
      const tier = tiers.get(peerId);
      return tier === undefined ? null : backfillFloorIso(tier, new Date().toISOString());
    };
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
        await runWebhookDeliveryCycle(sql, { signingKey, fetchImpl: egress, partOf, floorFor });
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

  // Peer upkeep: what each pinned peer's actor document advertises, verified
  // against its pin and negotiated, at boot and hourly after. Its records are
  // admitted against them; a peer not yet verified is asked to retry its
  // inbox delivery. A peer this instance subscribes to is kept pushing to its
  // inbox: a subscription missing, changed or disabled there is mended.
  let capabilitiesTimer: NodeJS.Timeout | undefined;
  if (settings.enabled) {
    const egress = guardedFetch();
    let upkeepRunning = false;
    const refreshAll = async () => {
      if (upkeepRunning) return;
      upkeepRunning = true;
      try {
        const results = await refreshPeers(sql, settings, {
          fetchImpl: egress,
          now: new Date().toISOString(),
        });
        for (const { peer, capabilities, subscription } of results) {
          if (!capabilities.ok) {
            console.warn(
              `[federation-api] capabilities of ${peer} not refreshed: ${capabilities.reason}`,
            );
          }
          if (subscription !== undefined && !subscription.ok) {
            console.warn(
              `[federation-api] subscription at ${peer} not kept: ${subscription.reason}`,
            );
          } else if (subscription?.ok && subscription.status !== "unchanged") {
            console.info(`[federation-api] subscription at ${peer} ${subscription.status}`);
          }
        }
      } catch (err) {
        console.error("[federation-api] peer upkeep failed:", err);
      } finally {
        upkeepRunning = false;
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
