import type postgres from "postgres";
import { parseMaxspeedKph } from "@openconditions/roads";

type Sql = postgres.Sql;

export interface OsmMaxspeedDeps {
  fetch: typeof fetch;
  now: () => string;
  /** Hard cap on Overpass queries per run. */
  batchCap: number;
}

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

/** True unless explicitly disabled; empty/unset = on (the default). */
export function osmFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["OPENCONDITIONS_OSM_MAXSPEED_FALLBACK"] !== "false";
}

interface OverpassElement {
  tags?: { maxspeed?: unknown };
}

/**
 * Day-one free-flow proxy: for a bounded batch of sensors seen in the last 7
 * days that have NO baseline of any method, query Overpass for the nearest
 * highway way's maxspeed at the sensor point and upsert it as a per-sensor
 * overall osm_maxspeed baseline. Bounded (batchCap), egress-guarded (caller's
 * fetch), rate-limited by the batch cap, and tolerant of Overpass errors — it
 * never throws. Runs after deriveBaselines so native/derived always win.
 */
export async function resolveOsmMaxspeed(
  sql: Sql,
  deps: OsmMaxspeedDeps
): Promise<{ updated: number }> {
  if (!osmFallbackEnabled()) return { updated: 0 };

  let targets: { sensor_key: string; source: string; lon: number; lat: number }[];
  try {
    // Reads the hourly rollup, not the raw samples: raw is only a few days of
    // rollup buffer now, so a 7-day lookback over it would quietly shrink to
    // that. The rollup carries each sensor's source/geom for exactly this.
    targets = await sql`
      SELECT DISTINCT ON (h.sensor_key)
        h.sensor_key, h.source, ST_X(h.geom) AS lon, ST_Y(h.geom) AS lat
      FROM conditions.sensor_speed_hourly h
      LEFT JOIN conditions.sensor_baseline b ON b.sensor_key = h.sensor_key
      WHERE h.hour_utc >= now() - make_interval(days => 7) AND b.sensor_key IS NULL
      ORDER BY h.sensor_key, h.hour_utc DESC
      LIMIT ${deps.batchCap}`;
  } catch (err) {
    console.warn("[ingest] osm-maxspeed: target query failed:", err);
    return { updated: 0 };
  }

  let updated = 0;
  for (const t of targets) {
    try {
      const query = `[out:json][timeout:25];way(around:30,${t.lat},${t.lon})[highway][maxspeed];out tags 1;`;
      const res = await deps.fetch(OVERPASS_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: query,
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { elements?: OverpassElement[] };
      const raw = body.elements?.[0]?.tags?.maxspeed;
      const kph = typeof raw === "string" ? parseMaxspeedKph(raw) : null;
      if (kph == null) continue;
      await sql`
        INSERT INTO conditions.sensor_baseline
          (sensor_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
        VALUES (${t.sensor_key}, ${t.source}, -1, -1, ${kph}, 'osm_maxspeed', 0, ${deps.now()})
        ON CONFLICT (sensor_key, dow_bucket, tod_bucket, method)
        DO UPDATE SET free_flow_kph = EXCLUDED.free_flow_kph, computed_at = EXCLUDED.computed_at`;
      updated += 1;
    } catch (err) {
      console.warn(`[ingest] osm-maxspeed: sensor ${t.sensor_key} failed:`, err);
    }
  }
  return { updated };
}
