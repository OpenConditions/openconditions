import { featuresToRoadEvents } from "./geojson.js";
import type { RoadEvent } from "./model.js";
import type { SourceDescriptor } from "./types.js";

/**
 * Generic reader for flat JSON arrays of point records (e.g. Thailand iTIC).
 * It wraps each record as a pseudo-feature and reuses the GeoJSON
 * reader's field mapping — geometry is built from the mapping's lonField/latField
 * (so there is no parsing logic duplicated here). The records array is the JSON
 * root, or `mapping.arrayPath` when nested (e.g. LTA-style `{value:[…]}`).
 */

function recordsAt(data: unknown, path: string | undefined): Record<string, unknown>[] {
  let node: unknown = data;
  if (path) {
    for (const part of path.split(".")) {
      if (node && typeof node === "object") node = (node as Record<string, unknown>)[part];
      else return [];
    }
  }
  return Array.isArray(node) ? (node as Record<string, unknown>[]) : [];
}

export function parseFlatJson(
  input: string | Buffer | unknown,
  src: SourceDescriptor
): RoadEvent[] {
  let data: unknown = input;
  if (typeof input === "string" || Buffer.isBuffer(input)) {
    try {
      data = JSON.parse(input.toString("utf8"));
    } catch {
      return [];
    }
  }
  const records = recordsAt(data, src.geojson?.arrayPath);
  // Wrap each record as a pseudo-feature (no geometry); the reader builds the
  // point from the mapping's lonField/latField.
  const features = records.map((properties) => ({
    type: "Feature" as const,
    geometry: null,
    properties,
  }));
  return featuresToRoadEvents(features, undefined, src, "flatjson");
}
