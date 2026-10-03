import { routingEvidenceReasons } from "@openconditions/core";
import { isInEffectAt } from "@openconditions/model";
import type { Geometry } from "geojson";
import type { SegmentConditionJson } from "./segment-conditions.js";

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
   * Wall-clock instant the feed is "active at": only events in effect at this
   * instant contribute, so planned-but-not-started closures don't block routing
   * early and a recurring closure only blocks inside one of its schedule's
   * occurrences. Default the current time — pass an explicit value for
   * deterministic tests/replays.
   */
  activeAt?: Date;
  /** Present-time authority check, distinct from a future route's activeAt. */
  evaluatedAt?: Date;
}

const DEFAULT_MAX_SPACING_M = 45;
const DEFAULT_MAX_POINTS = 200;
const DEFAULT_MAX_TOTAL_POINTS = 45;

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
  cap: number,
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
 * locations, polygons → exterior rings (only for a closure, so a non-closure
 * area never becomes a region-sized routing exclusion). Unknown types are
 * skipped. */
function addGeometry(
  geometry: Geometry,
  ex: ValhallaExclusions,
  maxSpacing: number,
  cap: number,
  isClosure: boolean,
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

const CAR_CLASSES: ReadonlySet<string> = new Set(["car", "motor_vehicle"]);

/**
 * Whether an exception could spare an ordinary car: it names cars, or names
 * no class and selects by what a vehicle is (weight, fuel, occupancy), which
 * a car may meet. An exception by usage alone (emergency services, residents,
 * deliveries) excepts a purpose, not cars, so through traffic stays closed.
 * That includes local access: an exclusion cannot know where a request starts
 * or ends, so a consumer that routes to an address on such a road must relax
 * it itself near its endpoints.
 */
function sparesCars(s: Record<string, unknown>): boolean {
  if (typeof s["class"] === "string") return CAR_CLASSES.has(s["class"]);
  return Object.keys(s).some((key) => key !== "usage" && key !== "raw");
}

/**
 * Whether an effect applies to every car: all vehicles, or a class list
 * naming cars without any further condition, and no exception that could
 * spare a car. A selector that narrows cars (by weight, fuel, usage) does not
 * count. The OpenMapX live-traffic writer decides the same.
 */
function appliesToCars(a: SegmentConditionJson["effect"]["applicability"]): boolean {
  const plainCar = (s: Record<string, unknown>) =>
    typeof s["class"] === "string" &&
    CAR_CLASSES.has(s["class"]) &&
    Object.keys(s).every((key) => key === "class" || key === "raw");
  if (a.except?.some((s) => sparesCars(s))) return false;
  if (a.kind === "all") return true;
  return a.kind === "classes" && (a.include ?? []).some(plainCar);
}

/** A routed speed limit on one directed span, for a consumer that caps edge speeds. */
export interface SegmentSpeedCap {
  way_id: number;
  dir: "f" | "b";
  start_fraction: number;
  end_fraction: number;
  limit_kph: number;
}

/** Closure scopes off the carriageway: closing them leaves the road open to cars. */
const OFF_CARRIAGEWAY = new Set(["sidewalk", "cycleway", "rest_area", "facility"]);

/** Whether an effect closes the carriageway: a closure of it, or every lane closed. */
function closesRoad(effect: SegmentConditionJson["effect"]): boolean {
  if (effect.kind === "closure") return !OFF_CARRIAGEWAY.has(effect.scope);
  return effect.kind === "lane_restriction" && effect.vehicleImpact === "all_lanes_closed";
}

/**
 * Valhalla exclusions from the already-gated segment contract: closure
 * effects that apply to cars, plus the speed limits that do as caps.
 * Coordinate avoidance cannot preserve direction or a partial span, so only
 * full-way, bidirectional closures are excluded; speed caps keep their spans.
 */
export function segmentConditionsToExclusions(
  conditions: SegmentConditionJson[],
  opts: ValhallaExclusionOptions = {},
): ValhallaExclusions & { speed_caps: SegmentSpeedCap[] } {
  const maxSpacing = opts.maxSpacingMeters ?? DEFAULT_MAX_SPACING_M;
  const cap = opts.maxPointsPerClosure ?? DEFAULT_MAX_POINTS;
  const maxTotal = opts.maxTotalPoints ?? DEFAULT_MAX_TOTAL_POINTS;
  const activeAt = opts.activeAt ?? new Date();
  const evaluatedAt = opts.evaluatedAt ?? activeAt;
  const ex: ValhallaExclusions = { exclude_locations: [], exclude_polygons: [] };
  const speedCaps: SegmentSpeedCap[] = [];
  for (const condition of conditions) {
    const evidence = condition.routing_evidence;
    const effect = condition.effect;
    if (routingEvidenceReasons(evidence, evaluatedAt).length > 0) continue;
    if (!appliesToCars(effect.applicability)) continue;
    if (!isInEffectAt({ validFrom: evidence.valid_from, validTo: evidence.valid_to }, activeAt)) {
      continue;
    }
    if (effect.kind === "speed_limit" && effect.advisory !== true) {
      for (const span of condition.segments) {
        speedCaps.push({
          way_id: span.way_id,
          dir: span.dir,
          start_fraction: span.start_fraction,
          end_fraction: span.end_fraction,
          limit_kph: effect.limit.value,
        });
      }
      continue;
    }
    if (!closesRoad(effect) || evidence.direction_mode !== "both") continue;
    if (evidence.segments.some((span) => span.from_fraction !== 0 || span.to_fraction !== 1)) {
      continue;
    }
    for (const span of condition.segments) {
      if (!span.geometry || span.start_fraction !== 0 || span.end_fraction !== 1) continue;
      addGeometry(span.geometry, ex, maxSpacing, cap, true);
    }
  }
  if (ex.exclude_locations.length > maxTotal) {
    ex.exclude_locations = subsampleEvenly(ex.exclude_locations, maxTotal);
  }
  return { ...ex, speed_caps: speedCaps };
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
