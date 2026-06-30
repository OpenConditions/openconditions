import type { Geometry } from "geojson";
import tzLookup from "tz-lookup";

/**
 * IANA timezone name for a coordinate (e.g. `"Europe/Berlin"`), or `null` when
 * the lookup fails (coordinate outside the dataset, e.g. open ocean). Thin
 * wrapper over `tz-lookup`, which takes `(lat, lng)`.
 */
export function timeZoneAt(lat: number, lng: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  try {
    return tzLookup(lat, lng);
  } catch {
    return null;
  }
}

/** First `[lng, lat]` coordinate found in any GeoJSON geometry, or `null`. */
function firstCoordinate(geometry: Geometry): [number, number] | null {
  const g = geometry as {
    type?: string;
    coordinates?: unknown;
    geometries?: Geometry[];
  };
  if (g.type === "GeometryCollection") {
    for (const sub of g.geometries ?? []) {
      const c = firstCoordinate(sub);
      if (c) return c;
    }
    return null;
  }
  let node: unknown = g.coordinates;
  while (Array.isArray(node) && Array.isArray(node[0])) node = node[0];
  if (Array.isArray(node) && typeof node[0] === "number" && typeof node[1] === "number") {
    return [node[0], node[1]];
  }
  return null;
}

/**
 * IANA timezone for a geometry's representative point, or `null`. Used to stamp
 * a `Schedule.scheduleTimezone` at parse time so the recurrence's local times
 * are interpretable by any consumer without re-deriving the zone. A road
 * segment lies within one zone, so the first coordinate is sufficient.
 */
export function scheduleTimezoneForGeometry(geometry: Geometry | null | undefined): string | null {
  if (!geometry) return null;
  const coord = firstCoordinate(geometry);
  if (!coord) return null;
  const [lng, lat] = coord;
  return timeZoneAt(lat, lng);
}
