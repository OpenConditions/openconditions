/**
 * Boot entry for the federation service: applies migrations, opens the
 * shared postgres pool, builds the Fastify app, and listens. Tests import
 * build() from server.ts instead of running this file.
 */

import { assertStoredCodesRegistered, runMigrations } from "@openconditions/core/server";
import {
  advanceJournalSeenXid,
  createInMemoryRateLimiter,
  ensureJournalEpoch,
  expireSubscriptions,
  FEDERATION_PROTOCOL_VERSION,
  InMemoryNonceStore,
  type JournalLagWatch,
  journalLagNotice,
  KEY_PUBLICATION_LEAD_DAYS,
  loadSigningKey,
  maintainInstanceKey,
  OUTBOX_PRUNE_INTERVAL_HOURS,
  pruneOutbox,
  RECORD_STATE_PROTOCOL_VERSION,
  REGISTRY_SYNC_INTERVAL_HOURS,
  readFenceHolder,
  readJournalLag,
  runWebhookDeliveryCycle,
} from "@openconditions/federation";
import {
  guardedFetch,
  guardOptionsFromEnv,
  requireCredential,
} from "@openconditions/ingest-framework";
import { productionRegistry } from "@openconditions/model-registry";
import { maintainObservationPartitions, seedFederation } from "@openconditions/storage";
import postgres from "postgres";
import { ARCHIVE_FILE_MAX_BYTES, ARCHIVE_FILE_TIMEOUT_MS } from "./archive-import.js";
import { backfillFloorIso } from "./backfill.js";
import { resolveFederationSettings } from "./config.js";
import { PeerBook } from "./peer-book.js";
import { peerFetch } from "./peer-egress.js";
import { refreshPeers } from "./peering.js";
import { holdProcessLock } from "./process-lock.js";
import { pullPeer } from "./puller.js";
import { type ReconcileCounts, reconcileAfter, reconcilePeer } from "./reconcile.js";
import { REGISTRY_RETRY_MS, RegistryDiscovery } from "./registry.js";
import { build } from "./server.js";
import { warnWithheld } from "./withheld.js";

/** How many days before the registry's trusted root expires each sync warns about it. */
const REGISTRY_ROOT_WARN_DAYS = 30;

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
/** The first wait before peer upkeep that left a peer unverified is tried again. */
const UPKEEP_RETRY_MS = 60 * 1000;

/** How often the instance key is checked for rotation. */
const KEY_CYCLE_MS = 6 * 60 * 60 * 1000;

/** How often the peers this instance pulls are read. */
const PULL_CYCLE_MS = 30_000;

/** How often the journal's fence lag is checked against the convergence bound. */
const LAG_CYCLE_MS = 60_000;

/** How often the observation partitions are kept, as the ingest service keeps them. */
const PARTITION_CYCLE_MS = 60 * 60 * 1000;

/** How often subscriptions whose lease ran out are deleted. */
const EXPIRY_CYCLE_MS = 60 * 60 * 1000;

async function boot() {
  const url = requireCredential(process.env, "DATABASE_URL");
  console.info("[federation-api] applying database migrations…");
  await runMigrations(url);
  console.info("[federation-api] migrations applied");

  let waiting = false;
  const lock = await holdProcessLock(url, {
    onWait: () => {
      if (!waiting) console.info("[federation-api] another federation process runs; waiting");
      waiting = true;
    },
    onLost: (reason) => {
      console.error("[federation-api] lost the single-process lock; stopping:", reason);
      process.exit(1);
    },
  });

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
  if (settings.enabled) {
    // The actor says which protocol versions it speaks; peers negotiate on
    // what it says, so one that leaves out the version this build speaks is
    // worth a warning, though not a failed boot.
    const { protocolVersion, protocolVersions } = settings.actor!.capabilities;
    const offered = new Set([protocolVersion, ...(protocolVersions ?? [])]);
    if (!offered.has(FEDERATION_PROTOCOL_VERSION)) {
      console.warn(
        `[federation-api] the actor offers protocol ${[...offered].join(", ")}, ` +
          `not ${FEDERATION_PROTOCOL_VERSION}, the version this build speaks`,
      );
    }
  }

  // The journal must belong to the database's current history before anything
  // reads or seeds it: after a restore, a timeline change or the operator's
  // request a new epoch starts, emptying the journal for the seed below to
  // fill again. Whether or not federation is enabled, as the capture writes
  // the journal regardless.
  await ensureJournalEpoch(sql, {
    now: new Date().toISOString(),
    log: (line) => console.warn(`[federation-api] ${line}`),
  });

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

  // Key upkeep: the instance key is rotated well before it expires, the new
  // one endorsed by the old so peers follow it. Once at boot, before the app
  // is built (which makes sure a key exists and so finds it current), so a
  // key created or rotated at boot is logged as on the timer.
  let keyTimer: NodeJS.Timeout | undefined;
  if (settings.enabled) {
    const maintainKey = async () => {
      try {
        const kept = await maintainInstanceKey(
          sql,
          new Date().toISOString(),
          settings.actor!.instanceId,
        );
        if (kept.status !== "current") {
          // A first key signs at once; a rotated one only after peers had time to read it.
          const signsFrom = new Date(
            kept.key.notBefore.getTime() + KEY_PUBLICATION_LEAD_DAYS * 86_400_000,
          );
          const signing =
            kept.status === "rotated" ? `signing from ${signsFrom.toISOString()}` : "signing now";
          console.info(
            `[federation-api] instance key ${kept.status}: ${kept.key.keyId}, valid until ` +
              `${kept.key.notAfter.toISOString()}, ${signing}`,
          );
        }
      } catch (err) {
        console.error("[federation-api] instance key upkeep failed:", err);
      }
    };
    await maintainKey();
    keyTimer = setInterval(() => void maintainKey(), KEY_CYCLE_MS);
  }

  // One per-peer limiter for what peers ask of this instance: their pushes to
  // the inbox and their journal reads. This instance's own pull is not metered.
  const rateLimiter = createInMemoryRateLimiter();
  const peers = await PeerBook.load(sql, settings.peers);
  const app = await build({ sql, rateLimiter, peers, onSubscribed: () => void seed() });
  if (settings.enabled) void seed();

  // Webhook push cron: a latency optimization over pull. Egress is SSRF-guarded
  // (peerFetch), and a run only advances a subscription's cursor on a 2xx —
  // so a dropped push leaves the peer's pull catch-up gap-free.
  let webhookTimer: NodeJS.Timeout | undefined;
  if (settings.enabled) {
    const partOf = `${settings.actor!.baseUrl}/peer/outbox`;
    const egress = peerFetch(settings);
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
        const pushed = await runWebhookDeliveryCycle(sql, {
          signingKey,
          fetchImpl: egress,
          partOf,
          floorFor,
          backoff,
        });
        warnWithheld(pushed.withheld);
        for (const { subscriptionId, peerId, httpStatus } of pushed.disabled) {
          console.warn(
            `[federation-api] push to ${peerId} disabled after repeated failures ` +
              `(subscription ${subscriptionId}, last answer ${httpStatus ?? "none"}): ` +
              "it stays off until the peer mends its subscription; its pull still gets everything",
          );
        }
      } catch (err) {
        console.error("[federation-api] webhook cycle failed:", err);
      } finally {
        cycleRunning = false;
      }
    };
    webhookTimer = setInterval(() => void runCycle(), WEBHOOK_CYCLE_MS);
  }

  // Retention cron: trims the append-only outbox journal on the tier-bounded time
  // floor (never a subscriber cursor), at boot and daily, so a service that
  // restarts more often than that still prunes. Single-flight, and it runs regardless of
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
      // How far the transaction ids got, so the next boot can tell they went back.
      await advanceJournalSeenXid(sql);
    } catch (err) {
      console.error("[federation-api] outbox prune failed:", err);
    } finally {
      pruneRunning = false;
    }
  };
  void runPrune();
  const pruneTimer = setInterval(() => void runPrune(), PRUNE_CYCLE_MS);

  // Lease expiry: a subscription its peer stopped renewing is deleted, at boot
  // and hourly, so this instance stops journalling for a peer that went away.
  // Single-flight.
  let expiryRunning = false;
  const runExpiry = async () => {
    if (expiryRunning) return;
    expiryRunning = true;
    try {
      const expired = await expireSubscriptions(sql, new Date().toISOString());
      for (const { id, peerId } of expired) {
        console.info(`[federation-api] subscription ${id} of ${peerId} expired: not renewed`);
      }
    } catch (err) {
      console.error("[federation-api] subscription expiry failed:", err);
    } finally {
      expiryRunning = false;
    }
  };
  void runExpiry();
  const expiryTimer = setInterval(() => void runExpiry(), EXPIRY_CYCLE_MS);

  // Lag check: the journal's fence holds back every committed entry while an
  // older write transaction is open anywhere on the server. Warns while that
  // lasts longer than the convergence bound this instance advertises, naming
  // the session that holds it where this role may see it. Single-flight.
  let lagTimer: NodeJS.Timeout | undefined;
  if (settings.enabled) {
    const boundSec = settings.actor!.capabilities.convergenceBound;
    let watch: JournalLagWatch = { warnedAt: null };
    let lagRunning = false;
    const checkLag = async () => {
      if (lagRunning) return;
      lagRunning = true;
      try {
        const nowIso = new Date().toISOString();
        const lag = await readJournalLag(sql, nowIso);
        const decided = journalLagNotice(watch, lag.lagSec, boundSec, Date.parse(nowIso));
        watch = decided.watch;
        if (decided.notice === "warn") {
          const holder = await readFenceHolder(sql);
          const held =
            holder === null
              ? ""
              : `; held by ${holder.applicationName ?? "a session this role cannot see"}` +
                (holder.xactStart === null
                  ? ""
                  : `, its transaction open ${Math.round(
                      (Date.parse(nowIso) - Date.parse(holder.xactStart)) / 1000,
                    )} s`);
          console.warn(
            `[federation-api] journal entries held back ${lag.lagSec} s, past the ` +
              `convergence bound of ${boundSec} s${held}`,
          );
        } else if (decided.notice === "recovered") {
          console.info("[federation-api] journal lag back within the convergence bound");
        }
      } catch (err) {
        console.error("[federation-api] journal lag check failed:", err);
      } finally {
        lagRunning = false;
      }
    };
    lagTimer = setInterval(() => void checkLag(), LAG_CYCLE_MS);
  }

  // Peer upkeep: what each pinned peer's actor document advertises, verified
  // against its pin and negotiated, at boot and hourly after. Its records are
  // admitted against them; a peer not yet verified is asked to retry its
  // inbox delivery. A peer this instance subscribes to is kept pushing to its
  // inbox: a subscription missing, changed or disabled there is mended. A run
  // in which a peer could not be verified or a subscription not kept is tried
  // again after a minute, then after twice as long each time up to the hour,
  // so a peer that was down at boot is not left unverified for an hour.
  let capabilitiesTimer: NodeJS.Timeout | undefined;
  // Set once the service closes, so an upkeep run that ends then schedules no next one.
  let closing = false;
  let registryTimer: NodeJS.Timeout | undefined;
  if (settings.enabled) {
    const egress = peerFetch(settings);
    let upkeepRunning = false;
    let upkeepRetryMs = UPKEEP_RETRY_MS;
    const refreshAll = async () => {
      if (upkeepRunning) return;
      upkeepRunning = true;
      // Whether every peer was verified and every subscription kept.
      let complete = false;
      try {
        const results = await refreshPeers(sql, settings, peers, {
          fetchImpl: egress,
          now: new Date().toISOString(),
        });
        complete = results.every(
          (r) =>
            r.capabilities.ok && r.subscription?.ok !== false && r.pullSubscription?.ok !== false,
        );
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
        const next = complete ? CAPABILITIES_CYCLE_MS : upkeepRetryMs;
        upkeepRetryMs = complete
          ? UPKEEP_RETRY_MS
          : Math.min(upkeepRetryMs * 2, CAPABILITIES_CYCLE_MS);
        if (capabilitiesTimer) clearTimeout(capabilitiesTimer);
        if (!closing) {
          capabilitiesTimer = setTimeout(() => void refreshAll(), next);
          capabilitiesTimer.unref();
        }
      }
    };
    void refreshAll();

    // Registry discovery: daily, and an hour after a sync that failed. The
    // peers a verified sync found are verified and kept up like the
    // configured ones from then on, and stored beside the registry cache:
    // when the first sync after boot fails, the stored ones are taken back.
    // The registry is fetched through the egress guard, without the client
    // certificate peers are shown.
    const registry = settings.registry;
    if (registry !== undefined) {
      const discovery = new RegistryDiscovery(
        peers,
        registry,
        settings.actor!.instanceId,
        guardedFetch(),
      );
      const syncRegistryNow = async () => {
        let next = REGISTRY_SYNC_INTERVAL_HOURS * 60 * 60 * 1000;
        try {
          const { added, removed, changed, storeError, rootExpires } = await discovery.sync(
            new Date().toISOString(),
          );
          if (
            rootExpires !== undefined &&
            Date.parse(rootExpires) - Date.now() < REGISTRY_ROOT_WARN_DAYS * 86_400_000
          ) {
            console.warn(
              `[federation-api] registry: its trusted root expires ${rootExpires}; once it has, ` +
                "no sync verifies until the registry publishes a newer root",
            );
          }
          if (added.length + removed.length + changed.length > 0) {
            console.info(
              `[federation-api] registry: added ${added.join(", ") || "none"}, ` +
                `removed ${removed.join(", ") || "none"}, changed ${changed.join(", ") || "none"}`,
            );
            void refreshAll();
          }
          if (storeError !== undefined) {
            console.warn(
              `[federation-api] registry: the verified peers could not be stored in ` +
                `${discovery.file}, so a restart while the registry fails starts without them: ` +
                storeError,
            );
          }
        } catch (err) {
          next = REGISTRY_RETRY_MS;
          const restored = await discovery.restore(new Date().toISOString());
          if (restored.status === "restored") {
            console.warn(
              `[federation-api] registry sync failed; the ${restored.peers} peers of the ` +
                `verified sync of ${restored.syncedAt}, stored in ${restored.file}, stay:`,
              err,
            );
            if (restored.peers > 0) void refreshAll();
          } else if (restored.status === "absent") {
            console.error(
              "[federation-api] registry sync failed, and no verified sync is stored: " +
                "no peer of the registry is known until one succeeds:",
              err,
            );
          } else if (restored.status === "expired" || restored.status === "other-root") {
            console.warn(
              restored.status === "expired"
                ? `[federation-api] the stored peers of the last verified sync in ${restored.file} ` +
                    `are older than the registry metadata allows (its targets metadata ` +
                    `${restored.expires === null ? "states no expiry" : `expired ${restored.expires}`}): ` +
                    "they are not taken back"
                : `[federation-api] the stored peers of the last verified sync in ${restored.file} ` +
                    "were verified under another registry root than the one configured: " +
                    "they are not taken back",
            );
            console.error(
              "[federation-api] registry sync failed: no peer of the registry is known " +
                "until one succeeds:",
              err,
            );
          } else if (restored.status === "unreadable") {
            console.warn(
              `[federation-api] the stored peers of the last verified sync in ${restored.file} ` +
                `are ignored: ${restored.error}`,
            );
            console.error(
              "[federation-api] registry sync failed: no peer of the registry is known " +
                "until one succeeds:",
              err,
            );
          } else {
            const expired = discovery.expire(new Date().toISOString());
            if (expired !== undefined) {
              console.error(
                `[federation-api] registry sync failed, and the targets metadata its ` +
                  `${expired.peers} peers came from expired ${expired.expires}: they are no ` +
                  "longer trusted until a sync succeeds:",
                err,
              );
              void refreshAll();
            } else {
              console.error(
                `[federation-api] registry sync failed; the ${peers.discovered().length} peers ` +
                  "of the last verified sync stay:",
                err,
              );
            }
          }
        }
        registryTimer = setTimeout(() => void syncRegistryNow(), next);
      };
      void syncRegistryNow();
    }
  }

  // Observation partitions: a peer's readings land in the observation
  // history, whose partitions the ingest service keeps. An instance that
  // pulls from or subscribes to a peer keeps them too, so a mirror without
  // the ingest service lands them: at boot, before the first pull, and
  // hourly, with the ingest's own function and horizon, under the lock it
  // takes. A failure is logged and left to the next run.
  let partitionTimer: NodeJS.Timeout | undefined;
  if (
    settings.enabled &&
    settings.peers.some((peer) => peer.pull !== undefined || peer.subscribe !== undefined)
  ) {
    const registry = productionRegistry();
    let partitionsRunning = false;
    const keepPartitions = async () => {
      if (partitionsRunning) return;
      partitionsRunning = true;
      try {
        const { created, dropped } = await maintainObservationPartitions(sql, registry, new Date());
        if (created.length + dropped.length > 0) {
          console.info(
            `[federation-api] observation partitions: ${created.length} created, ` +
              `${dropped.length} dropped`,
          );
        }
      } catch (err) {
        console.error("[federation-api] observation partition upkeep failed:", err);
      } finally {
        partitionsRunning = false;
      }
    };
    await keepPartitions();
    partitionTimer = setInterval(() => void keepPartitions(), PARTITION_CYCLE_MS);
  }

  // Pull: each peer this instance pulls is read from its own cursor, so what
  // arrives is complete whatever the push carries. Single-flight. Each peer
  // gets a time slice per cycle; while one has more to read and its cursor
  // moved in this cycle, the next cycle runs at once instead of on the timer,
  // so a backlog drains with every peer taking its turn, and a cycle that got
  // nowhere waits for the timer. A peer that asked to retry later is left alone that long.
  // Once a peer's pull reached its live tail, a comparison of the copies held
  // here with the peer's state runs while one is due (after the peer's journal
  // started over, or a page said the cursor was beyond its window), in slices
  // as well, resuming where it stopped.
  let pullTimer: NodeJS.Timeout | undefined;
  if (settings.enabled && settings.peers.some((peer) => peer.pull !== undefined)) {
    const egress = peerFetch(settings);
    // A peer's archive files are far larger and slower than its pages.
    const archiveEgress = peerFetch(settings, {
      ...guardOptionsFromEnv(),
      maxBytes: ARCHIVE_FILE_MAX_BYTES,
      timeoutMs: ARCHIVE_FILE_TIMEOUT_MS,
    });
    const nonceStore = new InMemoryNonceStore();
    const registry = productionRegistry();
    const retryAt = new Map<string, number>();
    /** When each peer that cannot be compared with was last said to be so. */
    const unsupportedSaidAt = new Map<string, number>();
    /** What each peer's running comparison did in the rounds so far. */
    const reconciled = new Map<string, ReconcileCounts>();
    let pullRunning = false;
    const pullAll = async () => {
      if (pullRunning) return;
      pullRunning = true;
      let again = false;
      try {
        const signingKey = await loadSigningKey(sql, new Date().toISOString());
        if (!signingKey) return;
        for (const peer of peers.all()) {
          if (peer.pull === undefined) continue;
          if ((retryAt.get(peer.instanceId) ?? 0) > Date.now()) continue;
          const result = await pullPeer(
            sql,
            { ...peer, pull: peer.pull! },
            {
              registry,
              localInstanceId: settings.actor!.instanceId,
              signingKey,
              fetchImpl: egress,
              archiveFetch: archiveEgress,
              nonceStore,
              now: () => new Date().toISOString(),
            },
          ).catch((err: unknown) => ({ error: String(err) }) as const);
          if ("retryAfterSec" in result && result.retryAfterSec !== undefined) {
            retryAt.set(peer.instanceId, Date.now() + result.retryAfterSec * 1000);
          } else {
            retryAt.delete(peer.instanceId);
          }
          // Straight on only while the pull got somewhere: a round that moved
          // nothing waits for the timer rather than spin.
          if ("more" in result && result.more && result.error === undefined && result.advanced) {
            again = true;
          }
          if ("reset" in result && result.reset !== undefined) {
            console.warn(
              `[federation-api] pull of ${peer.instanceId}: the peer's journal started over ` +
                `(${result.reset === "epoch" ? "a new epoch" : "the cursor is ahead of it"}); ` +
                "reading it again from the start",
            );
          }
          if (result.error !== undefined) {
            console.warn(`[federation-api] pull of ${peer.instanceId}: ${result.error}`);
          }
          if ("longAbsence" in result && result.longAbsence === true) {
            console.info(
              `[federation-api] pull of ${peer.instanceId}: its first answer in over 30 days; ` +
                "this instance's copies of its records are compared with its present state",
            );
          }
          if ("archive" in result && result.archive !== undefined) {
            const { accepted, stale, skipped } = result.archive;
            console.info(
              `[federation-api] archive of ${peer.instanceId}: ${accepted} landed, ` +
                `${stale} stale, ${skipped} skipped`,
            );
          }
          if (!reconcileAfter(result)) continue;
          const compared = await reconcilePeer(
            sql,
            { ...peer, pull: peer.pull! },
            {
              registry,
              localInstanceId: settings.actor!.instanceId,
              signingKey,
              fetchImpl: egress,
              nonceStore,
              now: () => new Date().toISOString(),
            },
          ).catch((err: unknown) => ({ status: "failed", error: String(err) }) as const);
          if (compared.status === "unsupported") {
            if ((unsupportedSaidAt.get(peer.instanceId) ?? 0) <= Date.now() - 86_400_000) {
              unsupportedSaidAt.set(peer.instanceId, Date.now());
              console.warn(
                `[federation-api] reconcile of ${peer.instanceId} is due, but the peer speaks ` +
                  `protocol ${compared.protocolVersion ?? "unknown"}, before ` +
                  `${RECORD_STATE_PROTOCOL_VERSION}: its copies here stay as they are`,
              );
            }
            continue;
          }
          if ("counts" in compared) {
            const sum = reconciled.get(peer.instanceId);
            if (sum !== undefined) {
              for (const key of Object.keys(sum) as (keyof ReconcileCounts)[]) {
                sum[key] += compared.counts[key];
              }
            } else {
              reconciled.set(peer.instanceId, { ...compared.counts });
            }
          }
          if (compared.status === "more" && compared.progressed) again = true;
          if (compared.status === "stopped" || compared.status === "failed") {
            console.warn(`[federation-api] reconcile of ${peer.instanceId}: ${compared.error}`);
          }
          if (compared.status === "stopped" && compared.retryAfterSec !== undefined) {
            retryAt.set(peer.instanceId, Date.now() + compared.retryAfterSec * 1000);
          }
          if (compared.status === "finished") {
            const {
              compared: n,
              updated,
              restored,
              ended,
              retired,
              refused,
            } = reconciled.get(peer.instanceId) ?? compared.counts;
            reconciled.delete(peer.instanceId);
            console.info(
              `[federation-api] reconcile of ${peer.instanceId}: ${n} compared, ` +
                `${updated} updated, ${restored} restored, ${ended} ended, ${retired} retired, ` +
                `${refused} refused`,
            );
          }
        }
      } finally {
        pullRunning = false;
      }
      if (again) setImmediate(() => void pullAll());
    };
    pullTimer = setInterval(() => void pullAll(), PULL_CYCLE_MS);
  }

  const close = async () => {
    closing = true;
    if (webhookTimer) clearInterval(webhookTimer);
    if (keyTimer) clearInterval(keyTimer);
    if (capabilitiesTimer) clearTimeout(capabilitiesTimer);
    if (registryTimer) clearTimeout(registryTimer);
    if (pullTimer) clearInterval(pullTimer);
    if (partitionTimer) clearInterval(partitionTimer);
    if (lagTimer) clearInterval(lagTimer);
    clearInterval(pruneTimer);
    clearInterval(expiryTimer);
    await app.close();
    await sql.end();
    await lock.release();
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
