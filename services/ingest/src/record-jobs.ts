import type { Registry } from "@openconditions/model";
import {
  dropExpiredObservationPartitions,
  ensureObservationPartitions,
  pruneRollups,
  retentionClasses,
  rollupObservations,
  rollupRetentionDaysFromEnv,
  sweepRecords,
} from "@openconditions/storage";
import { Cron } from "croner";
import type postgres from "postgres";
import { rawArchiveOptionsFromEnv } from "./raw/archive.js";
import { evictionPolicyFromEnv, evictRawPayloads } from "./raw/evict.js";

/** How often expired and orphaned records are tombstoned and old tombstones purged. */
const RECORD_SWEEP_CRON = "*/5 * * * *";
/** History partitions are created ahead and dropped behind every hour. */
const PARTITION_CRON = "5 * * * *";
/** Hourly rollups run after the partition job; the daily ones once the night's lateness has passed. */
const HOURLY_ROLLUP_CRON = "15 * * * *";
const DAILY_ROLLUP_CRON = "45 6 * * *";
/** Raw payloads are evicted by their tiers and the cap every 15 minutes. */
const RAW_EVICTION_CRON = "*/15 * * * *";
/** A feed record outlives its source's last success by this much (as the legacy sweep). */
const ORPHAN_MAX_AGE_SEC = 3600;

export interface RecordJobsOptions {
  registry: Registry;
  instanceId: string;
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
  const dropped = await dropExpiredObservationPartitions(sql, { now });
  return { created, dropped };
}

/**
 * Starts the scheduled jobs that keep the record tables in shape. Returns a
 * function that stops them.
 */
export function startRecordJobs(sql: postgres.Sql, opts: RecordJobsOptions): () => void {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const historyDays = historyDaysFromEnv(env);
  const rollupDays = rollupRetentionDaysFromEnv(env);
  const jobs: Cron[] = [];

  const partitions = singleFlight("partitions", async () => {
    const { created, dropped } = await maintainPartitions(sql, opts.registry, now());
    if (created.length + dropped.length > 0) {
      console.info(`[records] partitions +${created.length} -${dropped.length}`);
    }
  });
  jobs.push(new Cron(PARTITION_CRON, { catch: true }, partitions));

  for (const [period, cron] of [
    ["hourly", HOURLY_ROLLUP_CRON],
    ["daily", DAILY_ROLLUP_CRON],
  ] as const) {
    const rollup = singleFlight(`${period} rollup`, async () => {
      const at = now();
      const { rows } = await rollupObservations(sql, { registry: opts.registry, period, now: at });
      if (rows > 0) console.info(`[records] ${period} rollup wrote ${rows} row(s)`);
      if (period === "daily") {
        await pruneRollups(sql, {
          now: at,
          hourlyDays: rollupDays.hourly,
          dailyDays: rollupDays.daily,
        });
      }
    });
    jobs.push(new Cron(cron, { catch: true }, rollup));
  }

  const sweep = singleFlight("sweep", async () => {
    const counts = await sweepRecords(sql, {
      registry: opts.registry,
      instanceId: opts.instanceId,
      now: now().toISOString(),
      maxAgeSec: ORPHAN_MAX_AGE_SEC,
      historyDays,
    });
    if (Object.values(counts).some((n) => n > 0)) {
      console.info(`[records] sweep ${JSON.stringify(counts)}`);
    }
  });
  jobs.push(new Cron(RECORD_SWEEP_CRON, { catch: true }, sweep));

  const { dir } = rawArchiveOptionsFromEnv(env);
  const evict = singleFlight("raw eviction", async () => {
    const result = await evictRawPayloads(sql, {
      dir,
      policy: evictionPolicyFromEnv(now(), env),
      historyDays,
    });
    if (result.evict.length + result.purged > 0) {
      console.info(
        `[records] raw eviction: ${result.evict.length} evicted, ${result.purged} purged (rung ${result.rung})`,
      );
    }
  });
  jobs.push(new Cron(RAW_EVICTION_CRON, { catch: true }, evict));

  return () => {
    for (const job of jobs) job.stop();
  };
}
