import type { CatalogFeed } from "@openconditions/ingest-framework";
import type { Registry } from "@openconditions/model";
import {
  dropExpiredObservationPartitions,
  ensureObservationPartitions,
  isLockTimeout,
  pruneRollups,
  refreshFlippedFusions,
  retentionClasses,
  rollupObservations,
  rollupRetentionDaysFromEnv,
  sweepRecords,
} from "@openconditions/storage";
import { Cron } from "croner";
import type postgres from "postgres";
import type { SourceScope } from "./ingest-role.js";
import { rawArchiveOptionsFromEnv } from "./raw/archive.js";
import { evictionPolicyFromEnv, evictRawPayloads } from "./raw/evict.js";

/** How often expired and orphaned records are tombstoned and old tombstones purged. */
const RECORD_SWEEP_CRON = "*/5 * * * *";
/** Fusions are refreshed for the sources whose freshness flipped, every five minutes. */
const FUSION_FLIP_CRON = "2-59/5 * * * *";
/** History partitions are created ahead and dropped behind every hour. */
const PARTITION_CRON = "5 * * * *";
/** Hourly rollups run after the partition job; the daily ones once the night's lateness has passed. */
const HOURLY_ROLLUP_CRON = "15 * * * *";
const DAILY_ROLLUP_CRON = "45 6 * * *";
/** Raw payloads are evicted by their tiers and the cap every 15 minutes. */
const RAW_EVICTION_CRON = "*/15 * * * *";
/** A feed record outlives its source's last success by at least this much. */
export const ORPHAN_MAX_AGE_SEC = 3600;

/**
 * How long each feed's records outlive its last success, where that is
 * longer than the hour: twice its slowest data role's cadence. A site of a
 * daily snapshot stays while the snapshot holds, though the five-minute
 * status beside it fails; its readings lapse by their own `validUntil`.
 */
export function orphanMaxAges(feeds: readonly CatalogFeed[]): Record<string, number> {
  const ages: Record<string, number> = {};
  for (const feed of feeds) {
    const cadences = Object.values(feed.endpoints)
      .filter((e) => e.decoder === undefined)
      .map((e) => e.cadenceSec);
    const age = 2 * Math.max(0, ...cadences);
    if (age > ORPHAN_MAX_AGE_SEC) ages[feed.id] = age;
  }
  return ages;
}

export interface RecordJobsOptions {
  registry: Registry;
  instanceId: string;
  /**
   * The catalogue's feeds, whichever process polls them: their snapshot
   * cadences set their records' orphan age.
   */
  feeds?: readonly CatalogFeed[];
  /**
   * Whether this process runs the jobs one process of a deployment runs
   * (default true): partitions, rollups, the sweep and the fusion refresh.
   * Every process evicts its own raw payloads.
   */
  primary?: boolean;
  /** The sources whose raw payloads lie on this process's volume; default all. */
  scope?: SourceScope;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** Days a tombstoned record and its revisions stay for the history API (default 90). */
export function historyDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["OPENCONDITIONS_HISTORY_DAYS"];
  const days = raw == null || raw === "" ? Number.NaN : Number(raw);
  return Number.isInteger(days) && days > 0 ? days : 90;
}

/**
 * A job that never overlaps itself: a run still going when the next is due
 * is skipped, and a failure is logged, never thrown into the scheduler.
 */
function singleFlight(name: string, run: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await run();
    } catch (err) {
      console.error(`[records] ${name} failed`, err);
    } finally {
      running = false;
    }
  };
}

/**
 * Creates the observation history partitions the registry's retention
 * classes need around `now`, and drops those past retention. Boot awaits it,
 * so no write meets a missing partition.
 */
export async function maintainPartitions(
  sql: postgres.Sql,
  registry: Registry,
  now: Date,
): Promise<{ created: string[]; dropped: string[] }> {
  const created = await ensureObservationPartitions(sql, {
    classes: retentionClasses(registry),
    now,
  });
  const dropped = await dropExpiredObservationPartitions(sql, { now, registry });
  return { created, dropped };
}

/** How often boot tries the partitions while a lock they need is held. */
const BOOT_PARTITION_ATTEMPTS = 5;

/**
 * {@link maintainPartitions} at boot, which must succeed. Partition DDL needs
 * a lock every write to the history holds, and the maintenance pool waits
 * only seconds for it, so a write still running (another service's) is
 * waited out a few times, a little longer each time.
 */
export async function maintainPartitionsAtBoot(
  sql: postgres.Sql,
  registry: Registry,
  now: () => Date,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await maintainPartitions(sql, registry, now());
      return;
    } catch (err) {
      if (!isLockTimeout(err) || attempt === BOOT_PARTITION_ATTEMPTS) throw err;
      console.warn(`[records] partitions: a lock is held, trying again (${attempt})`);
      await pause(2_000 * attempt);
    }
  }
}

/**
 * The hourly partition run. A lock held past the pool's lock_timeout leaves
 * the work to the next run: partitions exist days ahead of any write.
 */
export async function maintainPartitionsHourly(
  sql: postgres.Sql,
  registry: Registry,
  now: Date,
): Promise<void> {
  try {
    const { created, dropped } = await maintainPartitions(sql, registry, now);
    if (created.length + dropped.length > 0) {
      console.info(`[records] partitions +${created.length} -${dropped.length}`);
    }
  } catch (err) {
    if (!isLockTimeout(err)) throw err;
    console.warn("[records] partitions: a lock is held, left to the next run");
  }
}

/**
 * A job that hands `refresh` the windows its runs cover, one after the
 * other: each run takes the time since the previous run (the first, the
 * hour before it), so a freshness flip between two runs is seen once.
 */
export function windowedRuns(
  refresh: (window: { from: string; to: string }) => Promise<number>,
  now: () => Date,
): () => Promise<number> {
  let from: Date | undefined;
  return async () => {
    const to = now();
    const window = {
      from: (from ?? new Date(to.getTime() - 3_600_000)).toISOString(),
      to: to.toISOString(),
    };
    const flipped = await refresh(window);
    from = to;
    return flipped;
  };
}

/**
 * Starts the scheduled jobs that keep the record tables in shape: the
 * fusion refresh on the writers' pool `sql`, the rest on `maintenanceSql`;
 * a process that is not the primary starts only the raw eviction. Returns a
 * function that stops them.
 */
export function startRecordJobs(
  sql: postgres.Sql,
  maintenanceSql: postgres.Sql,
  opts: RecordJobsOptions,
): () => void {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const historyDays = historyDaysFromEnv(env);
  const jobs: Cron[] = [];

  const { dir } = rawArchiveOptionsFromEnv(env);
  const evict = singleFlight("raw eviction", async () => {
    const result = await evictRawPayloads(maintenanceSql, {
      dir,
      policy: evictionPolicyFromEnv(now(), env),
      historyDays,
      ...(opts.scope ? { scope: opts.scope } : {}),
    });
    if (result.evict.length + result.purged > 0) {
      console.info(
        `[records] raw eviction: ${result.evict.length} evicted, ${result.purged} purged (rung ${result.rung})`,
      );
    }
  });
  jobs.push(new Cron(RAW_EVICTION_CRON, { catch: true }, evict));
  const stop = () => {
    for (const job of jobs) job.stop();
  };
  if (opts.primary === false) return stop;

  const rollupDays = rollupRetentionDaysFromEnv(env);
  const partitions = singleFlight("partitions", () =>
    maintainPartitionsHourly(maintenanceSql, opts.registry, now()),
  );
  jobs.push(new Cron(PARTITION_CRON, { catch: true }, partitions));

  for (const [period, cron] of [
    ["hourly", HOURLY_ROLLUP_CRON],
    ["daily", DAILY_ROLLUP_CRON],
  ] as const) {
    const rollup = singleFlight(`${period} rollup`, async () => {
      const at = now();
      const { rows } = await rollupObservations(maintenanceSql, {
        registry: opts.registry,
        period,
        now: at,
      });
      if (rows > 0) console.info(`[records] ${period} rollup wrote ${rows} row(s)`);
      if (period === "daily") {
        await pruneRollups(maintenanceSql, {
          now: at,
          hourlyDays: rollupDays.hourly,
          dailyDays: rollupDays.daily,
        });
      }
    });
    jobs.push(new Cron(cron, { catch: true }, rollup));
  }

  const orphanAges = orphanMaxAges(opts.feeds ?? []);
  const sweep = singleFlight("sweep", async () => {
    const counts = await sweepRecords(maintenanceSql, {
      registry: opts.registry,
      instanceId: opts.instanceId,
      now: now().toISOString(),
      maxAgeSec: ORPHAN_MAX_AGE_SEC,
      sourceMaxAgeSec: orphanAges,
      historyDays,
    });
    if (Object.values(counts).some((n) => n > 0)) {
      console.info(`[records] sweep ${JSON.stringify(counts)}`);
    }
  });
  jobs.push(new Cron(RECORD_SWEEP_CRON, { catch: true }, sweep));

  const flips = windowedRuns(
    (window) =>
      refreshFlippedFusions(sql, opts.registry, { ...window, instanceId: opts.instanceId }),
    now,
  );
  const fusionFlips = singleFlight("fusion freshness", async () => {
    const flipped = await flips();
    if (flipped > 0) console.info(`[records] refreshed the fusions of ${flipped} source(s)`);
  });
  jobs.push(new Cron(FUSION_FLIP_CRON, { catch: true }, fusionFlips));

  return stop;
}
