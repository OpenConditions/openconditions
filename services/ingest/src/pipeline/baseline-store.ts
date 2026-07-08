import type postgres from "postgres";
import { toIsoTimestamp, type Observation } from "@openconditions/core";
import {
  ABSURD_SPEED_KPH,
  representativePoint,
  type BaselineMethod,
  type RoadFlow,
} from "@openconditions/roads";

type Sql = postgres.Sql;

// Rows per bulk INSERT — mirrors the chunking in write-postgis.ts so a large
// flow feed stays a handful of round-trips instead of one per row.
const CHUNK_SIZE = 1000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isSpeedFlow(obs: Observation): obs is RoadFlow & { speedKph: number } {
  return (
    obs.kind === "measurement" &&
    (obs as RoadFlow).metric === "flow" &&
    typeof (obs as RoadFlow).speedKph === "number"
  );
}

/**
 * Appends one sensor_speed_sample row per flow observation carrying a
 * plausible speed. dow/tod are derived from observed_at in UTC (TODO:
 * local-tz bucketing is a future refinement). Bulk-inserted via
 * jsonb_to_recordset, one statement per chunk. Idempotent per measurement
 * instant: ON CONFLICT (sensor_key, observed_at) DO NOTHING drops duplicate
 * samples from feeds that update slower than the poll cadence, so
 * percentile_cont is not biased by repeated identical rows. observed_at is
 * quantized (floored) to the feed's cadence bucket first: this bounds the
 * degenerate case where a source omits a timestamp and every poll falls back
 * to a fresh now() (which would otherwise write a distinct row per poll and
 * bias the percentile) to one sample per sensor per cadence bucket. Well-formed
 * feeds with stable timestamps are unaffected — their instants already collide
 * across polls, so flooring them changes nothing.
 *
 * Defense-in-depth: only a speed with `0 < speedKph < ABSURD_SPEED_KPH` is
 * persisted here, even though the parsers already reject no-data zeros and
 * absurd readings before a flow is built. A genuine standstill (speedKph === 0)
 * is intentionally excluded from this history — flow.ts's own LOS
 * classification (done earlier, before this write) is unaffected by this
 * filter, so a real standstill still surfaces as a congestion event; it simply
 * must not drag the derived p85 free-flow baseline down towards 0.
 *
 * Append-only: never deletes, independent of atomicSwap. Returns the number of
 * plausible-speed rows considered for insertion.
 */
export async function writeSpeedSamples(
  sql: Sql,
  source: string,
  observations: Observation[],
  now: () => string,
  cadenceSec: number
): Promise<number> {
  const nowIso = now();
  const bucketMs = Math.max(1, cadenceSec) * 1000;
  const rows = observations
    .filter(isSpeedFlow)
    .filter((f) => f.speedKph > 0 && f.speedKph < ABSURD_SPEED_KPH)
    .map((f) => {
      const raw = toIsoTimestamp(f.dataUpdatedAt) ?? toIsoTimestamp(f.fetchedAt) ?? nowIso;
      // Floor to the cadence bucket so a now()-fallback timestamp cannot write a
      // fresh row every poll; stable-timestamp feeds already collide here.
      const observedAt = new Date(
        Math.floor(new Date(raw).getTime() / bucketMs) * bucketMs
      ).toISOString();
      const d = new Date(observedAt);
      const [lon, lat] = representativePoint(f.geometry);
      return {
        sensor_key: f.id,
        source,
        observed_at: observedAt,
        speed_kph: f.speedKph,
        dow: d.getUTCDay(),
        tod_hour: d.getUTCHours(),
        geometry_json: JSON.stringify({ type: "Point", coordinates: [lon, lat] }),
      };
    });
  if (rows.length === 0) return 0;

  for (const batch of chunk(rows, CHUNK_SIZE)) {
    await sql`
      INSERT INTO conditions.sensor_speed_sample
        (sensor_key, source, observed_at, speed_kph, dow, tod_hour, geom)
      SELECT sensor_key, source, observed_at, speed_kph, dow, tod_hour,
        ST_SetSRID(ST_GeomFromGeoJSON(geometry_json), 4326)
      FROM jsonb_to_recordset(${sql.json(batch)}::jsonb) AS t(
        sensor_key text, source text, observed_at timestamptz, speed_kph double precision,
        dow smallint, tod_hour smallint, geometry_json text
      )
      ON CONFLICT (sensor_key, observed_at) DO NOTHING`;
  }
  return rows.length;
}

/**
 * Returns the per-sensor free-flow baseline (kph + method provenance),
 * resolved from the OVERALL (dow_bucket = -1, tod_bucket = -1) row only,
 * preferring method native > derived > osm_maxspeed. The method is threaded so
 * enrichment can stamp freeFlowSource. A plain Map so packages/roads stays
 * DB-free.
 *
 * The per-(dow,tod)-bucket rows deriveBaselines also writes are intentionally
 * NOT read here: they are a rolling *typical speed for that hour* (kept for a
 * future typical-speed feature — see plan 12 segment_profile), which is not
 * the same thing as a *free-flow* denominator. Using a congested rush-hour
 * bucket's own p85 as the free-flow baseline would make recurring rush-hour
 * congestion measure against itself and misclassify as free_flow exactly when
 * a traffic layer should show congestion — this is the P0.3 fix; do not
 * reintroduce a specific-bucket preference here.
 */
export async function loadBaselineMap(
  sql: Sql,
  source: string
): Promise<Map<string, { kph: number; method: BaselineMethod }>> {
  const rows = await sql<{ sensor_key: string; free_flow_kph: number; method: BaselineMethod }[]>`
    SELECT DISTINCT ON (sensor_key) sensor_key, free_flow_kph, method
    FROM conditions.sensor_baseline
    WHERE source = ${source} AND dow_bucket = -1 AND tod_bucket = -1
    ORDER BY sensor_key, (CASE method WHEN 'native' THEN 0 WHEN 'derived' THEN 1 ELSE 2 END)`;

  return new Map(rows.map((r) => [r.sensor_key, { kph: r.free_flow_kph, method: r.method }]));
}
