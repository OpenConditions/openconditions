import type { Point } from "geojson";
import type { RoadFlow } from "./model.js";
import type { SourceDescriptor } from "./types.js";
import { makeOrigin } from "./flow.js";
import type { FlowParseResult } from "./flow.js";

interface Flow {
  SiteId?: unknown;
  AverageVehicleSpeed?: unknown;
  MeasurementTime?: unknown;
  Geometry?: { WGS84?: unknown };
}

/** Parse a "POINT (lon lat)" WKT string into a GeoJSON Point. */
function parseWktPoint(raw: unknown): Point | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { type: "Point", coordinates: [lon, lat] };
}

/**
 * Parse a Trafikverket TrafficFlow (v1.4) data.json response into RoadFlow
 * measurements. Speed (`AverageVehicleSpeed`) is already km/h; geometry is the
 * inline WGS84 WKT point (`Geometry.WGS84`, "POINT (lon lat)"), so no separate
 * station registry join is needed. los stays "unknown"; the baseline
 * enrichment pipeline step classifies it. Distinct from the event parser
 * registered under `trafikverket-json` (`trafikverket.ts`).
 */
export function parseTrafikverketFlow(
  input: string | Buffer,
  src: SourceDescriptor
): FlowParseResult {
  let payload: { RESPONSE?: { RESULT?: unknown } };
  try {
    payload = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch {
    return { flows: [], events: [] };
  }
  const results = payload.RESPONSE?.RESULT;
  if (!Array.isArray(results)) return { flows: [], events: [] };

  const now = new Date().toISOString();
  const origin = makeOrigin(src);
  const flows: RoadFlow[] = [];

  for (const result of results as { TrafficFlow?: unknown }[]) {
    const items = Array.isArray(result?.TrafficFlow) ? (result.TrafficFlow as Flow[]) : [];
    for (const item of items) {
      const siteId = item?.SiteId != null ? String(item.SiteId) : null;
      if (!siteId) continue;
      const geometry = parseWktPoint(item.Geometry?.WGS84);
      if (!geometry) continue;
      const speedKph = Number(item.AverageVehicleSpeed);
      if (!Number.isFinite(speedKph) || speedKph < 0) continue;
      const measuredAt = typeof item.MeasurementTime === "string" ? item.MeasurementTime : now;
      flows.push({
        id: `${src.id}:${siteId}`,
        source: src.id,
        sourceFormat: "trafikverket-flow-json",
        domain: "roads",
        kind: "measurement",
        metric: "flow",
        value: speedKph,
        unit: "km/h",
        level: "unknown",
        aggregation: "live",
        status: "active",
        geometry,
        los: "unknown",
        speedKph,
        origin,
        dataUpdatedAt: measuredAt,
        fetchedAt: now,
        isStale: false,
      });
    }
  }
  return { flows, events: [] };
}
