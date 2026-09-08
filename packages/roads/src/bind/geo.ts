/**
 * Planar/haversine geometry primitives for binding events to directed road
 * segments: bearings, polyline length and sampling, point-to-polyline
 * projection, and bounding boxes. Pure, dependency-free, Docker-free — the
 * candidate search, scoring and path steps all build on these.
 *
 * Distances come from `haversineMeters` (@openconditions/core); the projection
 * uses a local equirectangular plane, which is accurate at the tens-of-metres
 * scale these helpers work at.
 */

import { haversineMeters } from "@openconditions/core";

export type LngLat = [number, number];

const R = 6_371_000;
const METERS_PER_DEG_LAT = 111_320;
const MIN_LAT_COS = 0.1;

const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;

/** Initial bearing from `a` to `b`, degrees clockwise from north in [0, 360). */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLng = toRad(b[0] - a[0]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest angle between two bearings, in [0, 180]. */
export function bearingDelta(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/** Great-circle length of the polyline, in metres. */
export function polylineLengthM(coords: LngLat[]): number {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += haversineMeters(coords[i - 1]!, coords[i]!);
  return m;
}

/**
 * Points along the polyline at most `maxSpacingM` apart; original vertices
 * kept. Throws on a non-positive or NaN spacing, which would otherwise ask for
 * an unbounded number of samples.
 */
export function densify(coords: LngLat[], maxSpacingM: number): LngLat[] {
  if (!(maxSpacingM > 0)) throw new RangeError("maxSpacingM must be a positive number");
  if (coords.length <= 1) return coords.slice();
  const out: LngLat[] = [coords[0]!];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    const steps = Math.max(1, Math.ceil(haversineMeters(a, b) / maxSpacingM));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

export interface Projection {
  point: LngLat;
  offsetM: number;
  /** 0..1 along the whole polyline (length-weighted). */
  fraction: number;
  segmentIndex: number;
  /** Bearing of the sub-segment the point projects onto. */
  bearing: number;
}

/** Local equirectangular projection around `lat0` for short-distance planar math. */
function planar(p: LngLat, lat0: number): [number, number] {
  const k = Math.cos(toRad(lat0));
  return [toRad(p[0]) * R * k, toRad(p[1]) * R];
}

/**
 * Nearest point on the polyline to `p`, with perpendicular offset,
 * along-fraction and local bearing. A single-vertex polyline has no direction,
 * so it reports that vertex at fraction 0 with bearing 0; an empty polyline
 * has no answer at all and throws.
 */
export function projectOntoPolyline(p: LngLat, coords: LngLat[]): Projection {
  if (coords.length === 0) throw new RangeError("polyline must have at least one vertex");
  if (coords.length === 1) {
    return {
      point: coords[0]!,
      offsetM: haversineMeters(p, coords[0]!),
      fraction: 0,
      segmentIndex: 0,
      bearing: 0,
    };
  }
  const lat0 = p[1];
  const planarP = planar(p, lat0);
  const total = polylineLengthM(coords);

  /** Projection onto the sub-segment ending at vertex `i`, `cum` metres in. */
  const onSegment = (i: number, cum: number): Projection => {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    const planarA = planar(a, lat0);
    const planarB = planar(b, lat0);
    const dx = planarB[0] - planarA[0];
    const dy = planarB[1] - planarA[1];
    const len2 = dx * dx + dy * dy;
    const t =
      len2 === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((planarP[0] - planarA[0]) * dx + (planarP[1] - planarA[1]) * dy) / len2)
          );
    const q: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const segLen = haversineMeters(a, b);
    return {
      point: q,
      offsetM: haversineMeters(p, q),
      fraction: total === 0 ? 0 : Math.min(1, (cum + segLen * t) / total),
      segmentIndex: i - 1,
      bearing: bearingDeg(a, b),
    };
  };

  let best = onSegment(1, 0);
  let cum = haversineMeters(coords[0]!, coords[1]!);
  for (let i = 2; i < coords.length; i++) {
    const candidate = onSegment(i, cum);
    if (candidate.offsetM < best.offsetM) best = candidate;
    cum += haversineMeters(coords[i - 1]!, coords[i]!);
  }
  return best;
}

/** Bounding box `[west, south, east, north]` covering every vertex. */
export function bboxOf(coords: LngLat[]): [number, number, number, number] {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [x, y] of coords) {
    w = Math.min(w, x);
    s = Math.min(s, y);
    e = Math.max(e, x);
    n = Math.max(n, y);
  }
  return [w, s, e, n];
}

/** Grow a bbox by `meters` on all four sides, widening longitude by latitude. */
export function expandBbox(
  b: [number, number, number, number],
  meters: number
): [number, number, number, number] {
  const dLat = meters / METERS_PER_DEG_LAT;
  const midLat = (b[1] + b[3]) / 2;
  const dLng = meters / (METERS_PER_DEG_LAT * Math.max(MIN_LAT_COS, Math.cos(toRad(midLat))));
  return [b[0] - dLng, b[1] - dLat, b[2] + dLng, b[3] + dLat];
}
