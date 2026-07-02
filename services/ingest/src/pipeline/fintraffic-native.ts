import type postgres from "postgres";
import type { FeedSource } from "@openconditions/roads";
import { parseFintrafficStations, parseFintrafficSensorConstants } from "@openconditions/roads";

type Sql = postgres.Sql;

export interface FintrafficNativeDeps {
  fetch: typeof fetch;
  now: () => Date;
  /** Hard cap on per-station constants requests per run (rate-limit courtesy). */
  batchCap: number;
}

const CONSTANTS_BASE = "https://tie.digitraffic.fi/api/tms/v1/stations";

/**
 * Low-frequency native-baseline refresh: reads a Fintraffic feed's station
 * registry, then for a bounded batch of stations fetches per-station
 * sensor-constants and upserts the seasonal VVAPAAS free-flow speed as a
 * native, per-sensor overall (dow=-1, tod=-1) baseline. Sensor keys are
 * `${feed.id}:${stationId}-${dir}`, matching the flow parser's `flow.id` so
 * `loadBaselineMap` joins them at ingest time. Bounded (batchCap),
 * egress-guarded (the caller supplies a guarded fetch), and tolerant of
 * failure at every level — a bad station list or a single failing station
 * never throws, leaving prior baselines intact and letting the rest of the
 * batch proceed.
 */
export async function updateFintrafficNativeBaselines(
  sql: Sql,
  feed: FeedSource,
  deps: FintrafficNativeDeps
): Promise<{ updated: number }> {
  const regUrl = feed.stationRegistry?.url;
  if (!regUrl) return { updated: 0 };

  let stationIds: string[];
  try {
    const res = await deps.fetch(regUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    stationIds = [...parseFintrafficStations(await res.text()).keys()];
  } catch (err) {
    console.warn(`[ingest] fintraffic native: station list failed:`, err);
    return { updated: 0 };
  }

  const on = deps.now();
  let updated = 0;
  for (const stationId of stationIds.slice(0, deps.batchCap)) {
    try {
      const res = await deps.fetch(`${CONSTANTS_BASE}/${stationId}/sensor-constants`);
      if (!res.ok) continue;
      const rows = parseFintrafficSensorConstants(await res.text(), { stationId, on });
      for (const r of rows) {
        await sql`
          INSERT INTO conditions.sensor_baseline
            (sensor_key, source, dow_bucket, tod_bucket, free_flow_kph, method, sample_count, computed_at)
          VALUES (${`${feed.id}:${r.sensorKey}`}, ${feed.id}, -1, -1, ${r.freeFlowKph}, 'native', 0, now())
          ON CONFLICT (sensor_key, dow_bucket, tod_bucket, method)
          DO UPDATE SET free_flow_kph = EXCLUDED.free_flow_kph, computed_at = EXCLUDED.computed_at`;
        updated += 1;
      }
    } catch (err) {
      console.warn(`[ingest] fintraffic native: station ${stationId} failed:`, err);
    }
  }
  return { updated };
}
