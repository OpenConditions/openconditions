/**
 * Reading CAP's own text encodings: the `references` list, and `polygon`
 * and `circle` areas, which CAP writes as `lat,lon` pairs where GeoJSON
 * writes `[lon, lat]`.
 */

/** One earlier message a CAP message refers to. */
export interface CapReference {
  sender: string;
  identifier: string;
  sent: string;
}

/**
 * `references`: space-separated `sender,identifier,sent` triples. An entry
 * without all three parts is not a reference and is skipped.
 */
export function capReferences(text: string): CapReference[] {
  return text
    .trim()
    .split(/\s+/)
    .flatMap((entry) => {
      const [sender, identifier, sent, ...rest] = entry.split(",");
      return sender && identifier && sent && rest.length === 0
        ? [{ sender, identifier, sent }]
        : [];
    });
}

type Position = [number, number];

function pair(point: string): Position | null {
  const [lat, lon, ...rest] = point.split(",").map(Number);
  if (rest.length > 0 || lat === undefined || lon === undefined) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}

/**
 * A CAP `polygon` as the exterior rings of a GeoJSON polygon: one ring, or
 * two when the polygon crosses the antimeridian, where it is split as
 * `capCircle` splits a circle. CAP requires the first and last pair to be
 * equal and at least four pairs; a ring that breaks either rule, or holds a
 * pair that is not a coordinate, is null rather than repaired.
 */
export function capPolygon(text: string): Position[][] | null {
  const ring = text.trim().split(/\s+/).map(pair);
  if (ring.length < 4 || ring.some((p) => p === null)) return null;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) return null;
  const open = (ring as Position[]).slice(0, -1);
  const unwrapped: Position[] = [open[0]!];
  for (const [x, y] of open.slice(1)) {
    const prev = unwrapped[unwrapped.length - 1]![0];
    unwrapped.push([x + 360 * Math.round((prev - x) / 360), y]);
  }
  return unwrapped.every(([x]) => x >= -180 && x <= 180)
    ? [ring as Position[]]
    : antimeridianSplit(unwrapped);
}

const EARTH_RADIUS_KM = 6371.0088;

/**
 * The part of a ring (open, without the closing point) on one side of the
 * meridian `edge`: Sutherland–Hodgman against a single line. A concave ring
 * that leaves and re-enters that side keeps a zero-width seam along the
 * meridian instead of falling into several rings.
 */
function clip(ring: readonly Position[], edge: number, west: boolean): Position[] {
  const inside = (p: Position) => (west ? p[0] <= edge : p[0] >= edge);
  const cross = (a: Position, b: Position): Position => [
    edge,
    a[1] + ((b[1] - a[1]) * (edge - a[0])) / (b[0] - a[0]),
  ];
  const out: Position[] = [];
  ring.forEach((p, i) => {
    const prev = ring[(i + ring.length - 1) % ring.length]!;
    if (inside(p)) {
      if (!inside(prev)) out.push(cross(prev, p));
      out.push(p);
    } else if (inside(prev)) {
      out.push(cross(prev, p));
    }
  });
  return out;
}

const round = (d: number) => Math.round(d * 1e6) / 1e6;
const closed = (ring: readonly Position[]): Position[] =>
  [...ring, ring[0]!].map(([x, y]) => [round(x), round(y)]);

/**
 * An open ring whose longitudes run continuously past ±180 (no jump between
 * neighbours), split at the antimeridian into a western and an eastern ring,
 * both closed and within range.
 */
function antimeridianSplit(ring: readonly Position[]): Position[][] {
  const shift = ring.some((p) => p[0] < -180) ? 360 : 0;
  const shifted = ring.map(([x, y]): Position => [x + shift, y]);
  const east = clip(shifted, 180, false).map(([x, y]): Position => [x - 360, y]);
  return [closed(clip(shifted, 180, true)), closed(east)];
}

/**
 * A CAP `circle` (`lat,lon radius`, radius in kilometres) as a GeoJSON
 * polygon of `vertices` points on the circle. GeoJSON has no circle, so the
 * result is derived geometry; a zero radius is a point. A circle across the
 * antimeridian is split there into two polygons, as RFC 7946 asks, so no
 * ring wraps the long way round the globe.
 */
export function capCircle(
  text: string,
  vertices = 32,
):
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] }
  | { type: "Point"; coordinates: Position }
  | null {
  const [centre, radius, ...rest] = text.trim().split(/\s+/);
  const c = centre === undefined ? null : pair(centre);
  const km = Number(radius);
  if (c === null || rest.length > 0 || !Number.isFinite(km) || km < 0) return null;
  if (km === 0) return { type: "Point", coordinates: c };
  const [lon, lat] = c.map((d) => (d * Math.PI) / 180) as Position;
  const angular = km / EARTH_RADIUS_KM;
  const ring: Position[] = [];
  for (let i = 0; i < vertices; i++) {
    const bearing = (2 * Math.PI * i) / vertices;
    const lat2 = Math.asin(
      Math.sin(lat) * Math.cos(angular) + Math.cos(lat) * Math.sin(angular) * Math.cos(bearing),
    );
    const lon2 =
      lon +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(lat),
        Math.cos(angular) - Math.sin(lat) * Math.sin(lat2),
      );
    ring.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  if (ring.every(([x]) => x >= -180 && x <= 180)) {
    return { type: "Polygon", coordinates: [closed(ring)] };
  }
  return { type: "MultiPolygon", coordinates: antimeridianSplit(ring).map((r) => [r]) };
}
