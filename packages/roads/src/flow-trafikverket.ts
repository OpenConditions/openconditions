import type { Point } from "geojson";
import type { FlowContext, FlowSites } from "./flow-output.js";
import { type FlowParse, type FlowReading, parseJson, plausibleSpeed } from "./flow-reading.js";
import type { SourceDescriptor } from "./types.js";

interface Flow {
  SiteId?: unknown;
  AverageVehicleSpeed?: unknown;
  VehicleFlowRate?: unknown;
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
 * Parse a Trafikverket TrafficFlow (v1.4) data.json response: per site the
 * average speed (km/h) and the flow rate (vehicles per hour), located by the
 * inline WGS84 WKT point (`Geometry.WGS84`), so no station registry join is
 * needed. A site that measured only a flow rate is kept. The level of service
 * is left to the baseline enrichment. Distinct from the event parser
 * (`trafikverket.ts`).
 */
export function parseTrafikverketFlow(
  input: string | Buffer,
  _src: SourceDescriptor,
  _sites: FlowSites | undefined,
  _ctx: FlowContext,
): FlowParse {
  const payload = parseJson(input) as { RESPONSE?: { RESULT?: unknown } } | undefined;
  const results = payload?.RESPONSE?.RESULT;
  if (!Array.isArray(results)) return { readings: [] };

  const readings: FlowReading[] = [];
  for (const result of results as { TrafficFlow?: unknown }[]) {
    const items = Array.isArray(result?.TrafficFlow) ? (result.TrafficFlow as Flow[]) : [];
    for (const item of items) {
      const siteId = item?.SiteId != null ? String(item.SiteId) : null;
      if (!siteId) continue;
      const geometry = parseWktPoint(item.Geometry?.WGS84);
      if (!geometry) continue;
      const speed = item.AverageVehicleSpeed != null ? Number(item.AverageVehicleSpeed) : undefined;
      const rate = item.VehicleFlowRate != null ? Number(item.VehicleFlowRate) : undefined;
      const speedKph = plausibleSpeed(speed) ? speed : undefined;
      const volume = rate !== undefined && Number.isFinite(rate) && rate >= 0 ? rate : undefined;
      if (speedKph === undefined && volume === undefined) continue;
      readings.push({
        site: siteId,
        geometry,
        ...(typeof item.MeasurementTime === "string" ? { at: item.MeasurementTime } : {}),
        los: "unknown",
        ...(speedKph !== undefined ? { speedKph } : {}),
        ...(volume !== undefined ? { volume } : {}),
      });
    }
  }
  return { readings };
}
