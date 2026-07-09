import {
  BinaryEncoder,
  LocationReferencePoint,
  Offsets,
  RawLineLocationReference,
} from "openlr-js";

// openlr-js does not re-export its FunctionalRoadClass / FormOfWay enums from
// its public entrypoint, so we recover the exact parameter types straight from
// the public `LocationReferencePoint.fromValues` signature instead of reaching
// into the library's build layout. Both are numeric enums at runtime, so the
// numeric FRC/FOW values we compute cast cleanly onto these param types.
type FromValuesParams = Parameters<typeof LocationReferencePoint.fromValues>;
type FrcParam = FromValuesParams[1];
type FowParam = FromValuesParams[2];

/** Hard cap on distance-to-next-point, per the OpenLR whitepaper v1.5 Rule 1. */
const MAX_DNP_METERS = 15_000;
/** Bearing is derived from the geometry roughly this far past (or before, for
 * the last LRP) each location reference point. */
const BEARING_SAMPLE_METERS = 20;
const EARTH_RADIUS_METERS = 6_371_000;

type LonLat = [number, number];

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Great-circle distance between two [lon, lat] points, in metres. */
function geodesicDistance(a: LonLat, b: LonLat): number {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing (forward azimuth) from `a` to `b`, in degrees, 0-360 clockwise from north. */
function initialBearing(a: LonLat, b: LonLat): number {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const dLon = toRadians(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  const theta = Math.atan2(y, x);
  return (toDegrees(theta) + 360) % 360;
}

function interpolate(a: LonLat, b: LonLat, t: number): LonLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

interface DensePoint {
  point: LonLat;
  /** Cumulative geodesic distance along the (possibly-densified) polyline from its start, in metres. */
  cumDistance: number;
}

/**
 * Walks `coords` and returns a densified polyline plus the indices (into that
 * dense array) chosen as location reference points: always the two ends, plus
 * an interpolated intermediate point whenever the running distance since the
 * last LRP would otherwise exceed {@link MAX_DNP_METERS}. A single input edge
 * longer than the cap can produce several intermediate LRPs.
 */
function buildDensePolyline(coords: LonLat[]): { dense: DensePoint[]; lrpIndices: number[] } {
  const dense: DensePoint[] = [{ point: coords[0]!, cumDistance: 0 }];
  const lrpIndices = [0];
  let distSinceLastLrp = 0;

  for (let i = 1; i < coords.length; i++) {
    const edgeStart = coords[i - 1]!;
    const edgeEnd = coords[i]!;
    const edgeLen = geodesicDistance(edgeStart, edgeEnd);
    let consumed = 0;

    while (edgeLen - consumed > 0 && distSinceLastLrp + (edgeLen - consumed) > MAX_DNP_METERS) {
      const neededOnEdge = MAX_DNP_METERS - distSinceLastLrp;
      const t = (consumed + neededOnEdge) / edgeLen;
      const splitPoint = interpolate(edgeStart, edgeEnd, t);
      dense.push({
        point: splitPoint,
        cumDistance: dense[dense.length - 1]!.cumDistance + neededOnEdge,
      });
      lrpIndices.push(dense.length - 1);
      consumed += neededOnEdge;
      distSinceLastLrp = 0;
    }

    const remaining = edgeLen - consumed;
    dense.push({ point: edgeEnd, cumDistance: dense[dense.length - 1]!.cumDistance + remaining });
    distSinceLastLrp += remaining;
  }

  const lastIndex = dense.length - 1;
  if (lrpIndices[lrpIndices.length - 1] !== lastIndex) {
    lrpIndices.push(lastIndex);
  }

  return { dense, lrpIndices };
}

/** Interpolated [lon, lat] at `targetDistance` metres along `dense` (clamped to its range). */
function pointAtCumDistance(dense: DensePoint[], targetDistance: number): LonLat {
  const total = dense[dense.length - 1]!.cumDistance;
  const clamped = Math.max(0, Math.min(targetDistance, total));
  for (let i = 1; i < dense.length; i++) {
    const prev = dense[i - 1]!;
    const curr = dense[i]!;
    if (clamped <= curr.cumDistance) {
      const span = curr.cumDistance - prev.cumDistance;
      const t = span > 0 ? (clamped - prev.cumDistance) / span : 0;
      return interpolate(prev.point, curr.point, t);
    }
  }
  return dense[dense.length - 1]!.point;
}

/**
 * Bearing for the LRP at `lrpIndices[i]`: for every LRP but the last, the
 * direction of travel over the first ~20 m of geometry after it; for the last
 * LRP, the direction of travel over the ~20 m of geometry arriving into it
 * (OpenLR's convention — a bearing is always the direction of travel, not a
 * "look-back" reversal).
 */
function bearingAtLrp(dense: DensePoint[], lrpIndices: number[], i: number): number {
  const idx = lrpIndices[i]!;
  const cum = dense[idx]!.cumDistance;
  const isLast = i === lrpIndices.length - 1;

  if (!isLast) {
    const nextCum = dense[lrpIndices[i + 1]!]!.cumDistance;
    const sample = pointAtCumDistance(dense, Math.min(cum + BEARING_SAMPLE_METERS, nextCum));
    return initialBearing(dense[idx]!.point, sample);
  }

  const prevCum = dense[lrpIndices[i - 1]!]!.cumDistance;
  const sample = pointAtCumDistance(dense, Math.max(cum - BEARING_SAMPLE_METERS, prevCum));
  return initialBearing(sample, dense[idx]!.point);
}

export interface EncodeOpenlrLineInput {
  /** Ordered geometry vertices as [lon, lat] pairs (WGS84), at least two. */
  coords: LonLat[];
  /** Functional Road Class, 0 (highest) to 7 (lowest), per the OpenLR spec. */
  frc: number;
  /** Form of Way per the OpenLR enum (0 undefined .. 7 other). */
  fow: number;
}

/**
 * Encode a line geometry + road attributes into an OpenLR base64 line
 * location descriptor.
 *
 * This is the minimal "logical layer" described in the OpenLR whitepaper: LRPs
 * are placed at the geometry's two ends plus an intermediate point whenever
 * the distance to the next LRP would otherwise exceed the 15,000 m cap (Rule
 * 1). FRC/FOW are constant for the whole line (a segment is always one way
 * with one classification); bearing is sampled from the first ~20 m of
 * geometry after each LRP (or the ~20 m arriving into the last one); DNP is
 * the geodesic length of geometry to the next LRP. The binary packing itself
 * is delegated entirely to `openlr-js` (physical layer).
 *
 * Known limitation: a spec-complete encoder additionally validates that the
 * shortest path between consecutive LRPs actually reproduces the input
 * geometry, inserting extra "deviation" LRPs where a decoder's shortest-path
 * search would otherwise shortcut across dense parallel roads. That requires
 * a router and is deliberately not implemented here — for motorway/trunk/
 * primary segments under 15 km (the road_segment spine's usual case) a
 * shortcut is rare. If it becomes a problem in practice, the escape hatches
 * are (a) shrink {@link MAX_DNP_METERS} to force more intermediate LRPs, or
 * (b) shell out to a shortest-path-validating reference encoder.
 */
export function encodeOpenlrLine(input: EncodeOpenlrLineInput): string {
  const { coords, frc, fow } = input;
  if (coords.length < 2) {
    throw new Error("encodeOpenlrLine requires at least two coordinates");
  }

  const { dense, lrpIndices } = buildDensePolyline(coords);
  const frcValue = frc as FrcParam;
  const fowValue = fow as FowParam;

  const points = lrpIndices.map((idx, i) => {
    const isLast = i === lrpIndices.length - 1;
    const bearing = bearingAtLrp(dense, lrpIndices, i);
    const distanceToNext = isLast
      ? 0
      : dense[lrpIndices[i + 1]!]!.cumDistance - dense[idx]!.cumDistance;
    const [lon, lat] = dense[idx]!.point;

    return LocationReferencePoint.fromValues(
      i + 1,
      frcValue,
      fowValue,
      lon,
      lat,
      bearing,
      distanceToNext,
      isLast ? null : frcValue,
      isLast
    );
  });

  const raw = RawLineLocationReference.fromLineValues(
    "openconditions",
    points,
    Offsets.fromValues(0, 0)
  );
  const locationReference = new BinaryEncoder().encodeDataFromRLR(raw);

  if (!locationReference.isValid()) {
    throw new Error(
      `OpenLR encode failed (return code ${locationReference.getReturnCode() ?? "null"})`
    );
  }

  const data = locationReference.getLocationReferenceData();
  if (data === null) {
    throw new Error("OpenLR encode produced no binary data");
  }

  return data.toString("base64");
}
