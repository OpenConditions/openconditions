import { createHash } from "node:crypto";
import type { GeoJsonGeometry, Observation } from "./model.js";

/**
 * Canonical identity for the commons: `canonicalId` is exact, source-stable
 * RECORD identity (collapses byte-different resupplies of the same upstream
 * record, never two independent witnesses).
 */

export interface CanonicalIdentityParts {
  namespace: string;
  recordId: string;
}

const METERS_PER_DEG_LAT = 111_320;

function sha256Hex(parts: string[]): string {
  // JSON.stringify of an array of strings is byte-deterministic and free of
  // separator ambiguity ("a:b"+"c" vs "a"+"b:c" must not collide).
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

export function normalizeNamespace(ns: string): string {
  // The final NFC pass keeps the function idempotent: lowercasing a decomposed
  // sequence can produce a pair that composes to a new precomposed character.
  const normalized = ns.trim().normalize("NFC").toLowerCase().normalize("NFC");
  if (normalized === "") {
    throw new TypeError("namespace must not be empty after normalization");
  }
  return normalized;
}

/** Default extraction: an observation namespaces on its source id. */
export function canonicalIdentityParts(obs: Observation): CanonicalIdentityParts {
  return { namespace: normalizeNamespace(obs.source), recordId: obs.id };
}

export function canonicalId(obs: Observation): string;
export function canonicalId(parts: CanonicalIdentityParts): string;
export function canonicalId(input: Observation | CanonicalIdentityParts): string {
  const parts = "namespace" in input ? input : canonicalIdentityParts(input);
  if (typeof parts.namespace !== "string" || typeof parts.recordId !== "string") {
    throw new TypeError("canonicalId requires string namespace and recordId");
  }
  return sha256Hex([normalizeNamespace(parts.namespace), parts.recordId]);
}

/**
 * Arithmetic mean of all positions (vertex mean, NOT area-weighted): the
 * stable cheap choice for a quantized key.
 */
export function centroid(geometry: GeoJsonGeometry): [number, number] {
  let sumLon = 0;
  let sumLat = 0;
  let count = 0;
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      sumLon += c[0];
      sumLat += c[1];
      count++;
      return;
    }
    for (const x of c) walk(x);
  };
  const g = geometry as { coordinates?: unknown; geometries?: GeoJsonGeometry[] };
  if (Array.isArray(g.geometries)) {
    for (const sub of g.geometries) {
      walk((sub as { coordinates?: unknown }).coordinates);
    }
  } else {
    walk(g.coordinates);
  }
  if (count === 0) {
    throw new TypeError("geometry has no positions");
  }
  return [sumLon / count, sumLat / count];
}

/**
 * Snap to an equatorial-scaled grid: longitude cells shrink toward the poles,
 * accepted for a starting quantization. The cell string is the integer
 * (lon, lat) cell indices.
 */
export function gridCell([lon, lat]: [number, number], gridMeters: number): string {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new TypeError("gridCell requires finite coordinates");
  }
  const step = gridMeters / METERS_PER_DEG_LAT;
  return `${Math.floor(lon / step)}:${Math.floor(lat / step)}`;
}

/**
 * Coarse geographic area bucket for per-area anti-abuse accounting (e.g. "at
 * most N reports per key per ~1km area per minute"). An equal-intent substitute
 * for H3 cell bucketing built on the SAME quantization as {@link gridCell} —
 * OpenConditions deliberately carries no H3 dependency, and any consumer only
 * needs "nearby points share a bucket", not H3's hierarchy. The cell function
 * is a swappable seam: replacing this with an H3 index later only changes the
 * opaque cell strings.
 *
 * Same TypeError guard and known limitations as {@link gridCell} (equatorial-
 * scaled longitude step, no antimeridian wrap).
 */
export function coarseCell(lon: number, lat: number, meters = 1000): string {
  return gridCell([lon, lat], meters);
}

const HAS_ZONE_DESIGNATOR = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
// The string must start with the ISO calendar-date shape, optionally followed by
// a `T` time part. This rejects locale/legacy formats ("07/10/2026",
// "Fri Jul 10 2026", "July 10, 2026") and expanded ±YYYYYY years before they
// reach V8's lenient, timezone-dependent legacy Date.parse path — that fallback
// would make the result host-timezone-dependent and non-deterministic.
const ISO_CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}(?:T|$)/;

/**
 * Parse an ISO calendar-date string to epoch milliseconds under the canonical
 * ISO-shape + UTC-pinning rule: the string must start with the ISO
 * calendar-date shape, an offset-less datetime is pinned to UTC
 * (cross-instance determinism outweighs wall-clock correctness), and a
 * date-only string parses as UTC midnight per spec. Returns NaN for a
 * non-ISO-shaped or unparseable string — callers decide whether that throws or
 * is reported as a named incompatibility.
 */
export function isoUtcEpochMs(value: string): number {
  if (!ISO_CALENDAR_DATE.test(value)) {
    return Number.NaN;
  }
  const pinned = value.includes("T") && !HAS_ZONE_DESIGNATOR.test(value) ? `${value}Z` : value;
  return Date.parse(pinned);
}
