import type postgres from "postgres";
import { toIsoTimestamp, type Observation } from "@openconditions/core";
import { representativePoint, type RoadFlow } from "@openconditions/roads";

type Sql = postgres.Sql;

// Rows per bulk INSERT — mirrors the chunking in write-postgis.ts so a large
// flow feed stays a handful of round-trips instead of one per row.
const CHUNK_SIZE = 1000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isSpeedFlow(obs: Observation): obs is RoadFlow {
  return (
    obs.kind === "measurement" &&
    (obs as RoadFlow).metric === "flow" &&
    typeof (obs as RoadFlow).speedKph === "number"
  );
}

/**
 * Appends one sensor_speed_sample row per flow observation carrying a speed.
 * dow/tod are derived from observed_at in UTC (TODO: local-tz bucketing is a
 * future refinement). Bulk-inserted via jsonb_to_recordset, one statement per
 * chunk. Idempotent per measurement instant: ON CONFLICT (sensor_key,
 * observed_at) DO NOTHING drops duplicate samples from feeds that update slower
 * than the poll cadence, so percentile_cont is not biased by repeated identical
 * rows. observed_at is quantized (floored) to the feed's cadence bucket first:
 * this bounds the degenerate case where a source omits a timestamp and every
 * poll falls back to a fresh now() (which would otherwise write a distinct row
 * per poll and bias the percentile) to one sample per sensor per cadence bucket.
 * Well-formed feeds with stable timestamps are unaffected — their instants
 * already collide across polls, so flooring them changes nothing. Append-only:
 * never deletes, independent of atomicSwap. Returns the number of candidate
 * rows considered.
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
  const rows = observations.filter(isSpeedFlow).map((f) => {
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
      speed_kph: f.speedKph as number,
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
