import { Cron } from "croner";
import type postgres from "postgres";
import { DOMAIN_REGISTRY } from "./domains.js";
import { hasCredentials, requiredEnvVars } from "@openconditions/ingest-framework";
import { createOpenlrClient, runSource as defaultRunSource } from "./pipeline/run.js";
import type { DomainFeedSource, RunDeps } from "./pipeline/run.js";
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
    statusStore.recordSuccess(src.id, now(), result.count, result.durationMs);
  } catch (err) {
    statusStore.recordError(src.id, now(), err instanceof Error ? err.message : String(err));
  }
}

/** How often the stale-observation sweep runs. */
const SWEEP_CRON = "*/5 * * * *";
/**
 * Rows whose `fetched_at` is older than this are swept as orphans. Far larger
 * than the slowest feed cadence (300s) so a healthy source is never removed.
 */
const ORPHAN_MAX_AGE_SEC = 3600;

function cadenceToCron(cadenceSec: number): string {
  if (cadenceSec < 60) return `*/${cadenceSec} * * * * *`;
  const mins = Math.round(cadenceSec / 60);
  return `*/${mins} * * * *`;
}

/**
 * Starts one `croner` job per enabled feed source across all registered domains.
 * Each job holds a single-flight boolean so slow runs do not overlap.
 * Returns a cancel function that stops all scheduled jobs.
 */
export function startScheduler(sql: Sql, statusStore: FeedStatusStore): () => void {
  const jobs: Cron[] = [];
  const openlrClient = createOpenlrClient();

  for (const [domainName, plugin] of Object.entries(DOMAIN_REGISTRY)) {
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
            { sql, fetch, now: () => new Date().toISOString(), openlrClient },
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
  });
  console.info(`[scheduler] registered stale-observation sweep (${SWEEP_CRON})`);
  jobs.push(sweepJob);

  return () => {
    for (const job of jobs) {
      job.stop();
    }
  };
}
