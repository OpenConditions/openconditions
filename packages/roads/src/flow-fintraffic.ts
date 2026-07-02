import type { RoadFlow } from "./model.js";
import type { SourceDescriptor } from "./types.js";
import type { SiteGeometry } from "./siteTable.js";
import { makeOrigin } from "./flow.js";
import type { FlowParseResult } from "./flow.js";

const SPEED_SENSORS: Record<string, "1" | "2"> = {
  KESKINOPEUS_5MIN_LIUKUVA_SUUNTA1: "1",
  KESKINOPEUS_5MIN_LIUKUVA_SUUNTA2: "2",
};

interface SensorValue {
  name?: unknown;
  // Digitraffic's TMS sensorValues entries carry the reading in `value`
  // (e.g. {"name":"KESKINOPEUS_5MIN_LIUKUVA_SUUNTA1","value":98}), not
  // `sensorValue`.
  value?: unknown;
  measuredTime?: unknown;
}
interface Station {
  id?: unknown;
  dataUpdatedTime?: unknown;
  sensorValues?: unknown;
}

/**
 * Parse a Fintraffic TMS `/stations/data` JSON payload into RoadFlow
 * measurements — one per station direction carrying a 5-minute sliding-average
 * speed. Geometry comes from the injected station registry map keyed by station
 * id. los is left "unknown"; the baseline enrichment classifies it.
 */
export function parseFintrafficFlow(
  input: string | Buffer,
  src: SourceDescriptor,
  siteMap?: Map<string, SiteGeometry>
): FlowParseResult {
  let payload: { stations?: unknown };
  try {
    payload = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch {
    return { flows: [], events: [] };
  }
  const stations = payload.stations;
  if (!Array.isArray(stations)) return { flows: [], events: [] };

  const flows: RoadFlow[] = [];
  const now = new Date().toISOString();
  const origin = makeOrigin(src);

  for (const raw of stations as Station[]) {
    const stationId = raw?.id != null ? String(raw.id) : null;
    if (stationId == null) continue;
    const geom = siteMap?.get(stationId);
    if (!geom) continue;
    const sensors = Array.isArray(raw.sensorValues) ? (raw.sensorValues as SensorValue[]) : [];
    for (const s of sensors) {
      const dir = typeof s.name === "string" ? SPEED_SENSORS[s.name] : undefined;
      if (!dir) continue;
      const speedKph = typeof s.value === "number" ? s.value : NaN;
      if (!Number.isFinite(speedKph) || speedKph < 0) continue;
      const measuredAt =
        typeof s.measuredTime === "string"
          ? s.measuredTime
          : typeof raw.dataUpdatedTime === "string"
            ? raw.dataUpdatedTime
            : now;
      flows.push({
        id: `${src.id}:${stationId}-${dir}`,
        source: src.id,
        sourceFormat: "fintraffic-tms-json",
        domain: "roads",
        kind: "measurement",
        metric: "flow",
        value: speedKph,
        unit: "km/h",
        level: "unknown",
        aggregation: "live",
        status: "active",
        geometry: geom,
        los: "unknown",
        speedKph,
        direction: `SUUNTA${dir}`,
        origin,
        dataUpdatedAt: measuredAt,
        fetchedAt: now,
        isStale: false,
      });
    }
  }
  return { flows, events: [] };
}
