import type { FlowSite, FlowSites } from "./flow-output.js";

/**
 * Build the station sites (point and name) from a Fintraffic TMS `/stations` GeoJSON
 * FeatureCollection. The id may sit on the feature (`feature.id`) or in
 * `properties.id`, and is stringified the same way the flow parser
 * (`parseFintrafficFlow`) stringifies its station id, so the two maps join on
 * matching keys. Features without a Point geometry are skipped.
 */
export function parseFintrafficStations(input: string | Buffer): FlowSites {
  const map = new Map<string, FlowSite>();
  let fc: { features?: unknown };
  try {
    fc = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch {
    return map;
  }
  if (!Array.isArray(fc.features)) return map;
  for (const raw of fc.features as Record<string, unknown>[]) {
    if (!raw || typeof raw !== "object") continue;
    const props = (raw["properties"] ?? {}) as Record<string, unknown>;
    const idRaw = raw["id"] ?? props["id"];
    if (idRaw == null) continue;
    const geom = raw["geometry"] as { type?: unknown; coordinates?: unknown } | null;
    if (!geom || geom.type !== "Point" || !Array.isArray(geom.coordinates)) continue;
    const [lon, lat] = geom.coordinates as number[];
    if (typeof lon !== "number" || typeof lat !== "number") continue;
    const name = typeof props["name"] === "string" && props["name"] ? props["name"] : undefined;
    map.set(String(idRaw), {
      geometry: { type: "Point", coordinates: [lon, lat] },
      ...(name !== undefined ? { name } : {}),
    });
  }
  return map;
}
