/**
 * Boot entry for the federation service: applies migrations, opens the
 * shared postgres pool, builds the Fastify app, and listens. Tests import
 * build() from server.ts instead of running this file.
 */

import { assertStoredCodesRegistered, runMigrations } from "@openconditions/core/server";
import {
  createInMemoryRateLimiter,
  InMemoryNonceStore,
  KEY_PUBLICATION_LEAD_DAYS,
  loadSigningKey,
  maintainInstanceKey,
  OUTBOX_PRUNE_INTERVAL_HOURS,
  pruneOutbox,
  runWebhookDeliveryCycle,
} from "@openconditions/federation";
import { guardedFetch, requireCredential } from "@openconditions/ingest-framework";
import { productionRegistry } from "@openconditions/model-registry";
import { seedFederation } from "@openconditions/storage";
import postgres from "postgres";
import { backfillFloorIso } from "./backfill.js";
import { resolveFederationSettings } from "./config.js";
import { PeerBook } from "./peer-book.js";
import { refreshPeers } from "./peering.js";
import { pullPeer } from "./puller.js";
import { build } from "./server.js";

const PORT = parseInt(process.env["PORT"] || "4300", 10);
const HOST = process.env["HOST"] || "0.0.0.0";

/** How often the webhook push cron drains active webhook subscriptions. */
const WEBHOOK_CYCLE_MS = 5_000;

/** How often the retention cron trims the append-only outbox journal. */
const PRUNE_CYCLE_MS = OUTBOX_PRUNE_INTERVAL_HOURS * 60 * 60 * 1000;

/** How long a journal seed waits before it retries the sources that were busy polling. */
const SEED_RETRY_MS = 5 * 60 * 1000;

/** How often each pinned peer's capabilities are re-verified and its subscriptions mended. */
const CAPABILITIES_CYCLE_MS = 60 * 60 * 1000;

/** How often the instance key is checked for rotation. */
const KEY_CYCLE_MS = 6 * 60 * 60 * 1000;

/** How often the peers this instance pulls are read. */
const PULL_CYCLE_MS = 30_000;

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
  const settings = resolveFederationSettings(process.env);

  // Journal seed: what a subscription wants of the records stored before it
  // (the capture journals only while one wants them), at boot and whenever a
  // peer subscribes or changes its filter. Single-flight; a request during a
  // run, or a source busy polling, has it run again.
  let seedRunning = false;
  let seedAgain = false;
  const seed = async (): Promise<void> => {
    if (seedRunning) {
      seedAgain = true;
      return;
    }
    seedRunning = true;
    try {
      do {
        seedAgain = false;
        const { journalled, busy } = await seedFederation(sql);
        if (journalled > 0) console.info(`[federation-api] journal seed: ${journalled} entries`);
        if (busy.length > 0) {
          console.info(`[federation-api] journal seed: ${busy.join(", ")} busy, retried later`);
          setTimeout(() => void seed(), SEED_RETRY_MS).unref();
        }
      } while (seedAgain);
    } catch (err) {
      console.error("[federation-api] journal seed failed:", err);
    } finally {
      seedRunning = false;
    }
  };
  // One per-peer limiter for what a peer may send: its pushes to the inbox
  // and the pages this instance pulls from it.
  const rateLimiter = createInMemoryRateLimiter();
  const peers = await PeerBook.load(sql, settings.peers);
  const app = await build({ sql, rateLimiter, peers, onSubscribed: () => void seed() });
  if (settings.enabled) void seed();

  // Key upkeep: the instance key is rotated well before it expires, the new
  // one endorsed by the old so peers follow it.
  let keyTimer: NodeJS.Timeout | undefined;
  if (settings.enabled) {
    const maintainKey = async () => {
      try {
        const kept = await maintainInstanceKey(sql, new Date().toISOString());
        if (kept.status !== "current") {
          const signsFrom = new Date(
            kept.key.notBefore.getTime() + KEY_PUBLICATION_LEAD_DAYS * 86_400_000,
          );
          console.info(
            `[federation-api] instance key ${kept.status}: ${kept.key.keyId}, valid until ` +
              `${kept.key.notAfter.toISOString()}, signing from ${signsFrom.toISOString()}`,
          );
        }
      } catch (err) {
        console.error("[federation-api] instance key upkeep failed:", err);
      }
    };
    keyTimer = setInterval(() => void maintainKey(), KEY_CYCLE_MS);
  }

  // Webhook push cron: a latency optimization over pull. Egress is SSRF-guarded
  // (guardedFetch), and a run only advances a subscription's cursor on a 2xx —
  // so a dropped push leaves the peer's pull catch-up gap-free.
  let webhookTimer: NodeJS.Timeout | undefined;
  if (settings.enabled) {
    const partOf = `${settings.actor!.baseUrl}/peer/outbox`;
    const egress = guardedFetch();
    // A subscriber is pushed its pinned tier's window, as it is served
    // everywhere else, and nothing once it is no longer pinned.
    const floorFor = (peerId: string) => {
      const tier = peers.find(peerId)?.trustTier;
      return tier === undefined ? null : backfillFloorIso(tier, new Date().toISOString());
    };
    // An inbox that asked to retry later is left alone that long.
    const backoff = new Map<string, number>();
    // Single-flight: skip a tick while the previous cycle is still running, so a
    // slow cycle can never overlap itself and regress a subscription's cursor or
    // failure counter.
    let cycleRunning = false;
    const runCycle = async () => {
      if (cycleRunning) return;
      cycleRunning = true;
      try {
        const signingKey = await loadSigningKey(sql, new Date().toISOString());
        if (!signingKey) return;
        await runWebhookDeliveryCycle(sql, {
          signingKey,
          fetchImpl: egress,
          partOf,
          floorFor,
          backoff,
        });
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
        const results = await refreshPeers(sql, settings, peers, {
          fetchImpl: egress,
          now: new Date().toISOString(),
        });
        for (const { peer, capabilities, subscription, pullSubscription } of results) {
          if (!capabilities.ok) {
            console.warn(
              `[federation-api] capabilities of ${peer} not refreshed: ${capabilities.reason}`,
            );
          }
          for (const [what, outcome] of [
            ["subscription", subscription],
            ["pull subscription", pullSubscription],
          ] as const) {
            if (outcome !== undefined && !outcome.ok) {
              console.warn(`[federation-api] ${what} at ${peer} not kept: ${outcome.reason}`);
            } else if (outcome?.ok && outcome.status !== "unchanged") {
              console.info(`[federation-api] ${what} at ${peer} ${outcome.status}`);
            }
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

  // Pull: each peer this instance pulls is read from its own cursor, so what
  // arrives is complete whatever the push carries. Single-flight.
  let pullTimer: NodeJS.Timeout | undefined;
  if (settings.enabled && settings.peers.some((peer) => peer.pull !== undefined)) {
    const egress = guardedFetch();
    const nonceStore = new InMemoryNonceStore();
    const registry = productionRegistry();
    let pullRunning = false;
    const pullAll = async () => {
      if (pullRunning) return;
      pullRunning = true;
      try {
        const signingKey = await loadSigningKey(sql, new Date().toISOString());
        if (!signingKey) return;
        for (const peer of peers.all()) {
          if (peer.pull === undefined) continue;
          const result = await pullPeer(
            sql,
            { ...peer, pull: peer.pull! },
            {
              registry,
              localInstanceId: settings.actor!.instanceId,
              signingKey,
              fetchImpl: egress,
              nonceStore,
              rateLimiter,
              now: () => new Date().toISOString(),
            },
          ).catch((err: unknown) => ({ error: String(err) }) as const);
          if (result.error !== undefined) {
            console.warn(`[federation-api] pull of ${peer.instanceId}: ${result.error}`);
          }
        }
      } finally {
        pullRunning = false;
      }
    };
    pullTimer = setInterval(() => void pullAll(), PULL_CYCLE_MS);
  }

  const close = async () => {
    if (webhookTimer) clearInterval(webhookTimer);
    if (keyTimer) clearInterval(keyTimer);
    if (capabilitiesTimer) clearInterval(capabilitiesTimer);
    if (pullTimer) clearInterval(pullTimer);
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
