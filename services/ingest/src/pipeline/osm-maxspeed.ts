import { parseMaxspeedKph } from "@openconditions/roads";
import type postgres from "postgres";

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
 * Day-one free-flow proxy: for a bounded batch of measurement sites with speed
 * history in the last 7 days that have NO baseline of any method, query
 * Overpass for the nearest highway way's maxspeed at the site and upsert it as
 * a per-site overall osm_maxspeed baseline. Bounded (batchCap), egress-guarded (caller's
 * fetch), rate-limited by the batch cap, and tolerant of Overpass errors — it
 * never throws. Runs after deriveBaselines so native/derived always win.
 */
export async function resolveOsmMaxspeed(
  sql: Sql,
  deps: OsmMaxspeedDeps,
): Promise<{ updated: number }> {
  if (!osmFallbackEnabled()) return { updated: 0 };

  let targets: { subject_key: string; source: string; lon: number; lat: number }[];
  try {
    // Sites with a rolled-up speed hour in the last week: raw history keeps
    // only a few days, so a 7-day lookback over it would quietly shrink to
    // that. A line site is located on the line.
    targets = await sql`
      SELECT DISTINCT ON (l.subject_key)
        l.subject_key, l.source_id AS source,
        ST_X(ST_PointOnSurface(l.geom)) AS lon, ST_Y(ST_PointOnSurface(l.geom)) AS lat
      FROM conditions.observation_rollup_hourly h
      JOIN conditions.observation_latest l ON l.series_id = h.series_id
      LEFT JOIN conditions.sensor_baseline b ON b.subject_key = l.subject_key
      WHERE l.property = 'traffic.speed' AND l.component_key IS NULL AND l.geom IS NOT NULL
        AND h.hour_utc >= now() - make_interval(days => 7) AND b.subject_key IS NULL
      ORDER BY l.subject_key, h.hour_utc DESC
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
          (subject_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
        VALUES (${t.subject_key}, ${t.source}, -1, -1, ${kph}, 'osm_maxspeed', 0, ${deps.now()})
        ON CONFLICT (subject_key, dow_bucket, tod_bucket, method)
        DO UPDATE SET free_flow_kph = EXCLUDED.free_flow_kph, computed_at = EXCLUDED.computed_at`;
      updated += 1;
    } catch (err) {
      console.warn(`[ingest] osm-maxspeed: site ${t.subject_key} failed:`, err);
    }
  }
  return { updated };
}
