import type { Geometry, MultiPolygon, Point, Polygon, Position } from "geojson";

/** Distance of `p` from the segment `a`–`b`, in the coordinates' own units. */
function segmentDistance(p: Position, a: Position, b: Position): number {
  const [px, py] = p as [number, number];
  const [ax, ay] = a as [number, number];
  const [bx, by] = b as [number, number];
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Douglas–Peucker over an open line: its first and last positions always stay. */
function simplifyLine(line: readonly Position[], tolerance: number): Position[] {
  if (line.length <= 2) return [...line];
  const keep = new Array<boolean>(line.length).fill(false);
  keep[0] = true;
  keep[line.length - 1] = true;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    let farthest = -1;
    let distance = tolerance;
    for (let i = from + 1; i < to; i++) {
      const d = segmentDistance(line[i]!, line[from]!, line[to]!);
      if (d > distance) {
        distance = d;
        farthest = i;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = true;
      stack.push([from, farthest], [farthest, to]);
    }
  }
  return line.filter((_, i) => keep[i]);
}

/**
 * A closed ring simplified, still closed; null when it collapses below the
 * four positions a ring needs. The ring is cut at its position farthest from
 * the first, so both halves have two fixed ends.
 */
function simplifyRing(ring: readonly Position[], tolerance: number): Position[] | null {
  if (ring.length < 4) return null;
  const first = ring[0]!;
  let cut = 0;
  let farthest = -1;
  for (let i = 1; i < ring.length - 1; i++) {
    const d = Math.hypot(ring[i]![0]! - first[0]!, ring[i]![1]! - first[1]!);
    if (d > farthest) {
      farthest = d;
      cut = i;
    }
  }
  const head = simplifyLine(ring.slice(0, cut + 1), tolerance);
  const tail = simplifyLine(ring.slice(cut), tolerance);
  const out = [...head, ...tail.slice(1)];
  return out.length >= 4 ? out : null;
}

/** A polygon's rings simplified; null when its outer ring collapses. A hole that collapses is dropped. */
function simplifyPolygon(rings: readonly Position[][], tolerance: number): Position[][] | null {
  const [outer, ...holes] = rings;
  const shell = outer === undefined ? null : simplifyRing(outer, tolerance);
  if (shell === null) return null;
  const kept = holes.map((h) => simplifyRing(h, tolerance)).filter((h) => h !== null);
  return [shell, ...kept];
}

/**
 * A geometry simplified by Douglas–Peucker with a tolerance in degrees, for
 * shapes drawn far finer than a warning needs. Rings stay closed with at
 * least four positions; a ring that would not is dropped, and so is a polygon
 * whose outer ring collapses. Null when nothing is left. Points pass as they
 * are.
 */
export function simplifyGeometry(geometry: Geometry, toleranceDeg: number): Geometry | null {
  switch (geometry.type) {
    case "Point":
    case "MultiPoint":
      return geometry;
    case "LineString":
      return { type: "LineString", coordinates: simplifyLine(geometry.coordinates, toleranceDeg) };
    case "MultiLineString":
      return {
        type: "MultiLineString",
        coordinates: geometry.coordinates.map((l) => simplifyLine(l, toleranceDeg)),
      };
    case "Polygon": {
      const rings = simplifyPolygon(geometry.coordinates, toleranceDeg);
      return rings === null ? null : { type: "Polygon", coordinates: rings };
    }
    case "MultiPolygon": {
      const polygons = geometry.coordinates
        .map((p) => simplifyPolygon(p, toleranceDeg))
        .filter((p) => p !== null);
      return polygons.length === 0 ? null : { type: "MultiPolygon", coordinates: polygons };
    }
    case "GeometryCollection": {
      const geometries = geometry.geometries
        .map((g) => simplifyGeometry(g, toleranceDeg))
        .filter((g) => g !== null);
      return geometries.length === 0 ? null : { type: "GeometryCollection", geometries };
    }
  }
}

/** Every polygon a geometry holds, as polygon coordinates. */
function polygonsOf(geometry: Geometry): Position[][][] {
  switch (geometry.type) {
    case "Polygon":
      return [geometry.coordinates];
    case "MultiPolygon":
      return geometry.coordinates;
    case "GeometryCollection":
      return geometry.geometries.flatMap(polygonsOf);
    default:
      return [];
  }
}

/**
 * The polygons of several geometries as one: a Polygon when there is one, a
 * MultiPolygon of all of them otherwise, undissolved (shapes that touch or
 * overlap stay apart). Null when none holds a polygon.
 */
export function unionPolygons(geometries: readonly Geometry[]): Polygon | MultiPolygon | null {
  const polygons = geometries.flatMap(polygonsOf);
  if (polygons.length === 0) return null;
  if (polygons.length === 1) return { type: "Polygon", coordinates: polygons[0]! };
  return { type: "MultiPolygon", coordinates: polygons };
}

/** Twice the signed area of a ring and its centroid (shoelace). */
function ringCentroid(ring: readonly Position[]): { area: number; x: number; y: number } {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i] as [number, number];
    const [x1, y1] = ring[i + 1] as [number, number];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (area === 0) {
    const n = Math.max(1, ring.length - 1);
    const mean = (k: 0 | 1) => ring.slice(0, n).reduce((s, p) => s + p[k]!, 0) / n;
    return { area, x: mean(0), y: mean(1) };
  }
  return { area, x: cx / (3 * area), y: cy / (3 * area) };
}

/** Ray casting: whether a point lies inside a ring. */
export function pointInRing([x, y]: Position, ring: readonly Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    const crosses = yi! > y! !== yj! > y!;
    if (crosses && x! < ((xj - xi) * (y! - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const inPolygon = (p: Position, rings: readonly Position[][]) =>
  pointInRing(p, rings[0]!) && !rings.slice(1).some((h) => pointInRing(p, h));

/**
 * A point inside a polygon: its centroid when that lies inside, else the
 * middle of the widest span a horizontal line through the centroid cuts.
 */
function pointOnPolygon(rings: readonly Position[][]): Position {
  const c = ringCentroid(rings[0]!);
  if (inPolygon([c.x, c.y], rings)) return [c.x, c.y];
  const xs: number[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i] as [number, number];
      const [x1, y1] = ring[i + 1] as [number, number];
      if (y0 > c.y !== y1 > c.y) xs.push(x0 + ((c.y - y0) * (x1 - x0)) / (y1 - y0));
    }
  }
  xs.sort((a, b) => a - b);
  let best: Position = rings[0]![0]!;
  let width = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1]! - xs[i]! > width) {
      width = xs[i + 1]! - xs[i]!;
      best = [(xs[i]! + xs[i + 1]!) / 2, c.y];
    }
  }
  return best;
}

/**
 * One point that stands for a geometry, for a marker: a point itself; the
 * middle vertex of a line; for polygons, a point inside the largest one.
 * Null for an empty geometry.
 */
export function representativePoint(geometry: Geometry): Point | null {
  const at = (p: Position | undefined): Point | null =>
    p === undefined ? null : { type: "Point", coordinates: [p[0]!, p[1]!] };
  switch (geometry.type) {
    case "Point":
      return at(geometry.coordinates);
    case "MultiPoint":
      return at(geometry.coordinates[0]);
    case "LineString":
      return at(geometry.coordinates[Math.floor(geometry.coordinates.length / 2)]);
    case "MultiLineString": {
      const line = geometry.coordinates[0] ?? [];
      return at(line[Math.floor(line.length / 2)]);
    }
    case "Polygon":
    case "MultiPolygon": {
      const polygons = polygonsOf(geometry).filter((p) => (p[0]?.length ?? 0) >= 4);
      if (polygons.length === 0) return null;
      const largest = polygons.reduce((a, b) =>
        Math.abs(ringCentroid(b[0]!).area) > Math.abs(ringCentroid(a[0]!).area) ? b : a,
      );
      return at(pointOnPolygon(largest));
    }
    case "GeometryCollection": {
      const polygonal = geometry.geometries.find(
        (g) => g.type === "Polygon" || g.type === "MultiPolygon",
      );
      const first = polygonal ?? geometry.geometries[0];
      return first === undefined ? null : representativePoint(first);
    }
  }
}

/** Whether a value is a position in range: finite longitude −180..180 and latitude −90..90. */
const inRange = (p: unknown): p is Position =>
  Array.isArray(p) &&
  p.length >= 2 &&
  typeof p[0] === "number" &&
  typeof p[1] === "number" &&
  Math.abs(p[0]) <= 180 &&
  Math.abs(p[1]) <= 90;

const ringInRange = (ring: unknown) =>
  Array.isArray(ring) && ring.length >= 4 && ring.every(inRange);
const polygonInRange = (rings: unknown) =>
  Array.isArray(rings) && rings.length > 0 && rings.every(ringInRange);

/**
 * A polygon or multi-polygon a publisher drew, as it is, when every ring has
 * at least four positions in range; null otherwise (a point, a line, an
 * out-of-range or collapsed ring), so a record with a bad shape is rejected
 * rather than stored.
 */
export function polygonalGeometry(value: unknown): Polygon | MultiPolygon | null {
  if (typeof value !== "object" || value === null) return null;
  const { type, coordinates } = value as { type?: unknown; coordinates?: unknown };
  if (type === "Polygon" && polygonInRange(coordinates)) {
    return { type, coordinates: coordinates as Position[][] };
  }
  if (
    type === "MultiPolygon" &&
    Array.isArray(coordinates) &&
    coordinates.length > 0 &&
    coordinates.every(polygonInRange)
  ) {
    return { type, coordinates: coordinates as Position[][][] };
  }
  return null;
}

/** A point the publisher placed, when it is in range; null otherwise. */
export function pointGeometry(value: unknown): Point | null {
  if (typeof value !== "object" || value === null) return null;
  const { type, coordinates } = value as { type?: unknown; coordinates?: unknown };
  return type === "Point" && inRange(coordinates)
    ? { type, coordinates: [coordinates[0]!, coordinates[1]!] }
    : null;
}

/** The tolerance, in degrees, derived alert shapes are simplified to: about 500 m. */
export const DERIVED_SHAPE_TOLERANCE_DEG = 0.005;

/**
 * A shape a publisher gives for an area its alerts name only by code (an NWS
 * zone, a MeteoAlarm region), as a polygon or multi-polygon every position of
 * which is in range, simplified. Null when it is neither, any position is out
 * of range, or nothing is left of it: that area then keeps its codes only.
 */
export function derivedShape(value: unknown, toleranceDeg: number): Polygon | MultiPolygon | null {
  const geometry = polygonalGeometry(value);
  if (geometry === null) return null;
  const simplified = simplifyGeometry(geometry, toleranceDeg);
  return simplified?.type === "Polygon" || simplified?.type === "MultiPolygon" ? simplified : null;
}
