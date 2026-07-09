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
import { deriveBaselines, pruneSpeedSamples } from "./pipeline/baseline-derive.js";
import { updateFintrafficNativeBaselines } from "./pipeline/fintraffic-native.js";
import { resolveOsmMaxspeed } from "./pipeline/osm-maxspeed.js";
import { createOpenlrClient, runSource as defaultRunSource } from "./pipeline/run.js";
import type { DomainFeedSource, RunDeps } from "./pipeline/run.js";
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
/** When the nightly baseline derivation + sample prune runs (UTC). */
const BASELINE_CRON = "0 3 * * *";
/** When the weekly segment-spine rebuild (import->build->openlr->match) runs (UTC). */
const SEGMENT_CRON = "0 4 * * 1";
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

  let derivingBaselines = false;
  const baselineJob = new Cron(BASELINE_CRON, { catch: true }, async () => {
    if (derivingBaselines) return;
    derivingBaselines = true;
    try {
      for (const plugin of Object.values(registry)) {
        for (const feed of plugin.feeds) {
          if (feed.format !== "fintraffic-tms-json" || !feed.enabledByDefault) continue;
          const { updated } = await updateFintrafficNativeBaselines(
            sql,
            feed as unknown as FeedSource,
            { fetch: guarded, now: () => new Date(), batchCap: 200 }
          );
          console.info(`[scheduler] fintraffic native baselines: ${updated} updated`);
        }
      }
      const { upserted } = await deriveBaselines(sql);
      const { deleted } = await pruneSpeedSamples(sql);
      console.info(`[scheduler] baselines: upserted ${upserted}, pruned ${deleted} sample(s)`);

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
