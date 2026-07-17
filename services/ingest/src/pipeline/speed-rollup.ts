/**
 * Rolls `conditions.sensor_speed_sample` up into per-(sensor, UTC hour)
 * histograms in `conditions.sensor_speed_hourly`, so the weeks of speed history
 * the baseline and segment-profile derivations read cost ~5 GB instead of the
 * ~210 GB that retaining raw samples for the same window would.
 *
 * WHY A HISTOGRAM AND NOT A SUMMARY: every consumer wants a PERCENTILE over a
 * window spanning many hours (free-flow p85 across 28 days, typical-speed p50
 * across 35), and percentiles do not decompose — the p85 of 28 days cannot be
 * recovered from 28 hourly p85s, nor from a mean and a standard deviation
 * (speeds are bimodal: free-flow vs congested). A histogram DOES decompose:
 * counts add per bin, so a window is merged by summing and the percentile is
 * read off the cumulative distribution. The cost is quantisation — the answer
 * lands within one bin ({@link SPEED_BIN_WIDTH_KPH} kph) of the exact
 * `percentile_cont`, which is far below the noise in a free-flow estimate.
 */
import type postgres from "postgres";

type Sql = postgres.Sql;

/**
 * Histogram bin width. Bin b covers [b*2, b*2+2) kph, so a percentile read off
 * a merged histogram is within 2 kph of the exact value (~1.7% at motorway
 * free-flow). Halving it would double the row size for precision far finer than
 * the estimate itself is meaningful to.
 */
export const SPEED_BIN_WIDTH_KPH = 2;

/**
 * Bins 0..127 cover [0, 256) kph. Observed speeds top out at ~250 (the fastest
 * feeds cap there); anything at or beyond 256 — or negative — is clamped into
 * the end bins rather than dropped, so a bad reading skews an estimate slightly
 * instead of silently vanishing from the sample count.
 */
export const SPEED_BIN_COUNT = 128;

/**
 * How long RAW samples are kept. They are only a landing buffer for the rollup
 * plus a re-roll window for late-arriving data — the durable history is the
 * rollup. At ~20M rows/day each retained day costs ~6 GB, so this stays small.
 */
export const RAW_SAMPLE_RETENTION_DAYS = 3;

/**
 * How long the hourly rollup is kept. This — not the raw retention — is what
 * bounds every consumer's window, so it MUST be >= the longest of them
 * (see BASELINE_WINDOW_DAYS / SEGMENT_PROFILE_WINDOW_DAYS).
 */
export const HOURLY_RETENTION_DAYS = 35;

/**
 * Hours re-rolled on every run, counted back from the rollup watermark. A
 * sample can land slightly after its own hour closed (a feed publishing late),
 * and the upsert is idempotent, so re-rolling a short trailing window absorbs
 * that instead of losing it. Must stay well below RAW_SAMPLE_RETENTION_DAYS —
 * the raw rows it re-reads have to still exist.
 */
export const ROLLUP_LOOKBACK_HOURS = 6;

/** Hours aggregated per statement. Bounds the backfill's memory and lock time. */
export const ROLLUP_BATCH_HOURS = 24;

/**
 * Reads the `frac` percentile off a MERGED histogram, as an expression over the
 * `bin`/`cum_c`/`total` columns a caller's cumulative CTE exposes. Callers merge
 * their own window (the grouping keys and joins differ per derivation); this
 * owns the one thing they must agree on — how a bin becomes a speed.
 *
 * The percentile bin is the first whose cumulative count reaches `frac` of the
 * total; its MIDPOINT is the least-biased speed for a value known only to lie
 * within the bin. Lands within one bin of the exact `percentile_cont`.
 */
export function histogramPercentileKph(sql: Sql, frac: number) {
  return sql`(min(bin) FILTER (WHERE cum_c >= ${frac} * total))::double precision
             * ${SPEED_BIN_WIDTH_KPH} + ${SPEED_BIN_WIDTH_KPH / 2}`;
}

/** The bin a speed falls in, clamped into range. Mirrors the SQL in `rollupSpeedSamples`. */
export function binForSpeed(kph: number): number {
  const bin = Math.floor(kph / SPEED_BIN_WIDTH_KPH);
  if (!Number.isFinite(bin) || bin < 0) return 0;
  return Math.min(SPEED_BIN_COUNT - 1, bin);
}

/**
 * The speed a bin represents: its MIDPOINT, which is the least-biased estimate
 * for a value known only to lie within the bin.
 */
export function kphForBin(bin: number): number {
  return bin * SPEED_BIN_WIDTH_KPH + SPEED_BIN_WIDTH_KPH / 2;
}

export interface RollupResult {
  /** Hours of raw data aggregated. */
  hours: number;
  /** Rollup rows written (inserted or refreshed). */
  rows: number;
}

interface RollupOpts {
  lookbackHours?: number;
  batchHours?: number;
  /** Injected clock (tests). */
  now?: () => Date;
}

/**
 * Aggregate every COMPLETED hour that the rollup has not caught up with yet.
 *
 * The range starts at the rollup's watermark minus {@link ROLLUP_LOOKBACK_HOURS}
 * (re-rolling a short trailing window so late samples are not lost), or at the
 * oldest raw row when the rollup is empty — which is what makes the first run
 * after deploy a full backfill with no separate migration step. It ends at the
 * current hour, EXCLUSIVE: the in-progress hour is still receiving samples and
 * would be rolled up incomplete.
 *
 * Idempotent: re-running over the same range recomputes identical rows and
 * upserts them. Batched by {@link ROLLUP_BATCH_HOURS} so a long backfill never
 * builds one huge statement.
 */
export async function rollupSpeedSamples(sql: Sql, opts: RollupOpts = {}): Promise<RollupResult> {
  const lookbackHours = opts.lookbackHours ?? ROLLUP_LOOKBACK_HOURS;
  const batchHours = opts.batchHours ?? ROLLUP_BATCH_HOURS;
  const now = opts.now?.() ?? new Date();

  const [bounds] = await sql<{ watermark: Date | null; oldest_raw: Date | null }[]>`
    SELECT (SELECT max(hour_utc) FROM conditions.sensor_speed_hourly) AS watermark,
           (SELECT min(observed_at) FROM conditions.sensor_speed_sample) AS oldest_raw`;
  if (bounds?.oldest_raw == null) {
    return { hours: 0, rows: 0 };
  }

  const end = floorToHour(now);
  const start =
    bounds.watermark === null
      ? floorToHour(new Date(bounds.oldest_raw))
      : new Date(floorToHour(new Date(bounds.watermark)).getTime() - lookbackHours * 3_600_000);
  if (start >= end) {
    return { hours: 0, rows: 0 };
  }

  let rows = 0;
  let hours = 0;
  for (let from = start; from < end; ) {
    const to = new Date(Math.min(from.getTime() + batchHours * 3_600_000, end.getTime()));
    rows += await rollupRange(sql, from, to);
    hours += Math.round((to.getTime() - from.getTime()) / 3_600_000);
    from = to;
  }
  return { hours, rows };
}

/**
 * One batch: raw rows in [from, to) collapsed to one row per (sensor, hour).
 *
 * The inner aggregation counts per (sensor, hour, bin) and the outer folds those
 * into the two parallel arrays, bin-ascending — the ordering every reader relies
 * on to walk the distribution. Only non-empty bins are stored: a sensor-hour
 * holds ~25 samples across ~9 distinct bins, so a sparse pair of ~9-element
 * arrays beats a 128-slot dense one on both size and merge cost.
 *
 * `source`/`geom` are constant per sensor, so any sample's value will do.
 */
async function rollupRange(sql: Sql, from: Date, to: Date): Promise<number> {
  const result = await sql`
    INSERT INTO conditions.sensor_speed_hourly
      (sensor_key, hour_utc, source, geom, sample_count, speed_bins, speed_counts)
    SELECT b.sensor_key, b.hour_utc, min(b.source), (array_agg(b.geom))[1],
           sum(b.c)::int,
           array_agg(b.bin ORDER BY b.bin), array_agg(b.c ORDER BY b.bin)
    FROM (
      SELECT sensor_key,
             date_trunc('hour', observed_at) AS hour_utc,
             LEAST(${SPEED_BIN_COUNT - 1},
                   GREATEST(0, floor(speed_kph / ${SPEED_BIN_WIDTH_KPH})))::smallint AS bin,
             count(*)::int AS c,
             min(source) AS source,
             (array_agg(geom))[1] AS geom
      FROM conditions.sensor_speed_sample
      WHERE observed_at >= ${from} AND observed_at < ${to}
      GROUP BY 1, 2, 3
    ) b
    GROUP BY b.sensor_key, b.hour_utc
    ON CONFLICT (sensor_key, hour_utc) DO UPDATE SET
      source = EXCLUDED.source,
      geom = EXCLUDED.geom,
      sample_count = EXCLUDED.sample_count,
      speed_bins = EXCLUDED.speed_bins,
      speed_counts = EXCLUDED.speed_counts`;
  return result.count;
}

function floorToHour(d: Date): Date {
  const copy = new Date(d.getTime());
  copy.setUTCMinutes(0, 0, 0);
  return copy;
}

/**
 * Retention prune of the hourly rollup. This is the history every consumer
 * reads, so the window must cover the longest of them.
 */
export async function pruneHourlyRollup(
  sql: Sql,
  opts: { retentionDays?: number } = {}
): Promise<{ deleted: number }> {
  const retentionDays = opts.retentionDays ?? HOURLY_RETENTION_DAYS;
  const result = await sql`
    DELETE FROM conditions.sensor_speed_hourly
    WHERE hour_utc < now() - make_interval(days => ${retentionDays})`;
  return { deleted: result.count };
}

/** Rows deleted per prune statement — see {@link pruneRawSamples}. */
export const RAW_PRUNE_BATCH_SIZE = 50_000;

/**
 * Retention prune of the RAW samples, now that the rollup — not this table —
 * carries the history. Deletes rows past {@link RAW_SAMPLE_RETENTION_DAYS} that
 * the rollup has already absorbed.
 *
 * FAIL-SAFE: a row is deleted only when the rollup actually holds ITS OWN
 * (sensor, hour). Comparing against the rollup's watermark would NOT be enough:
 * the rollup only ever moves forward from that watermark, so samples stamped
 * further back than it (a feed republishing history) would sit before the
 * watermark having never been aggregated — precisely the rows a watermark check
 * would delete. Requiring the bucket to exist means un-aggregated samples pile
 * up, costing disk and visibly, instead of disappearing. Disk is recoverable;
 * they are not.
 *
 * Deletes in bounded chunks: the table takes ~20M rows/day, so a single
 * unbounded statement would hold one transaction open across an enormous delete
 * after any gap in the schedule.
 */
export async function pruneRawSamples(
  sql: Sql,
  opts: { retentionDays?: number; batchSize?: number } = {}
): Promise<{ deleted: number }> {
  const retentionDays = opts.retentionDays ?? RAW_SAMPLE_RETENTION_DAYS;
  const batchSize = opts.batchSize ?? RAW_PRUNE_BATCH_SIZE;

  let deleted = 0;
  for (;;) {
    const result = await sql`
      DELETE FROM conditions.sensor_speed_sample
      WHERE id IN (
        SELECT s.id FROM conditions.sensor_speed_sample s
        WHERE s.observed_at < now() - make_interval(days => ${retentionDays})
          AND EXISTS (
            SELECT 1 FROM conditions.sensor_speed_hourly h
            WHERE h.sensor_key = s.sensor_key
              AND h.hour_utc = date_trunc('hour', s.observed_at)
          )
        LIMIT ${batchSize}
      )`;
    deleted += result.count;
    if (result.count < batchSize) {
      return { deleted };
    }
  }
}
