import type { LineString } from "geojson";
import type { RoadFlow } from "./model.js";
import type { SourceDescriptor } from "./types.js";
import { makeOrigin } from "./flow.js";
import type { FlowParseResult } from "./flow.js";

const MPH_TO_KPH = 1.609344;

interface Link {
  link_id?: unknown;
  speed?: unknown;
  link_points?: unknown;
  data_as_of?: unknown;
}

/** Parse "lat,lon lat,lon …" into a GeoJSON LineString ([lon, lat] order). */
function parseLinkPoints(raw: unknown): LineString | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const coords: [number, number][] = [];
  for (const pair of raw.trim().split(/\s+/)) {
    const [lat, lon] = pair.split(",").map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) coords.push([lon!, lat!]);
  }
  return coords.length >= 2 ? { type: "LineString", coordinates: coords } : null;
}

/**
 * Parse the NYC DOT real-time traffic-speed Socrata resource (`i4gi-tjb9.json`)
 * into RoadFlow segments. Speed is mph → km/h; geometry is the inline
 * `link_points` polyline, which the source publishes in lat,lon order (swapped
 * here to GeoJSON's lon,lat). los stays "unknown"; the baseline enrichment
 * classifies it. NYC-only coverage.
 */
export function parseNycDotFlow(input: string | Buffer, src: SourceDescriptor): FlowParseResult {
  let rows: unknown;
  try {
    rows = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch {
    return { flows: [], events: [] };
  }
  if (!Array.isArray(rows)) return { flows: [], events: [] };

  const now = new Date().toISOString();
  const origin = makeOrigin(src);
  const flows: RoadFlow[] = [];

  for (const raw of rows as Link[]) {
    const linkId = raw?.link_id != null ? String(raw.link_id) : null;
    if (!linkId) continue;
    const geometry = parseLinkPoints(raw.link_points);
    if (!geometry) continue;
    const speedRaw = raw.speed;
    if (typeof speedRaw === "string" && speedRaw.trim() === "") continue;
    const mph = Number(speedRaw);
    if (!Number.isFinite(mph) || mph < 0) continue;
    const measuredAt = typeof raw.data_as_of === "string" ? raw.data_as_of : now;
    flows.push({
      id: `${src.id}:${linkId}`,
      source: src.id,
      sourceFormat: "nyc-dot-speed-json",
      domain: "roads",
      kind: "measurement",
      metric: "flow",
      value: mph * MPH_TO_KPH,
      unit: "km/h",
      level: "unknown",
      aggregation: "live",
      status: "active",
      geometry,
      los: "unknown",
      speedKph: mph * MPH_TO_KPH,
      origin,
      dataUpdatedAt: measuredAt,
      fetchedAt: now,
      isStale: false,
    });
  }
  return { flows, events: [] };
}
