import { Cron } from "croner";
import type postgres from "postgres";
import { fetch as undiciFetch } from "undici";
import {
  guardedFetch,
  guardOptionsFromEnv,
  hasCredentials,
  requiredEnvVars,
  type DomainRegistry,
} from "@openconditions/ingest-framework";
import type { FeedSource } from "@openconditions/roads";
import { buildDailyArchive } from "./pipeline/archive-build.js";
import { deriveBaselines } from "./pipeline/baseline-derive.js";
import { pruneHourlyRollup, pruneRawSamples, rollupSpeedSamples } from "./pipeline/speed-rollup.js";
import { updateFintrafficNativeBaselines } from "./pipeline/fintraffic-native.js";
import { resolveOsmMaxspeed } from "./pipeline/osm-maxspeed.js";
import { createOpenlrClient, runSource as defaultRunSource } from "./pipeline/run.js";
import type { DomainFeedSource, RunDeps } from "./pipeline/run.js";
import { deriveSegmentProfiles } from "./pipeline/segment-profile.js";
import { runSegmentRebuild } from "./pipeline/segment-rebuild.js";
import { refreshSegmentSpeed } from "./pipeline/segment-speed.js";
import { sweepStaleObservations } from "./pipeline/sweep.js";
import { FeedStatusStore } from "./feed-status.js";

type Sql = postgres.Sql;

/** Overridable deps so the run body is unit-testable without cron. */
export interface RunFeedOnceDeps {
  runSource?: typeof defaultRunSource;
  now?: () => string;
}

/** Run one feed once and record the outcome in the status store. */
export async function runFeedOnce(
  src: DomainFeedSource,
  deps: RunDeps,
  statusStore: FeedStatusStore,
  o: RunFeedOnceDeps = {}
): Promise<void> {
  const run = o.runSource ?? defaultRunSource;
  const now = o.now ?? (() => new Date().toISOString());
  try {
    const result = await run(src, deps);
    if (result.error) {
      // runSource is fault-tolerant and swallows fetch/timeout/DNS/site-table
      // failures, returning {count:0, error} instead of throwing — record
      // those as errors too, or a down feed would look like a quiet success.
      console.error(`[scheduler] ${src.id}: ${result.error}`);
      statusStore.recordError(src.id, now(), result.error);
    } else {
      statusStore.recordSuccess(src.id, now(), result.count, result.durationMs);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler] ${src.id}: ${message}`);
    statusStore.recordError(src.id, now(), message);
  }
}

/** How often the stale-observation sweep runs. */
const SWEEP_CRON = "*/5 * * * *";
/**
 * How often raw speed samples are rolled into per-(sensor, hour) histograms.
 * Runs a few minutes past the hour so the hour it closes is complete (the rollup
 * only ever aggregates finished hours).
 */
const SPEED_ROLLUP_CRON = "10 * * * *";
/** When the nightly baseline derivation + sample prune runs (UTC). */
const BASELINE_CRON = "0 3 * * *";
/** When the nightly static-archive (GeoParquet published-view) build runs (UTC) — after the baseline derivation. */
const ARCHIVE_CRON = "30 3 * * *";
/** When the weekly segment-spine rebuild (import->build->openlr->match) runs (UTC). */
const SEGMENT_CRON = "0 4 * * 1";
/** When the weekly segment speed-profile derivation runs (UTC) — after the nightly baseline, before the segment rebuild. */
const SEGMENT_PROFILE_CRON = "30 3 * * 1";
/**
 * A source is swept as orphaned when its `conditions.source_status.
 * last_success_at` is older than this, or it has no source_status row at all
 * (see sweepStaleObservations). Far larger than the slowest feed cadence
 * (300s) so a healthy source is never removed.
 */
const ORPHAN_MAX_AGE_SEC = 3600;

function cadenceToCron(cadenceSec: number): string {
  if (cadenceSec < 60) return `*/${cadenceSec} * * * * *`;
  const mins = Math.round(cadenceSec / 60);
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

/**
 * Starts one `croner` job per enabled feed source across all registered domains.
 * Each job holds a single-flight boolean so slow runs do not overlap.
 * Returns a cancel function that stops all scheduled jobs.
 */
export function startScheduler(
  sql: Sql,
  statusStore: FeedStatusStore,
  registry: DomainRegistry
): () => void {
  const jobs: Cron[] = [];
  const openlrClient = createOpenlrClient();
  // Same egress-guarded dispatcher the per-feed jobs use, reused for the
  // low-frequency Fintraffic native-baseline refresh below.
  const guarded = guardedFetch(undiciFetch as unknown as typeof fetch, guardOptionsFromEnv());

  for (const [domainName, plugin] of Object.entries(registry)) {
    const enabled = plugin.feeds.filter((f) => f.enabledByDefault);

    for (const feed of enabled) {
      // A feed that declares credentials it doesn't have configured is skipped
      // (not an error) — it activates automatically once its env vars are set.
      if (!hasCredentials(feed)) {
        const needed = [...requiredEnvVars(feed.auth), ...(feed.requiredEnv ?? [])];
        console.warn(
          `[scheduler] ${domainName}/${feed.id}: skipped — set ${needed.join(", ")} to enable`
        );
        continue;
      }
      // plugin.feeds is typed against the domain-generic FeedSourceBase; runSource
      // needs the concrete per-domain FeedSource shape the actual feed objects have.
      const src = { ...feed, domain: domainName } as DomainFeedSource;
      const cronExpr = cadenceToCron(feed.cadenceSec);
      let running = false;

      const job = new Cron(cronExpr, { catch: true }, async () => {
        if (running) {
          console.debug(`[scheduler] ${src.id}: skipping (previous run still active)`);
          return;
        }
        running = true;
        try {
          await runFeedOnce(
            src,
            // undici's fetch (not the global) so the egress guard's IP-pinning
            // dispatcher is honored — the global fetch rejects a foreign undici Agent.
            {
              sql,
              fetch: undiciFetch as unknown as typeof fetch,
              now: () => new Date().toISOString(),
              openlrClient,
            },
            statusStore
          );
        } finally {
          running = false;
        }
      });

      console.info(
        `[scheduler] registered ${domainName}/${src.id} every ${feed.cadenceSec}s (${cronExpr})`
      );
      jobs.push(job);
    }
  }

  // Periodic cleanup: remove expired conditions + orphaned rows from sources
  // that stopped polling (the per-source atomic swap only cleans live feeds).
  let sweeping = false;
  let refreshingSegments = false;
  const sweepJob = new Cron(SWEEP_CRON, { catch: true }, async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const { deleted } = await sweepStaleObservations(sql, { maxAgeSec: ORPHAN_MAX_AGE_SEC });
      if (deleted > 0) console.info(`[scheduler] sweep removed ${deleted} stale observation(s)`);
    } catch (err) {
      console.error("[scheduler] sweep failed", err);
    } finally {
      sweeping = false;
    }

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
  console.info(`[scheduler] registered stale-observation sweep (${SWEEP_CRON})`);
  jobs.push(sweepJob);

  // Roll raw speed samples into per-(sensor, hour) histograms. Hourly rather
  // than nightly so raw never has to hold more than a few hours of unaggregated
  // backlog (it takes ~20M rows/day), and so the raw prune always has a fresh
  // watermark to stay behind.
  let rollingUpSpeed = false;
  const speedRollupJob = new Cron(SPEED_ROLLUP_CRON, { catch: true }, async () => {
    if (rollingUpSpeed) return;
    rollingUpSpeed = true;
    try {
      const { hours, rows } = await rollupSpeedSamples(sql);
      if (rows > 0) {
        console.info(`[scheduler] speed rollup: ${rows} hour-row(s) over ${hours}h`);
      }
    } catch (err) {
      console.error("[scheduler] speed rollup failed", err);
    } finally {
      rollingUpSpeed = false;
    }
  });
  console.info(`[scheduler] registered speed rollup (${SPEED_ROLLUP_CRON})`);
  jobs.push(speedRollupJob);

  let derivingBaselines = false;
  const baselineJob = new Cron(BASELINE_CRON, { catch: true }, async () => {
    if (derivingBaselines) return;
    derivingBaselines = true;
    try {
      for (const plugin of Object.values(registry)) {
        for (const feed of plugin.feeds) {
          if (feed.format !== "fintraffic-tms" || !feed.enabledByDefault) continue;
          const { updated } = await updateFintrafficNativeBaselines(
            sql,
            feed as unknown as FeedSource,
            { fetch: guarded, now: () => new Date(), batchCap: 200 }
          );
          console.info(`[scheduler] fintraffic native baselines: ${updated} updated`);
        }
      }
      // Roll up before deriving so the window includes the hours since the last
      // hourly run, and before pruning so the prune has a current watermark to
      // stay behind (it refuses to outrun the rollup).
      const rolled = await rollupSpeedSamples(sql);
      const { upserted } = await deriveBaselines(sql);
      const { deleted } = await pruneRawSamples(sql);
      const prunedHours = await pruneHourlyRollup(sql);
      console.info(
        `[scheduler] baselines: rolled up ${rolled.rows} hour-row(s) over ${rolled.hours}h, ` +
          `upserted ${upserted}, pruned ${deleted} raw sample(s) and ${prunedHours.deleted} rollup hour(s)`
      );

      // Fills sensors that still lack any baseline (native/derived always win —
      // this only runs after both, so it never clobbers a better method).
      const osm = await resolveOsmMaxspeed(sql, {
        fetch: guarded,
        now: () => new Date().toISOString(),
        batchCap: 200,
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
    SEGMENT_PROFILE_CRON
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
      `[scheduler] registered weekly segment profile derivation (${segmentProfileCron})`
    );
    jobs.push(segmentProfileJob);
  } else {
    console.info(
      "[scheduler] weekly segment profile derivation disabled (SEGMENT_PROFILE_CRON=off)"
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
        });
        console.info(
          `[scheduler] segment rebuild: imported ${counts.imported}, built ${counts.built}, ` +
            `encoded ${counts.encoded}, matched ${counts.matched}`
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

  return () => {
    for (const job of jobs) {
      job.stop();
    }
  };
}
