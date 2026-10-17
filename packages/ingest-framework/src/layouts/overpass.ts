import type { RecordSkipReason } from "../skips.js";

/** One element of an Overpass `out center` JSON answer, with a position. */
export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lon: number;
  lat: number;
  tags: Record<string, string>;
}

const TYPES = new Set(["node", "way", "relation"]);

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** An OSM element id: a positive safe integer. */
const isOsmId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/**
 * The elements of an Overpass JSON answer. A way or relation is placed at its
 * `center`. An element that is no object, of another type, whose id is not a
 * positive safe integer, or without a numeric position is left out and
 * reported to `onSkip`: an unknown type as `unknown_type`, no position at all
 * as `no_geometry`, anything else as `malformed`. Throws on a body that is
 * not JSON and on a `runtime error` remark (a timeout or memory limit), whose
 * elements are an incomplete answer.
 */
export function decodeOverpass(
  payload: Buffer,
  onSkip?: (reason: RecordSkipReason) => void,
): OverpassElement[] {
  let doc: unknown;
  try {
    doc = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("overpass: body is not valid JSON");
  }
  const root = (doc ?? {}) as { remark?: unknown; elements?: unknown };
  if (typeof root.remark === "string" && root.remark.startsWith("runtime error")) {
    throw new Error(`overpass: ${root.remark}`);
  }
  if (!Array.isArray(root.elements)) throw new Error("overpass: body has no elements array");

  const out: OverpassElement[] = [];
  for (const item of root.elements as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      onSkip?.("malformed");
      continue;
    }
    const raw = item as Record<string, unknown>;
    if (!TYPES.has(raw.type as string)) {
      onSkip?.("unknown_type");
      continue;
    }
    if (!isOsmId(raw.id)) {
      onSkip?.("malformed");
      continue;
    }
    const centre = (raw.center ?? {}) as { lat?: unknown; lon?: unknown };
    const lat = isNumber(raw.lat) ? raw.lat : centre.lat;
    const lon = isNumber(raw.lon) ? raw.lon : centre.lon;
    if (!isNumber(lat) || !isNumber(lon)) {
      const positioned = [raw.lat, raw.lon, centre.lat, centre.lon].some((v) => v != null);
      onSkip?.(positioned ? "malformed" : "no_geometry");
      continue;
    }
    out.push({
      type: raw.type as OverpassElement["type"],
      id: raw.id,
      lat,
      lon,
      tags: Object.fromEntries(
        Object.entries((raw.tags ?? {}) as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    });
  }
  return out;
}
