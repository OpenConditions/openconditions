import type { GeoJsonGeometry } from "@openconditions/core";

/**
 * Deterministic geometry screen for a crowd report or a vote, run AFTER
 * signature + grant verification and BEFORE landing. The kernel geometry
 * schema checks the shape; this layer also checks the coordinate VALUES:
 * exactly two ordinates, finite and inside WGS84 range. The time window and
 * the nonce are the claim's own rules (`landClaim`).
 */

export type PlausibilityReason =
  | "geometry_empty"
  | "geometry_malformed"
  | "geometry_not_finite"
  | "geometry_not_point"
  | "geometry_out_of_range";

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

  const visitGeometry = (value: GeoJsonGeometry): void => {
    const geom = value as { coordinates?: unknown; geometries?: GeoJsonGeometry[] };
    if (Array.isArray(geom.geometries)) {
      for (const sub of geom.geometries) visitGeometry(sub);
    } else {
      walk(geom.coordinates);
    }
  };
  visitGeometry(geometry);
  return scan;
}

/**
 * A v1 position: EXACTLY two finite-typed numbers `[lon, lat]`. v1 is 2D and the
 * record tables' `geom` columns are 2D, so a 3-ordinate `[lon, lat, alt]` position is
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
 * The geometry screen, shared by the report landing and the optional
 * sub-claim vote geometry. Returns the `geometry_*` reasons (empty = valid). When
 * `opts.requireType` is set and the geometry's `type` differs, the type
 * requirement short-circuits with `geometry_not_point` BEFORE the value scan —
 * a non-Point is rejected outright, not tallied.
 */
export function checkGeometryPlausibility(
  geometry: GeoJsonGeometry,
  opts?: { requireType?: string },
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
