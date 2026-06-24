import type { Observation } from "@openconditions/core";
import type { Geometry } from "geojson";

/**
 * Valhalla route-request exclusion geometry, ready to merge into a Valhalla
 * turn-by-turn `/route` request body. Per the Valhalla API:
 *  - `exclude_locations` — a top-level array of `{lat, lon}` points; each is
 *    mapped to the nearest road, which is then excluded from path finding.
 *  - `exclude_polygons` — a top-level array of exterior rings, each a list of
 *    `[lon, lat]` pairs (GeoJSON order); roads intersecting a ring are avoided.
 *    Valhalla closes open rings itself, so we do not duplicate the first vertex.
 * (The Valhalla docs note `exclude_locations` is much more efficient than a
 * polygon for a handful of roads — hence linear closures become sampled points.)
 */
export interface ValhallaExclusions {
  exclude_locations: Array<{ lon: number; lat: number }>;
  exclude_polygons: Array<Array<[number, number]>>;
}

export interface ValhallaExclusionOptions {
  /** Max spacing (metres) between points sampled along a linear closure, so even
   * a sparsely-digitised closed segment is blocked edge to edge. Default 45. */
  maxSpacingMeters?: number;
  /** Cap on points contributed to `exclude_locations` per linear closure (a long
   * line is evenly downsampled to this), bounding the payload. Default 200. */
  maxPointsPerClosure?: number;
}

const CLOSURE_TYPES = new Set(["road_closure", "lane_closure"]);
const DEFAULT_MAX_SPACING_M = 45;
const DEFAULT_MAX_POINTS = 200;

/** A closure or otherwise route-blocking event worth feeding to Valhalla: an
 * active road/lane closure, or any active critical-severity event. */
function isExcludable(o: Observation): boolean {
  if (o.kind !== "event" || o.status !== "active") return false;
  const e = o as Observation & { type?: string; severity?: string };
  return (e.type != null && CLOSURE_TYPES.has(e.type)) || e.severity === "critical";
}

function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Points along a polyline at <= `maxSpacing` metres apart, endpoints kept,
 * evenly downsampled to `cap` if that yields too many. */
function densify(coords: [number, number][], maxSpacing: number, cap: number): [number, number][] {
  if (coords.length <= 1) return coords.slice();
  const out: [number, number][] = [coords[0]!];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    const steps = Math.max(1, Math.ceil(haversineMeters(a, b) / maxSpacing));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  if (out.length <= cap) return out;
  const stride = out.length / cap;
  const sampled: [number, number][] = [];
  for (let i = 0; i < cap; i++) sampled.push(out[Math.floor(i * stride)]!);
  return sampled;
}

function pushLine(
  coords: [number, number][],
  ex: ValhallaExclusions,
  maxSpacing: number,
  cap: number
): void {
  for (const [lon, lat] of densify(coords, maxSpacing, cap))
    ex.exclude_locations.push({ lon, lat });
}

function pushRing(ring: number[][] | undefined, ex: ValhallaExclusions): void {
  if (ring && ring.length >= 3) ex.exclude_polygons.push(ring.map(([lon, lat]) => [lon!, lat!]));
}

/** Add one geometry's avoidance footprint: points → locations, lines → sampled
 * locations, polygons → exterior rings. Unknown types are skipped. */
function addGeometry(
  geometry: Geometry,
  ex: ValhallaExclusions,
  maxSpacing: number,
  cap: number
): void {
  switch (geometry.type) {
    case "Point":
      ex.exclude_locations.push({ lon: geometry.coordinates[0]!, lat: geometry.coordinates[1]! });
      break;
    case "MultiPoint":
      for (const c of geometry.coordinates) ex.exclude_locations.push({ lon: c[0]!, lat: c[1]! });
      break;
    case "LineString":
      pushLine(geometry.coordinates as [number, number][], ex, maxSpacing, cap);
      break;
    case "MultiLineString":
      for (const line of geometry.coordinates)
        pushLine(line as [number, number][], ex, maxSpacing, cap);
      break;
    case "Polygon":
      pushRing(geometry.coordinates[0], ex);
      break;
    case "MultiPolygon":
      for (const poly of geometry.coordinates) pushRing(poly[0], ex);
      break;
    case "GeometryCollection":
      for (const g of geometry.geometries) addGeometry(g, ex, maxSpacing, cap);
      break;
  }
}

/**
 * Projects road-condition observations to a Valhalla exclusions object — the
 * live-avoidance half of the "Valhalla feed". Only active closures and critical
 * events contribute; a consumer merges the result into its Valhalla route
 * request to route around them. Pure and read-only over the canonical model.
 */
export function eventsToExclusions(
  obs: Observation[],
  opts: ValhallaExclusionOptions = {}
): ValhallaExclusions {
  const maxSpacing = opts.maxSpacingMeters ?? DEFAULT_MAX_SPACING_M;
  const cap = opts.maxPointsPerClosure ?? DEFAULT_MAX_POINTS;
  const ex: ValhallaExclusions = { exclude_locations: [], exclude_polygons: [] };
  for (const o of obs) {
    if (isExcludable(o)) addGeometry(o.geometry as Geometry, ex, maxSpacing, cap);
  }
  return ex;
}
