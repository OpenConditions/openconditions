import type { Registry } from "@openconditions/model";
import type postgres from "postgres";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A reading may arrive this late and still count in its hour's (or day's) rollup. */
export const ROLLUP_LATENESS_HOURS = 6;
/** Hours aggregated per statement, bounding a catch-up's memory and lock time. */
const BATCH_HOURS = 24;

export type RollupPeriod = "hourly" | "daily";

export interface RollupResult {
  /** The period the run aggregated up to (exclusive), or undefined when there was nothing to do. */
  through?: string;
  /** Rollup rows written. */
  rows: number;
}

/** The properties a period rolls up, and the histogram bin width of those that keep one. */
function rolledUp(registry: Registry, period: RollupPeriod) {
  return registry
    .properties()
    .filter((p) => p.retention?.rollup?.period === period)
    .map((p) => {
      const rollup = p.retention!.rollup!;
      return {
        property: p.code,
        bin_width: "histogram" in rollup ? rollup.histogram.binWidth : null,
      };
    });
}

const floorTo = (t: number, step: number) => Math.floor(t / step) * step;

/**
 * The bin width of the `traffic.speed` histogram: bin b covers [2b, 2b+2)
 * km/h, so a percentile read off a merged histogram lands within 2 km/h of
 * the exact value (~1.7% at motorway free flow). Stored rollups hold bin
 * indexes, so it changes only with the property's registry entry.
 */
export const SPEED_BIN_WIDTH_KPH = 2;

/**
 * Reads the `frac` percentile off a merged speed histogram, as an expression
 * over the `bin`/`cum_c`/`total` columns a caller's cumulative CTE exposes:
 * the first bin whose cumulative count reaches `frac` of the total, at its
 * midpoint (the least biased speed for a value known only to lie in the bin).
 * Percentiles over many hours do not decompose; histograms do, which is why
 * the rollup keeps them.
 */
export function histogramPercentileKph(sql: postgres.Sql, frac: number) {
  return sql`(min(bin) FILTER (WHERE cum_c >= ${frac} * total))::double precision
             * ${SPEED_BIN_WIDTH_KPH} + ${SPEED_BIN_WIDTH_KPH / 2}`;
}

/**
 * Aggregates finished periods of history into rollups: count, minimum,
 * maximum and mean of each series per hour or day, and for a property that
 * declares one a histogram (sparse bins of the declared width, bin-ascending,
 * clamped at zero) — percentiles over many hours do not decompose, histograms
 * do. A period is finished once it ended `ROLLUP_LATENESS_HOURS` ago; the
 * run walks from where the last one stopped (`observation_rollup_progress`),
 * or from the oldest reading still held, and records how far it got. Money
 * readings roll up by amount.
 */
export async function rollupObservations(
  sql: postgres.Sql,
  opts: { registry: Registry; period: RollupPeriod; now: Date },
): Promise<RollupResult> {
  const properties = rolledUp(opts.registry, opts.period);
  const step = opts.period === "hourly" ? HOUR_MS : DAY_MS;
  const cutoff = floorTo(opts.now.getTime() - ROLLUP_LATENESS_HOURS * HOUR_MS, step);
  if (properties.length === 0) return { rows: 0 };
  const [progress] = await sql<{ finalized_before: Date }[]>`
    SELECT finalized_before FROM conditions.observation_rollup_progress
     WHERE period = ${opts.period}`;
  // Only the first run looks for the oldest reading: later ones start at the
  // frontier, and the block range index on time cannot answer a minimum
  // without reading every partition's summary and its blocks.
  const [first] =
    progress === undefined
      ? await sql<{ oldest: Date | null }[]>`
          SELECT min(phenomenon_start) AS oldest FROM conditions.observation`
      : [];
  const startAt = progress?.finalized_before ?? first?.oldest;
  if (startAt == null) return { rows: 0 };
  let from = floorTo(new Date(startAt).getTime(), step);
  if (from >= cutoff) return { rows: 0 };

  const table = opts.period === "hourly" ? "observation_rollup_hourly" : "observation_rollup_daily";
  const bucket =
    opts.period === "hourly"
      ? "date_trunc('hour', o.phenomenon_start, 'UTC')"
      : "(o.phenomenon_start AT TIME ZONE 'UTC')::date";
  const column = opts.period === "hourly" ? "hour_utc" : "day_utc";
  const histogram = opts.period === "hourly";
  let rows = 0;
  while (from < cutoff) {
    const to = Math.min(from + Math.max(BATCH_HOURS * HOUR_MS, step), cutoff);
    rows += await sql.begin(async (tx) => {
      const result = await tx.unsafe(
        `INSERT INTO conditions.${table} (series_id, ${column}, sample_count,
           ${histogram ? "bins, counts, " : ""}min, max, mean)
         SELECT b.series_id, b.bucket, sum(b.c)::int,
           ${
             histogram
               ? `array_agg(b.bin ORDER BY b.bin) FILTER (WHERE b.bin IS NOT NULL),
                  array_agg(b.c ORDER BY b.bin) FILTER (WHERE b.bin IS NOT NULL),`
               : ""
}
           min(b.mn), max(b.mx), sum(b.s) / sum(b.c)
         FROM (
           SELECT o.series_id, ${bucket} AS bucket,
             CASE WHEN w.bin_width IS NULL THEN NULL
                  ELSE LEAST(32767, GREATEST(0, floor(x.v / w.bin_width)))::smallint END AS bin,
             count(*) AS c, min(x.v) AS mn, max(x.v) AS mx, sum(x.v) AS s
           FROM conditions.observation o
           JOIN conditions.observation_latest l ON l.series_id = o.series_id
           JOIN jsonb_to_recordset($1::text::jsonb) AS w(property text, bin_width double precision)
             ON w.property = l.property
           CROSS JOIN LATERAL (
             SELECT COALESCE(o.value_num, o.value_money::double precision) AS v) x
           WHERE o.phenomenon_start >= $2 AND o.phenomenon_start < $3 AND x.v IS NOT NULL
           GROUP BY 1, 2, 3
         ) b
         GROUP BY b.series_id, b.bucket
         ON CONFLICT (series_id, ${column}) DO UPDATE SET
           sample_count = excluded.sample_count,
           ${histogram ? "bins = excluded.bins, counts = excluded.counts," : ""}
           min = excluded.min, max = excluded.max, mean = excluded.mean`,
        [JSON.stringify(properties), new Date(from).toISOString(), new Date(to).toISOString()],
      );
      await tx`
        INSERT INTO conditions.observation_rollup_progress (period, finalized_before)
        VALUES (${opts.period}, ${new Date(to).toISOString()})
        ON CONFLICT (period) DO UPDATE SET finalized_before = GREATEST(
          observation_rollup_progress.finalized_before, excluded.finalized_before)`;
      return result.count;
    });
    from = to;
  }
  return { through: new Date(cutoff).toISOString(), rows };
}

/** How long rollups are kept: hourly 35 days (the longest window a derivation reads), daily 400. */
export function rollupRetentionDaysFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const read = (key: string, fallback: number) => {
    const raw = env[key];
    const days = raw == null || raw === "" ? Number.NaN : Number(raw);
    return Number.isInteger(days) && days > 0 ? days : fallback;
  };
  return {
    hourly: read("OPENCONDITIONS_ROLLUP_HOURLY_DAYS", 35),
    daily: read("OPENCONDITIONS_ROLLUP_DAILY_DAYS", 400),
  };
}

/** Deletes rollups older than their retention. */
export async function pruneRollups(
  sql: postgres.Sql,
  opts: { now: Date; hourlyDays: number; dailyDays: number },
): Promise<{ hourly: number; daily: number }> {
  const hourly = await sql`
    DELETE FROM conditions.observation_rollup_hourly
     WHERE hour_utc < ${new Date(opts.now.getTime() - opts.hourlyDays * DAY_MS)}`;
  const daily = await sql`
    DELETE FROM conditions.observation_rollup_daily
     WHERE day_utc < ${new Date(opts.now.getTime() - opts.dailyDays * DAY_MS)}::date`;
  return { hourly: hourly.count, daily: daily.count };
}
