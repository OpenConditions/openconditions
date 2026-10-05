import {
  type Catalog,
  type CatalogFeed,
  type Env,
  guardedFetch,
  guardOptionsFromEnv,
  hasCredentials,
  missingCredentials,
} from "@openconditions/ingest-framework";
import { Cron } from "croner";
import type postgres from "postgres";
import { fetch as undiciFetch } from "undici";
import type { FeedStatusStore } from "./feed-status.js";
import { buildDailyArchive } from "./pipeline/archive-build.js";
import { deriveBaselines } from "./pipeline/baseline-derive.js";
import { drainBindingQueue as defaultDrainBindingQueue } from "./pipeline/bind-records.js";
import { updateFintrafficNativeBaselines } from "./pipeline/fintraffic-native.js";
import { overpassInterpreterUrl } from "./pipeline/osm-import.js";
import { resolveOsmMaxspeed } from "./pipeline/osm-maxspeed.js";
import { rebindOnBoot } from "./pipeline/rebind.js";
import type { RunDeps } from "./pipeline/run.js";
import {
  createOpenlrClient,
  createRoleState,
  runSource as defaultRunSource,
  pollTickSec,
} from "./pipeline/run.js";
import { deriveSegmentProfiles } from "./pipeline/segment-profile.js";
import { runSegmentRebuild } from "./pipeline/segment-rebuild.js";
import { refreshSegmentSpeed } from "./pipeline/segment-speed.js";
import { pruneSourcePollAttempts, upsertSourceStatus } from "./pipeline/source-status.js";
import { createRawArchive, rawArchiveOptionsFromEnv } from "./raw/archive.js";
import type { InFlight } from "./shutdown.js";

type Sql = postgres.Sql;

/** Overridable deps so the run body is unit-testable without cron. */
export interface RunFeedOnceDeps {
  runSource?: typeof defaultRunSource;
  drainBindingQueue?: typeof defaultDrainBindingQueue;
  now?: () => string;
}

/** Run one feed once and record the outcome in the status store. */
export async function runFeedOnce(
  src: CatalogFeed,
  deps: RunDeps,
  statusStore: FeedStatusStore,
  o: RunFeedOnceDeps = {},
): Promise<void> {
  const run = o.runSource ?? defaultRunSource;
  const now = o.now ?? (() => new Date().toISOString());
  try {
    const result = await run(src, deps);
    // No endpoint was due: the tick did no poll work, so there is nothing to
    // record; the shared binding queue is drained by the ticks that poll.
    if (result.notDue) return;
    if (result.error) {
      // runSource is fault-tolerant and swallows fetch/timeout/DNS/site-table
      // failures, returning {count:0, error} instead of throwing — record
      // those as errors too, or a down feed would look like a quiet success.
      console.error(`[scheduler] ${src.id}: ${result.error}`);
      statusStore.recordError(src.id, now(), result.error);
    } else {
      statusStore.recordSuccess(
        src.id,
        now(),
        result.count,
        result.durationMs,
        result.skippedNoGeometry,
      );
    }
    // Flow feeds derive congestion situations too, so every poll may have queued work.
    try {
      await (o.drainBindingQueue ?? defaultDrainBindingQueue)(deps.sql, { now: deps.now });
    } catch (err) {
      console.warn(`[scheduler] ${src.id}: binding queue drain failed`, err);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler] ${src.id}: ${message}`);
    statusStore.recordError(src.id, now(), message);
  }
}

/** How often the segment speeds are refreshed from the latest readings. */
const SEGMENT_SPEED_CRON = "*/5 * * * *";
/** How often the source-poll history is pruned. */
const POLL_HISTORY_CRON = "*/5 * * * *";
/**
 * When the nightly baseline derivation runs (UTC). It reads the hourly
 * `traffic.speed` rollup the record jobs keep current.
 */
const BASELINE_CRON = "0 3 * * *";
/** When the nightly static-archive (GeoParquet published-view) build runs (UTC) — after the baseline derivation. */
const ARCHIVE_CRON = "30 3 * * *";
/** When the weekly segment-spine rebuild (import->build->openlr->match) runs (UTC). */
const SEGMENT_CRON = "0 4 * * 1";
/** When the weekly segment speed-profile derivation runs (UTC) — after the nightly baseline, before the segment rebuild. */
const SEGMENT_PROFILE_CRON = "30 3 * * 1";

function cadenceToCron(cadenceSec: number): string {
  const tickSec = pollTickSec(cadenceSec);
  if (tickSec < 60) return `*/${tickSec} * * * * *`;
  if (tickSec === 3600) return "0 * * * *";
  const mins = Math.round(tickSec / 60);
  return `*/${mins} * * * *`;
}

/**
 * Resolves a job's cron expression from an env var: unset or empty (Compose's
 * `${VAR:-}` unset-injection) falls back to `fallback`; the `off` sentinel
 * (case-insensitive) disables the job entirely by returning `null`.
 */
function pickCronExpression(env: NodeJS.ProcessEnv, key: string, fallback: string): string | null {
  const raw = env[key];
  if (raw == null || raw === "") return fallback;
  if (raw.trim().toLowerCase() === "off") return null;
  return raw;
}

/** What every feed job shares. */
export interface FeedJobContext {
  sql: Sql;
  statusStore: FeedStatusStore;
  /** The run deps of every poll; each job adds its own role state. */
  deps: Omit<RunDeps, "roles" | "env">;
  /** Where credentials are read; defaults to `process.env`. */
  env?: Env;
  /** Tracks each poll, so shutdown waits for one in flight. */
  inFlight?: Pick<InFlight, "track">;
}

/**
 * Schedules one feed: a `croner` job on the feed's cadence, holding a
 * single-flight flag so slow runs do not overlap and the feed's role state,
 * so each poll fetches only the endpoints that are due. A feed missing a
 * credential it needs is not scheduled (not an error): its status names the
 * env vars to set, and it activates on the next start once they are. An
 * on-demand feed is never polled: a read fetches the cells it needs.
 */
export function scheduleFeed(feed: CatalogFeed, ctx: FeedJobContext): Cron | undefined {
  const { sql, statusStore } = ctx;
  if (feed.accessMode === "on_demand") return undefined;
  const env = ctx.env ?? process.env;
  const missing = missingCredentials(feed, env);
  if (missing.length > 0) {
    console.warn(
      `[scheduler] ${feed.domain}/${feed.id}: skipped — set ${missing.join(", ")} to enable`,
    );
    void upsertSourceStatus(sql, feed.id, {
      freshnessWindowSec: feed.freshnessWindowSec,
      outcome: "missing_configuration",
      attemptAt: new Date().toISOString(),
      networkValidated: false,
      error: `missing required configuration: ${missing.join(", ")}`,
    }).catch((err) => console.error(`[scheduler] ${feed.id}: status write failed`, err));
    return undefined;
  }

  const cronExpr = cadenceToCron(feed.cadenceSec);
  const deps: RunDeps = { ...ctx.deps, env, roles: createRoleState() };
  let running = false;
  const job = new Cron(cronExpr, { catch: true }, async () => {
    if (running) {
      console.debug(`[scheduler] ${feed.id}: skipping (previous run still active)`);
      void upsertSourceStatus(sql, feed.id, {
        freshnessWindowSec: feed.freshnessWindowSec,
        outcome: "skipped_overlap",
        attemptAt: new Date().toISOString(),
        networkValidated: false,
      }).catch((err) => console.error(`[scheduler] ${feed.id}: overlap status failed`, err));
      return;
    }
    running = true;
    try {
      const poll = runFeedOnce(feed, deps, statusStore);
      await (ctx.inFlight?.track(poll) ?? poll);
    } finally {
      running = false;
    }
  });
  console.info(
    `[scheduler] registered ${feed.domain}/${feed.id} every ${feed.cadenceSec}s (${cronExpr})`,
  );
  return job;
}

/**
 * Starts one job per scheduled feed of the catalogue, and the record and
 * segment jobs; `inFlight` tracks the feed polls. Returns a cancel function
 * that stops all scheduled jobs.
 */
export function startScheduler(
  sql: Sql,
  statusStore: FeedStatusStore,
  catalog: Catalog,
  inFlight?: Pick<InFlight, "track">,
): () => void {
  const jobs: Cron[] = [];
  const openlrClient = createOpenlrClient();
  const raw = createRawArchive(sql, rawArchiveOptionsFromEnv());
  // Same egress-guarded dispatcher the per-feed jobs use, reused for the
  // low-frequency Fintraffic native-baseline refresh below.
  const guarded = guardedFetch(undiciFetch as unknown as typeof fetch, guardOptionsFromEnv());
  // The Overpass the OpenStreetMap feeds query, read from the same setting.
  const overpassUrl = overpassInterpreterUrl(catalog.credentials);

  for (const feed of catalog.feeds) {
    const job = scheduleFeed(feed, {
      sql,
      statusStore,
      // undici's fetch (not the global) so the egress guard's IP-pinning
      // dispatcher is honored — the global fetch rejects a foreign undici Agent.
      deps: {
        sql,
        fetch: undiciFetch as unknown as typeof fetch,
        now: () => new Date().toISOString(),
        openlrClient,
        raw,
      },
      ...(inFlight ? { inFlight } : {}),
    });
    if (job) jobs.push(job);
  }

  // Fuses the latest site readings onto the segment spine. Expired and
  // orphaned records are swept by the record jobs.
  let refreshingSegments = false;
  const segmentSpeedJob = new Cron(SEGMENT_SPEED_CRON, { catch: true }, async () => {
    if (refreshingSegments) return;
    refreshingSegments = true;
    try {
      await refreshSegmentSpeed(sql, () => new Date().toISOString());
    } catch (err) {
      console.error("[scheduler] segment-speed refresh failed", err);
    } finally {
      refreshingSegments = false;
    }
  });
  console.info(`[scheduler] registered segment-speed refresh (${SEGMENT_SPEED_CRON})`);
  jobs.push(segmentSpeedJob);

  // Poll history is independent of publishing a source's records. Keep each
  // cleanup bounded and single-flight, including during a catch-up backlog.
  let pruningPollHistory = false;
  const pollHistoryJob = new Cron(POLL_HISTORY_CRON, { catch: true }, async () => {
    if (pruningPollHistory) return;
    pruningPollHistory = true;
    try {
      const { deleted } = await pruneSourcePollAttempts(sql);
      if (deleted > 0) console.info(`[scheduler] pruned ${deleted} old source-poll attempt(s)`);
    } catch (err) {
      console.error("[scheduler] source-poll retention failed", err);
    } finally {
      pruningPollHistory = false;
    }
  });
  jobs.push(pollHistoryJob);

  let derivingBaselines = false;
  const baselineJob = new Cron(BASELINE_CRON, { catch: true }, async () => {
    if (derivingBaselines) return;
    derivingBaselines = true;
    try {
      for (const feed of catalog.feeds) {
        if (feed.format !== "fintraffic-tms" || !hasCredentials(feed)) continue;
        const { updated } = await updateFintrafficNativeBaselines(sql, feed, {
          fetch: guarded,
          now: () => new Date(),
          batchCap: 200,
        });
        console.info(`[scheduler] fintraffic native baselines: ${updated} updated`);
      }
      const { upserted } = await deriveBaselines(sql);
      console.info(`[scheduler] baselines: upserted ${upserted}`);

      // Fills sensors that still lack any baseline (native/derived always win —
      // this only runs after both, so it never clobbers a better method).
      const osm = await resolveOsmMaxspeed(sql, {
        fetch: guarded,
        now: () => new Date().toISOString(),
        batchCap: 200,
        overpassUrl,
      });
      console.info(`[scheduler] osm-maxspeed fallback: ${osm.updated} baseline(s)`);
    } catch (err) {
      console.error("[scheduler] baseline derivation failed", err);
    } finally {
      derivingBaselines = false;
    }
  });
  console.info(`[scheduler] registered nightly baseline derivation (${BASELINE_CRON})`);
  jobs.push(baselineJob);

  const archiveCron = pickCronExpression(process.env, "ARCHIVE_CRON", ARCHIVE_CRON);
  if (archiveCron) {
    let buildingArchive = false;
    const archiveJob = new Cron(archiveCron, { catch: true }, async () => {
      if (buildingArchive) return;
      buildingArchive = true;
      try {
        // buildDailyArchive is itself best-effort (swallows an unwritable dir);
        // this guard covers a read/serialize failure so it never crashes cron.
        await buildDailyArchive(sql);
      } catch (err) {
        console.error("[scheduler] archive build failed", err);
      } finally {
        buildingArchive = false;
      }
    });
    console.info(`[scheduler] registered nightly static-archive build (${archiveCron})`);
    jobs.push(archiveJob);
  } else {
    console.info("[scheduler] nightly static-archive build disabled (ARCHIVE_CRON=off)");
  }

  const segmentProfileCron = pickCronExpression(
    process.env,
    "SEGMENT_PROFILE_CRON",
    SEGMENT_PROFILE_CRON,
  );
  if (segmentProfileCron) {
    let derivingProfiles = false;
    const segmentProfileJob = new Cron(segmentProfileCron, { catch: true }, async () => {
      if (derivingProfiles) return;
      derivingProfiles = true;
      try {
        const { upserted } = await deriveSegmentProfiles(sql, () => new Date().toISOString());
        console.info(`[scheduler] segment profiles: upserted ${upserted}`);
      } catch (err) {
        console.error("[scheduler] segment profile derivation failed", err);
      } finally {
        derivingProfiles = false;
      }
    });
    console.info(
      `[scheduler] registered weekly segment profile derivation (${segmentProfileCron})`,
    );
    jobs.push(segmentProfileJob);
  } else {
    console.info(
      "[scheduler] weekly segment profile derivation disabled (SEGMENT_PROFILE_CRON=off)",
    );
  }

  const segmentCron = pickCronExpression(process.env, "SEGMENT_REBUILD_CRON", SEGMENT_CRON);
  if (segmentCron) {
    let rebuildingSegments = false;
    const segmentJob = new Cron(segmentCron, { catch: true }, async () => {
      if (rebuildingSegments) return;
      rebuildingSegments = true;
      try {
        const counts = await runSegmentRebuild(sql, {
          fetch: guarded,
          now: () => new Date().toISOString(),
          overpassUrl,
        });
        console.info(
          `[scheduler] segment rebuild: imported ${counts.imported}, built ${counts.built}, ` +
            `encoded ${counts.encoded}, matched ${counts.matched}, rebound ${counts.rebound}`,
        );
      } catch (err) {
        console.error("[scheduler] segment rebuild failed", err);
      } finally {
        rebuildingSegments = false;
      }
    });
    console.info(`[scheduler] registered weekly segment rebuild (${segmentCron})`);
    jobs.push(segmentJob);
  } else {
    console.info("[scheduler] weekly segment rebuild disabled (SEGMENT_REBUILD_CRON=off)");
  }

  // Bind whatever is unbound or was bound by another resolver version (a new
  // deploy, or a first boot against an existing store), and drop the bindings
  // of situations no longer live. Fire-and-forget: feed pollers and server
  // start are not blocked, and a failure here is never fatal.
  void rebindOnBoot(sql, { now: () => new Date().toISOString() })
    .then((r) => {
      if (r.rebound > 0) console.info(`[scheduler] startup rebind: ${r.rebound} bindings`);
    })
    .catch((err: unknown) => console.warn("[scheduler] startup rebind failed", err));

  return () => {
    for (const job of jobs) {
      job.stop();
    }
  };
}
