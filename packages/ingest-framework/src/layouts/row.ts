import { isPlausibleWgs84 } from "../reproject.js";
import type { LayoutBlock } from "./block.js";

/** One decoded record: where it sits (when placeable) and its raw fields. */
export interface LayoutRow {
  point?: [number, number];
  fields: Record<string, unknown>;
}

/**
 * A dotted path into a record, numeric segments indexing arrays. A key that
 * itself contains dots wins over splitting, so flat records with names like
 * `geo.lat` stay reachable.
 */
export function getPath(fields: unknown, path: string): unknown {
  if (fields && typeof fields === "object" && path in (fields as Record<string, unknown>)) {
    return (fields as Record<string, unknown>)[path];
  }
  let cur: unknown = fields;
  for (const part of path.split(".")) {
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(part)) return undefined;
      cur = cur[Number(part)];
    } else if (cur && typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** A finite number from a number or a numeric string, honouring a decimal comma. */
export function toNumber(value: unknown, decimalComma = false): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length === 0) return undefined;
  const n = Number(decimalComma ? text.replace(",", ".") : text);
  return Number.isFinite(n) ? n : undefined;
}

/** A `[lon, lat]` pair when both are finite and within WGS84 range. */
export function placeable(lon: number | undefined, lat: number | undefined) {
  if (lon === undefined || lat === undefined) return undefined;
  const pair: [number, number] = [lon, lat];
  return isPlausibleWgs84(pair) ? pair : undefined;
}

/** The mean of a list of vertices. */
export function vertexMean(points: [number, number][]): [number, number] | undefined {
  if (points.length === 0) return undefined;
  let x = 0;
  let y = 0;
  for (const [px, py] of points) {
    x += px;
    y += py;
  }
  return [x / points.length, y / points.length];
}

/** A point from the block's `point` field: a "a,b" string or a two-element array. */
function pointFromField(fields: unknown, block: LayoutBlock): [number, number] | undefined {
  if (!block.point) return undefined;
  const raw = getPath(fields, block.point.field);
  const decimalComma = block.decimalComma === true;
  let parts: unknown[] | undefined;
  if (Array.isArray(raw)) parts = raw;
  else if (typeof raw === "string") {
    parts = raw.trim().split(decimalComma ? /\s*;\s*|\s+/ : /\s*[,;]\s*|\s+/);
  }
  if (!parts || parts.length < 2) return undefined;
  const a = toNumber(parts[0], decimalComma);
  const b = toNumber(parts[1], decimalComma);
  return block.point.order === "latlon" ? placeable(b, a) : placeable(a, b);
}

/** A point from the block's `lon` and `lat` field paths. */
function pointFromColumns(fields: unknown, block: LayoutBlock): [number, number] | undefined {
  if (!block.lon || !block.lat) return undefined;
  const decimalComma = block.decimalComma === true;
  return placeable(
    toNumber(getPath(fields, block.lon), decimalComma),
    toNumber(getPath(fields, block.lat), decimalComma),
  );
}

/**
 * The point a record's own fields name: the `point` field, else `lon`/`lat`.
 * Geometry is the caller's last resort, since only the geojson and json
 * layouts carry any.
 */
export function pointFromFields(fields: unknown, block: LayoutBlock): [number, number] | undefined {
  return pointFromField(fields, block) ?? pointFromColumns(fields, block);
}
