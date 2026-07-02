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
 * Derives a station id from a stored native sensor_key, mirroring the exact
 * format the writer below produces (`${feed.id}:${stationId}-${dir}`): strip
 * the feed-id prefix, then strip the trailing `-${dir}` direction suffix.
 */
function stationIdFromSensorKey(sensorKey: string, feedId: string): string {
  const prefix = `${feedId}:`;
  const unprefixed = sensorKey.startsWith(prefix) ? sensorKey.slice(prefix.length) : sensorKey;
  return unprefixed.replace(/-\d+$/, "");
}

/**
 * Orders `stationIds` so the next batch covers all stations over successive
 * runs rather than always refreshing the same registry-order prefix:
 * stations with no native baseline yet sort first (new coverage), then
 * stations that already have one, oldest `computed_at` first (seasonal
 * refresh). Ties keep the original registry order (stable sort).
 */
function orderStationsByPriority(
  stationIds: string[],
  oldestComputedAt: Map<string, Date>
): string[] {
  return stationIds
    .map((id, idx) => ({ id, idx }))
    .sort((a, b) => {
      const ageA = oldestComputedAt.get(a.id);
      const ageB = oldestComputedAt.get(b.id);
      if (!ageA !== !ageB) return ageA ? 1 : -1;
      if (ageA && ageB) {
        const diff = ageA.getTime() - ageB.getTime();
        if (diff !== 0) return diff;
      }
      return a.idx - b.idx;
    })
    .map((x) => x.id);
}

/**
 * Reads existing native baselines for this feed and reduces them to the
 * oldest `computed_at` per station (a station may hold up to 2 rows, one per
 * direction). Can throw — the caller wraps this in a try/catch and falls
 * back to plain registry order on failure rather than aborting the run.
 */
async function loadStationPriority(sql: Sql, feedId: string): Promise<Map<string, Date>> {
  const rows = await sql<{ sensor_key: string; computed_at: Date }[]>`
    SELECT sensor_key, computed_at FROM conditions.sensor_baseline
    WHERE source = ${feedId} AND method = 'native'`;
  const oldest = new Map<string, Date>();
  for (const row of rows) {
    const stationId = stationIdFromSensorKey(row.sensor_key, feedId);
    const current = oldest.get(stationId);
    if (!current || row.computed_at < current) oldest.set(stationId, row.computed_at);
  }
  return oldest;
}

/**
 * Low-frequency native-baseline refresh: reads a Fintraffic feed's station
 * registry, then for a bounded batch of stations fetches per-station
 * sensor-constants and upserts the seasonal VVAPAAS free-flow speed as a
 * native, per-sensor overall (dow=-1, tod=-1) baseline. Sensor keys are
 * `${feed.id}:${stationId}-${dir}`, matching the flow parser's `flow.id` so
 * `loadBaselineMap` joins them at ingest time. The batch is prioritized
 * (stations with no native baseline first, then oldest-refreshed first) so
 * successive nightly runs cover the whole registry instead of always
 * refreshing the same prefix; a failure computing that priority falls back
 * to plain registry order. Both the registry fetch and the per-station
 * constants fetches carry the feed's `requestHeaders` (Fintraffic's
 * `Digitraffic-User` header). Bounded (batchCap), egress-guarded (the
 * caller supplies a guarded fetch), and tolerant of failure at every level —
 * a bad station list or a single failing station never throws, leaving
 * prior baselines intact and letting the rest of the batch proceed.
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
    const res = await deps.fetch(regUrl, { headers: feed.requestHeaders });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    stationIds = [...parseFintrafficStations(await res.text()).keys()];
  } catch (err) {
    console.warn(`[ingest] fintraffic native: station list failed:`, err);
    return { updated: 0 };
  }

  let orderedStationIds = stationIds;
  try {
    const oldestComputedAt = await loadStationPriority(sql, feed.id);
    orderedStationIds = orderStationsByPriority(stationIds, oldestComputedAt);
  } catch (err) {
    console.warn(
      `[ingest] fintraffic native: priority lookup failed, falling back to registry order:`,
      err
    );
  }

  const on = deps.now();
  let updated = 0;
  for (const stationId of orderedStationIds.slice(0, deps.batchCap)) {
    try {
      const res = await deps.fetch(`${CONSTANTS_BASE}/${stationId}/sensor-constants`, {
        headers: feed.requestHeaders,
      });
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
