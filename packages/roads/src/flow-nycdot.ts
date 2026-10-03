import type { LineString } from "geojson";
import { localTimestamp } from "./flow.js";
import type { FlowContext, FlowSites } from "./flow-output.js";
import { type FlowParse, type FlowReading, parseJson } from "./flow-reading.js";
import type { SourceDescriptor } from "./types.js";

const MPH_TO_KPH = 1.609344;

interface Link {
  link_id?: unknown;
  speed?: unknown;
  link_points?: unknown;
  data_as_of?: unknown;
  link_name?: unknown;
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
 * Parse the NYC DOT real-time traffic-speed Socrata resource (`i4gi-tjb9.json`).
 * Speed is mph → km/h; geometry is the inline `link_points` polyline, which
 * the source publishes in lat,lon order (swapped here to GeoJSON's lon,lat).
 * The level of service is left to the baseline enrichment.
 */
export function parseNycDotFlow(
  input: string | Buffer,
  _src: SourceDescriptor,
  _sites: FlowSites | undefined,
  _ctx: FlowContext,
): FlowParse {
  const rows = parseJson(input);
  if (!Array.isArray(rows)) return { readings: [] };

  const readings: FlowReading[] = [];
  for (const raw of rows as Link[]) {
    const linkId = raw?.link_id != null ? String(raw.link_id) : null;
    if (!linkId) continue;
    const geometry = parseLinkPoints(raw.link_points);
    if (!geometry) continue;
    const speedRaw = raw.speed;
    if (typeof speedRaw === "string" && speedRaw.trim() === "") continue;
    const mph = Number(speedRaw);
    if (!Number.isFinite(mph) || mph < 0) continue;
    // Socrata publishes a floating timestamp: New York wall-clock time without an offset.
    const at =
      typeof raw.data_as_of === "string"
        ? localTimestamp(raw.data_as_of, "America/New_York")
        : undefined;
    const name = typeof raw.link_name === "string" ? raw.link_name.trim() : "";
    readings.push({
      site: linkId,
      geometry,
      ...(at !== undefined ? { at } : {}),
      los: "unknown",
      speedKph: mph * MPH_TO_KPH,
      ...(name ? { name, nameLang: "en" } : {}),
    });
  }
  return { readings };
}
