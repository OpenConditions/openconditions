import type { Geometry, Position } from "geojson";

/**
 * A geometry in the form RFC 7946 asks a GeoJSON producer for: polygon rings
 * follow the right-hand rule (exterior rings counterclockwise, holes
 * clockwise; section 3.1.6, a MUST), and a line or polygon that crosses the
 * antimeridian is cut in two there (section 3.1.9), so a LineString may come
 * back as a MultiLineString and a Polygon as a MultiPolygon. A geometry
 * already in that form is returned as the same object.
 *
 * An edge whose longitudes lie more than 180° apart is read as crossing the
 * antimeridian the short way, as every source drawing such a shape means it;
 * an edge between two points on the antimeridian itself never crosses it. A
 * ring that runs once round a pole cannot be cut into a ring on either side,
 * so it is left as it is.
 */
export function rfc7946Geometry(geometry: Geometry): Geometry;
export function rfc7946Geometry(geometry: Geometry | null): Geometry | null;
export function rfc7946Geometry(geometry: Geometry | null): Geometry | null {
  if (geometry === null) return null;
  switch (geometry.type) {
    case "LineString": {
      const parts = cutLine(geometry.coordinates);
      if (parts.length === 1 && parts[0] === geometry.coordinates) return geometry;
      return parts.length === 1
        ? { ...geometry, coordinates: parts[0]! }
        : { ...geometry, type: "MultiLineString", coordinates: parts };
    }
    case "MultiLineString": {
      const parts = geometry.coordinates.map(cutLine);
      if (parts.every((p, i) => p.length === 1 && p[0] === geometry.coordinates[i])) {
        return geometry;
      }
      return { ...geometry, coordinates: parts.flat() };
    }
    case "Polygon": {
      const polygons = polygonParts(geometry.coordinates);
      if (polygons.length === 1 && polygons[0] === geometry.coordinates) return geometry;
      return polygons.length === 1
        ? { ...geometry, coordinates: polygons[0]! }
        : { ...geometry, type: "MultiPolygon", coordinates: polygons };
    }
    case "MultiPolygon": {
      const parts = geometry.coordinates.map(polygonParts);
      if (parts.every((p, i) => p.length === 1 && p[0] === geometry.coordinates[i])) {
        return geometry;
      }
      return { ...geometry, coordinates: parts.flat() };
    }
    case "GeometryCollection": {
      const members = geometry.geometries.map((g) => rfc7946Geometry(g));
      return members.every((g, i) => g === geometry.geometries[i])
        ? geometry
        : { ...geometry, geometries: members };
    }
    default:
      return geometry;
  }
}

const onAntimeridian = (p: Position) => Math.abs(p[0]!) === 180;

/** Whether the edge from `a` to `b` crosses the antimeridian. */
function crosses(a: Position, b: Position): boolean {
  return Math.abs(b[0]! - a[0]!) > 180 && !(onAntimeridian(a) && onAntimeridian(b));
}

/**
 * Where the edge from `a` to `b`, which crosses the antimeridian, meets it:
 * the point at longitude `edge` (180 or -180, on `a`'s side), interpolated
 * along the edge as GeoJSON draws it, a straight line in longitude and
 * latitude.
 */
function crossing(a: Position, b: Position, edge: number): Position {
  const bx = b[0]! + (edge > 0 ? 360 : -360);
  const t = (edge - a[0]!) / (bx - a[0]!);
  const at = (i: number) => a[i]! + t * (b[i]! - a[i]!);
  return a.length > 2 && b.length > 2 ? [edge, at(1), at(2)] : [edge, at(1)];
}

/** A line cut at each antimeridian crossing; the line itself when it crosses none. */
function cutLine(line: Position[]): Position[][] {
  if (!line.some((p, i) => i > 0 && crosses(line[i - 1]!, p))) return [line];
  const parts: Position[][] = [];
  let part: Position[] = [line[0]!];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    if (crosses(a, b)) {
      const edge = a[0]! > b[0]! ? 180 : -180;
      const at = crossing(a, b, edge);
      if (a[0] !== edge) part.push(at);
      parts.push(part);
      part = b[0] === -edge ? [] : [[-edge, ...at.slice(1)]];
    }
    part.push(b);
  }
  parts.push(part);
  return parts.filter((p) => p.length >= 2);
}

/** Twice the signed area of a closed ring, positive when it runs counterclockwise. */
function signedArea(ring: readonly Position[]): number {
  let sum = 0;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1]!;
    const b = ring[i]!;
    sum += a[0]! * b[1]! - b[0]! * a[1]!;
  }
  return sum;
}

/** A polygon's rings wound by the right-hand rule; the polygon itself when they already are. */
function rewound(polygon: Position[][]): Position[][] {
  const out = polygon.map((ring, i) => {
    const area = signedArea(ring);
    return (i === 0 ? area < 0 : area > 0) ? ring.toReversed() : ring;
  });
  return out.every((ring, i) => ring === polygon[i]) ? polygon : out;
}

/**
 * A ring's vertex with its longitude unwrapped: `x` runs on past ±180 without
 * the jump a crossing edge makes, and is `p`'s longitude plus `k` turns.
 */
interface Vertex {
  x: number;
  k: number;
  p: Position;
}

/** The longitude step from `a` to `b` in turns of 360°, as `crosses` reads the edge. */
function turn(a: Position, b: Position): number {
  if (onAntimeridian(a) && onAntimeridian(b)) return (a[0]! - b[0]!) / 360;
  if (!crosses(a, b)) return 0;
  return a[0]! > b[0]! ? 1 : -1;
}

/** A closed ring unwrapped from `k0` turns; null when it runs round a pole. */
function unwrap(ring: readonly Position[], k0: number): Vertex[] | null {
  let k = k0;
  const out: Vertex[] = [{ x: ring[0]![0]! + 360 * k, k, p: ring[0]! }];
  for (let i = 1; i < ring.length; i++) {
    k += turn(ring[i - 1]!, ring[i]!);
    out.push({ x: ring[i]![0]! + 360 * k, k, p: ring[i]! });
  }
  return k === k0 ? out.slice(0, -1) : null;
}

/**
 * The part of an unwrapped open ring west (or east) of x = 180, by
 * Sutherland–Hodgman against that one line. A concave ring that leaves and
 * comes back keeps a zero-width seam along the antimeridian rather than
 * falling into several rings.
 */
function clip(ring: readonly Vertex[], west: boolean): Vertex[] {
  const inside = (v: Vertex) => (west ? v.x <= 180 : v.x >= 180);
  const cut = (a: Vertex, b: Vertex): Vertex => {
    const t = (180 - a.x) / (b.x - a.x);
    const at = (i: number) => a.p[i]! + t * (b.p[i]! - a.p[i]!);
    const p = a.p.length > 2 && b.p.length > 2 ? [180, at(1), at(2)] : [180, at(1)];
    return { x: 180, k: 0, p };
  };
  const out: Vertex[] = [];
  ring.forEach((v, i) => {
    const prev = ring[(i + ring.length - 1) % ring.length]!;
    if (inside(v)) {
      if (!inside(prev)) out.push(cut(prev, v));
      out.push(v);
    } else if (inside(prev)) {
      out.push(cut(prev, v));
    }
  });
  return out;
}

/**
 * An unwrapped open ring's vertices as positions on the side whose longitudes
 * are `offset` turns from their unwrapped ones, closed; null when fewer than
 * three distinct positions remain. A vertex keeps its own coordinates where it
 * is not moved, so no rounding creeps in.
 */
function placed(ring: readonly Vertex[], offset: number): Position[] | null {
  const out: Position[] = [];
  for (const v of ring) {
    const p = v.k === offset ? v.p : [v.p[0]! + 360 * (v.k - offset), ...v.p.slice(1)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  while (out.length > 1 && out[0]![0] === out.at(-1)![0] && out[0]![1] === out.at(-1)![1]) {
    out.pop();
  }
  return out.length >= 3 ? [...out, out[0]!] : null;
}

/**
 * A polygon as RFC 7946 has it written: the polygon itself when it already
 * is, else rewound, and cut in two where it crosses the antimeridian.
 */
function polygonParts(polygon: Position[][]): Position[][][] {
  const ringCrosses = (ring: Position[]) => ring.some((p, i) => i > 0 && crosses(ring[i - 1]!, p));
  if (!polygon.some(ringCrosses)) return [rewound(polygon)];
  let rings: Vertex[][] = [];
  for (const [i, ring] of polygon.entries()) {
    const start = i === 0 ? 0 : Math.round((rings[0]![0]!.x - ring[0]![0]!) / 360);
    const unwrapped = unwrap(ring, start);
    if (!unwrapped) return [polygon];
    rings.push(unwrapped);
  }
  const west = () => rings.reduce((min, ring) => ring.reduce((m, v) => Math.min(m, v.x), min), 0);
  if (west() < -180) {
    rings = rings.map((ring) => ring.map((v) => ({ ...v, x: v.x + 360, k: v.k + 1 })));
    if (west() < -180) return [polygon];
  }
  const side = (westOf: boolean): Position[][] | null => {
    const parts = rings.map((ring) => placed(clip(ring, westOf), westOf ? 0 : 1));
    return parts[0] ? parts.filter((r): r is Position[] => r !== null) : null;
  };
  return [side(true), side(false)].filter((p): p is Position[][] => p !== null).map(rewound);
}
