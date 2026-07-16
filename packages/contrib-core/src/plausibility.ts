import type { GeoJsonGeometry } from "@openconditions/core";
import type { ReportClaim } from "./types.js";

/**
 * Deterministic plausibility screen for a crowd report, run AFTER signature +
 * grant verification and BEFORE landing. PURE: the evaluation instant is an
 * input. Unlike the authenticity layer (`verifyReport`), this layer validates
 * the coordinate VALUES: finite and inside WGS84 range. It also bounds the
 * report's self-declared time to a sane window around the server clock and
 * re-checks the nonce shape. Kinematic/proximity plausibility and H3 rate
 * limiting are a later concern; this is the structural floor.
 */

export type PlausibilityReason =
  | "geometry_empty"
  | "geometry_malformed"
  | "geometry_not_finite"
  | "geometry_not_point"
  | "geometry_out_of_range"
  | "reported_at_invalid"
  | "reported_at_stale"
  | "reported_at_future"
  | "nonce_malformed";

export interface PlausibilityResult {
  ok: boolean;
  reasons: PlausibilityReason[];
}

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** Max age of a report relative to the server clock (24h). */
const MAX_PAST_MS = 24 * 60 * 60 * 1000;
/** Max clock skew a report may be ahead of the server (5 min). */
const MAX_FUTURE_MS = 5 * 60 * 1000;

interface GeometryScan {
  count: number;
  hasNonFinite: boolean;
  outOfRange: boolean;
}

/**
 * Walk every position in a GeoJSON geometry (Point through
 * GeometryCollection), tallying whether any coordinate is non-finite or outside
 * WGS84 range. A position is `[lon, lat, ...]`; only the first two ordinates are
 * range-checked (altitude is unconstrained), but all must be finite.
 */
function scanGeometry(geometry: GeoJsonGeometry): GeometryScan {
  const scan: GeometryScan = { count: 0, hasNonFinite: false, outOfRange: false };

  const visitPosition = (position: number[]): void => {
    scan.count += 1;
    for (const ordinate of position) {
      if (!Number.isFinite(ordinate)) scan.hasNonFinite = true;
    }
    const [lon, lat] = position;
    if (typeof lon === "number" && Number.isFinite(lon) && (lon < -180 || lon > 180)) {
      scan.outOfRange = true;
    }
    if (typeof lat === "number" && Number.isFinite(lat) && (lat < -90 || lat > 90)) {
      scan.outOfRange = true;
    }
  };

  const walk = (coordinates: unknown): void => {
    if (!Array.isArray(coordinates)) return;
    if (typeof coordinates[0] === "number") {
      visitPosition(coordinates as number[]);
      return;
    }
    for (const child of coordinates) walk(child);
  };

  const geom = geometry as { coordinates?: unknown; geometries?: GeoJsonGeometry[] };
  if (Array.isArray(geom.geometries)) {
    for (const sub of geom.geometries) walk((sub as { coordinates?: unknown }).coordinates);
  } else {
    walk(geom.coordinates);
  }
  return scan;
}

/**
 * A v1 position: EXACTLY two finite-typed numbers `[lon, lat]`. v1 is 2D and the
 * `observations.geom` column is 2D, so a 3-ordinate `[lon, lat, alt]` position is
 * rejected here as malformed (fast, before the DB) rather than silently dropping
 * the altitude at insert. Finiteness/range are checked separately by the scan.
 */
function isPosition(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number");
}

/** An array of ≥`min` positions (a Point/MultiPoint/LineString coordinate list). */
function isPositionArray(value: unknown, min: number): boolean {
  return Array.isArray(value) && value.length >= min && value.every(isPosition);
}

/** A linear ring: ≥4 positions, closed (first equals last in lon/lat). */
function isLinearRing(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 4 || !value.every(isPosition)) return false;
  const first = value[0] as number[];
  const last = value[value.length - 1] as number[];
  return first[0] === last[0] && first[1] === last[1];
}

function isRingArray(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1 && value.every(isLinearRing);
}

/**
 * Structural (arity/nesting/closure) validity of a GeoJSON geometry against its
 * DECLARED `type`. This is the guard that stops a signed claim whose coordinate
 * shape does not match its type — `{type:"Point", coordinates:[[..]]}`, a
 * one-position LineString, an unclosed Polygon ring — from passing the finite/
 * range scan and then crashing PostGIS's `ST_GeomFromGeoJSON` (which would
 * surface as a 500 and, because no row lands, bypass the per-key rate guard).
 * A type/coordinate mismatch is a malformed claim, rejected here at 422.
 */
function hasValidStructure(geometry: GeoJsonGeometry): boolean {
  const geom = geometry as { type?: string; coordinates?: unknown; geometries?: unknown };
  switch (geom.type) {
    case "Point":
      return isPosition(geom.coordinates);
    case "MultiPoint":
      return isPositionArray(geom.coordinates, 1);
    case "LineString":
      return isPositionArray(geom.coordinates, 2);
    case "MultiLineString":
      return (
        Array.isArray(geom.coordinates) &&
        geom.coordinates.length >= 1 &&
        geom.coordinates.every((line) => isPositionArray(line, 2))
      );
    case "Polygon":
      return isRingArray(geom.coordinates);
    case "MultiPolygon":
      return (
        Array.isArray(geom.coordinates) &&
        geom.coordinates.length >= 1 &&
        geom.coordinates.every(isRingArray)
      );
    case "GeometryCollection":
      return (
        Array.isArray(geom.geometries) &&
        geom.geometries.every((sub) => hasValidStructure(sub as GeoJsonGeometry))
      );
    default:
      return false;
  }
}

/**
 * Geometry-only slice of the plausibility screen, sharable by any path that
 * needs to validate a bare GeoJSON geometry (the full report landing and the
 * optional sub-claim vote geometry). Returns the `geometry_*` reasons in the
 * SAME order `checkPlausibility` emits them (empty = valid). When
 * `opts.requireType` is set and the geometry's `type` differs, the type
 * requirement short-circuits with `geometry_not_point` BEFORE the value scan —
 * a non-Point is rejected outright, not tallied.
 */
export function checkGeometryPlausibility(
  geometry: GeoJsonGeometry,
  opts?: { requireType?: string }
): PlausibilityReason[] {
  if (
    opts?.requireType !== undefined &&
    (geometry as { type?: string }).type !== opts.requireType
  ) {
    return ["geometry_not_point"];
  }

  const reasons: PlausibilityReason[] = [];
  // Structure first: a type/arity mismatch must fail as malformed BEFORE the
  // value scan (a mis-nested shape makes the finite/range tally meaningless).
  if (!hasValidStructure(geometry)) {
    reasons.push("geometry_malformed");
  }
  const scan = scanGeometry(geometry);
  if (scan.count === 0) reasons.push("geometry_empty");
  if (scan.hasNonFinite) reasons.push("geometry_not_finite");
  if (scan.outOfRange) reasons.push("geometry_out_of_range");
  return reasons;
}

export function checkPlausibility(claim: ReportClaim, now: string): PlausibilityResult {
  const reasons: PlausibilityReason[] = checkGeometryPlausibility(claim.geometry);

  const reportedMs = Date.parse(claim.reportedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(reportedMs) || !Number.isFinite(nowMs)) {
    reasons.push("reported_at_invalid");
  } else if (reportedMs < nowMs - MAX_PAST_MS) {
    reasons.push("reported_at_stale");
  } else if (reportedMs > nowMs + MAX_FUTURE_MS) {
    reasons.push("reported_at_future");
  }

  if (typeof claim.nonce !== "string" || !NONCE_PATTERN.test(claim.nonce)) {
    reasons.push("nonce_malformed");
  }

  return { ok: reasons.length === 0, reasons };
}
