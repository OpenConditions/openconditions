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
  /**
   * Hard cap on the TOTAL number of `exclude_locations` across every closure
   * in the response, applied after per-closure sampling. Valhalla rejects more
   * than 50 `exclude_locations` outright (HTTP 400, "Exceeded max avoid
   * locations: 50"), which would fail the whole route — so we stay safely
   * below that ceiling and subsample if needed. Default 45.
   */
  maxTotalPoints?: number;
  /**
   * Wall-clock instant the feed is "active at": events whose `validFrom` is
   * in the future relative to this are not yet in effect and are excluded, so
   * planned-but-not-started closures don't block routing early. Default the
   * current time — pass an explicit value for deterministic tests/replays.
   */
  activeAt?: Date;
}

const CLOSURE_TYPES = new Set(["road_closure", "lane_closure"]);
const DEFAULT_MAX_SPACING_M = 45;
const DEFAULT_MAX_POINTS = 200;
const DEFAULT_MAX_TOTAL_POINTS = 45;

function eventType(o: Observation): string | undefined {
  return (o as Observation & { type?: string }).type;
}

/** Closure-typed events (road/lane closures) are the only ones whose polygon
 * geometry is safe to exclude wholesale — a critical but non-closure event
 * (e.g. a region-sized weather warning) must not turn into a routing-blocking
 * polygon, even though its point/line geometry still contributes. */
function isClosureType(o: Observation): boolean {
  const type = eventType(o);
  return type != null && CLOSURE_TYPES.has(type);
}

/** A closure or otherwise route-blocking event worth feeding to Valhalla: an
 * active road/lane closure, or any active critical-severity event, currently
 * in effect at `activeAt` (not yet started, or already ended, closures don't
 * contribute). */
function isExcludable(o: Observation, activeAt: Date): boolean {
  if (o.kind !== "event" || o.status !== "active") return false;
  // Origin-aware routing gate (the plan's #1 safety promise), fail-CLOSED to
  // match the SQL `routingEligibleOnly` filter: exclude for routing ONLY an
  // authoritative feed observation, or a crowd observation an external resolution
  // made routing-eligible. A lone self-reported crowd closure — and any
  // unknown/missing-provenance closure — never becomes a Valhalla exclusion.
  const originKind = o.origin?.kind;
  const routable = originKind === "feed" || (originKind === "crowd" && o.routingEligible === true);
  if (!routable) return false;
  const e = o as Observation & { severity?: string };
  if (!(isClosureType(o) || e.severity === "critical")) return false;
  const t = activeAt.getTime();
  if (o.validFrom != null) {
    const from = Date.parse(o.validFrom);
    if (!Number.isNaN(from) && t < from) return false; // not yet in effect
  }
  // Belt-and-suspenders: readObservations already filters `valid_to > now()`
  // upstream, but a route-local check is cheap and keeps this projection
  // correct even if called with pre-filtered or stale data.
  if (o.validTo != null) {
    const to = Date.parse(o.validTo);
    if (!Number.isNaN(to) && t > to) return false; // already ended
  }
  return true;
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
  // The strided loop never lands on the final index, so force the terminal
  // endpoint into the last slot — a closure's far end must stay excluded.
  sampled[sampled.length - 1] = out[out.length - 1]!;
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

/** Evenly subsample `points` down to at most `max`, preserving geographic
 * spread (and the first vertex). Returns the input unchanged when already
 * within `max`. Mirrors the OpenMapX routing consumer's own total cap. */
function subsampleEvenly<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const stride = points.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * stride)] as T);
  return out;
}

/** Add one geometry's avoidance footprint: points → locations, lines → sampled
 * locations, polygons → exterior rings (only for closure-typed events —
 * `isClosureType` false suppresses the ring so a critical-but-non-closure
 * polygon, e.g. a region-sized weather warning, doesn't become a
 * region-sized routing exclusion). Unknown types are skipped. */
function addGeometry(
  geometry: Geometry,
  ex: ValhallaExclusions,
  maxSpacing: number,
  cap: number,
  isClosure: boolean
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
      if (isClosure) pushRing(geometry.coordinates[0], ex);
      break;
    case "MultiPolygon":
      if (isClosure) for (const poly of geometry.coordinates) pushRing(poly[0], ex);
      break;
    case "GeometryCollection":
      for (const g of geometry.geometries) addGeometry(g, ex, maxSpacing, cap, isClosure);
      break;
  }
}

/**
 * Projects road-condition observations to a Valhalla exclusions object — the
 * live-avoidance half of the "Valhalla feed". Only active closures and critical
 * events, currently in effect, contribute; a consumer merges the result into
 * its Valhalla route request to route around them. Read-only over the
 * canonical model, but defaults to wall-clock time (`activeAt`), so pass that
 * option explicitly for deterministic/reproducible calls.
 *
 * Bounds the payload two ways: each closure is downsampled to at most
 * `maxPointsPerClosure` points, and the combined `exclude_locations` across
 * ALL closures is then evenly subsampled to at most `maxTotalPoints` — the
 * total is what Valhalla actually enforces a hard ceiling on (50), so a
 * per-closure-only cap still lets many small closures add up to a rejected
 * request.
 */
export function eventsToExclusions(
  obs: Observation[],
  opts: ValhallaExclusionOptions = {}
): ValhallaExclusions {
  const maxSpacing = opts.maxSpacingMeters ?? DEFAULT_MAX_SPACING_M;
  const cap = opts.maxPointsPerClosure ?? DEFAULT_MAX_POINTS;
  const maxTotal = opts.maxTotalPoints ?? DEFAULT_MAX_TOTAL_POINTS;
  const activeAt = opts.activeAt ?? new Date();
  const ex: ValhallaExclusions = { exclude_locations: [], exclude_polygons: [] };
  for (const o of obs) {
    if (isExcludable(o, activeAt)) {
      addGeometry(o.geometry as Geometry, ex, maxSpacing, cap, isClosureType(o));
    }
  }
  if (ex.exclude_locations.length > maxTotal) {
    ex.exclude_locations = subsampleEvenly(ex.exclude_locations, maxTotal);
  }
  return ex;
}

/** One directed segment's fused speed, ready to render as a `speed.csv` row. */
export interface SegmentSpeedCsvRow {
  wayId: string | number;
  dir: string;
  currentKph: number | null;
  freeFlowKph: number | null;
  los: string;
}

/**
 * Projects fused segment speeds into the `GET /segments/speed.csv` routing
 * feed body: a header line followed by one row per directed segment, the
 * OpenMapX `traffic.tar` writer's input. Null current/free-flow (should not
 * occur for rows the caller has already filtered to `current_kph IS NOT
 * NULL`, but kept defensive here since this is a pure, caller-agnostic
 * formatter) renders as an empty CSV field rather than the string "null".
 */
export function flowToSegmentSpeedCsv(rows: SegmentSpeedCsvRow[]): string {
  const lines = ["way_id,dir,current_kph,free_flow_kph,los"];
  for (const row of rows) {
    const current = row.currentKph == null ? "" : String(row.currentKph);
    const freeFlow = row.freeFlowKph == null ? "" : String(row.freeFlowKph);
    lines.push(`${row.wayId},${row.dir},${current},${freeFlow},${row.los}`);
  }
  return lines.join("\n");
}
