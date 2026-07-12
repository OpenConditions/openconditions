import { createHash } from "node:crypto";
import type { ConditionEvent, GeoJsonGeometry, Observation } from "./model.js";

/**
 * Canonical identity for the commons: `canonicalId` is exact, source-stable
 * RECORD identity (collapses byte-different resupplies of the same upstream
 * record, never two independent witnesses), while `phenomenonFingerprint` is a
 * candidate-GENERATION key for "may describe the same real-world phenomenon"
 * (a match opens a typed space/time candidate set; it never merges
 * automatically). The two relations must never share a key, so they hash
 * differently-shaped part arrays.
 */

export interface CanonicalIdentityParts {
  namespace: string;
  recordId: string;
}

export interface FingerprintOptions {
  gridMeters?: number;
  typeDepth?: number;
  timeBucketSec?: number;
}

const DEFAULT_GRID_METERS = 100;
const DEFAULT_TYPE_DEPTH = 2;
const DEFAULT_TIME_BUCKET_SEC = 300;

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

/** Default extraction: crowd-origin rows namespace on the originating instance; feed rows on the source id. */
export function canonicalIdentityParts(obs: Observation): CanonicalIdentityParts {
  const namespace = obs.origin.kind === "crowd" && obs.instanceId ? obs.instanceId : obs.source;
  return { namespace: normalizeNamespace(namespace), recordId: obs.id };
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
 * Integer (lon, lat) cell indices on the equatorial-scaled grid. The single
 * quantization step both {@link gridCell} and the fingerprint neighborhood
 * build on: neighbors are enumerated as integer index offsets from this result,
 * never by re-quantizing offset coordinates (floating-point cancellation near
 * cell edges at large |lon| could otherwise skip or repeat a cell).
 */
function gridCellIndices([lon, lat]: [number, number], gridMeters: number): [number, number] {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new TypeError("gridCell requires finite coordinates");
  }
  const step = gridMeters / METERS_PER_DEG_LAT;
  return [Math.floor(lon / step), Math.floor(lat / step)];
}

function cellKey(x: number, y: number): string {
  return `${x}:${y}`;
}

/**
 * Snap to an equatorial-scaled grid: longitude cells shrink toward the poles,
 * accepted for a starting quantization (the tuning seam is FingerprintOptions).
 */
export function gridCell(position: [number, number], gridMeters: number): string {
  const [x, y] = gridCellIndices(position, gridMeters);
  return cellKey(x, y);
}

export function truncateType(domain: string, type: string, depth: number): string[] {
  // Domain and type stay separate hash-input elements so ("a/b","c") and
  // ("a","b/c") cannot collide.
  return depth <= 1 ? [domain] : [domain, type];
}

const HAS_ZONE_DESIGNATOR = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
// The string must start with the ISO calendar-date shape, optionally followed by
// a `T` time part. This rejects locale/legacy formats ("07/10/2026",
// "Fri Jul 10 2026", "July 10, 2026") and expanded ±YYYYYY years before they
// reach V8's lenient, timezone-dependent legacy Date.parse path — that fallback
// would make the fingerprint host-timezone-dependent and non-deterministic.
const ISO_CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}(?:T|$)/;

/**
 * Parse an ISO calendar-date string to epoch milliseconds under the canonical
 * ISO-shape + UTC-pinning rule shared by {@link timeBucket} and the phenomenon
 * matcher: the string must start with the ISO calendar-date shape, an
 * offset-less datetime is pinned to UTC (cross-instance determinism outweighs
 * wall-clock correctness), and a date-only string parses as UTC midnight per
 * spec. Returns NaN for a non-ISO-shaped or unparseable string — callers decide
 * whether that throws (fingerprinting) or is reported as a named
 * incompatibility (matching).
 */
export function isoUtcEpochMs(value: string): number {
  if (!ISO_CALENDAR_DATE.test(value)) {
    return Number.NaN;
  }
  const pinned = value.includes("T") && !HAS_ZONE_DESIGNATOR.test(value) ? `${value}Z` : value;
  return Date.parse(pinned);
}

export function timeBucket(validFrom: string | null | undefined, bucketSec: number): number {
  if (!validFrom) {
    throw new TypeError("timeBucket requires a validFrom timestamp");
  }
  const epochMs = isoUtcEpochMs(validFrom);
  if (!Number.isFinite(epochMs)) {
    throw new TypeError(
      `timeBucket requires a parseable ISO calendar date (YYYY-MM-DD, optionally with a T time part): ${validFrom}`
    );
  }
  return Math.floor(epochMs / 1000 / bucketSec);
}

interface ResolvedFingerprintOptions {
  gridMeters: number;
  typeDepth: number;
  timeBucketSec: number;
}

function resolveFingerprintOptions(opts: FingerprintOptions): ResolvedFingerprintOptions {
  const gridMeters = opts.gridMeters ?? DEFAULT_GRID_METERS;
  const typeDepth = opts.typeDepth ?? DEFAULT_TYPE_DEPTH;
  const timeBucketSec = opts.timeBucketSec ?? DEFAULT_TIME_BUCKET_SEC;
  if (!Number.isFinite(gridMeters) || gridMeters <= 0) {
    throw new TypeError("gridMeters must be a finite number > 0");
  }
  if (!Number.isFinite(timeBucketSec) || timeBucketSec <= 0) {
    throw new TypeError("timeBucketSec must be a finite number > 0");
  }
  if (typeDepth !== 1 && typeDepth !== 2) {
    throw new TypeError("typeDepth must be 1 or 2");
  }
  return { gridMeters, typeDepth, timeBucketSec };
}

function fingerprintDigest(
  cell: string,
  domain: string,
  type: string,
  typeDepth: number,
  bucket: number
): string {
  return sha256Hex([cell, ...truncateType(domain, type, typeDepth), String(bucket)]);
}

export function phenomenonFingerprint(evt: ConditionEvent, opts: FingerprintOptions = {}): string {
  if (evt.kind !== "event") {
    throw new TypeError(
      "phenomenonFingerprint is events-only: measurements carry no validFrom and would collapse distinct sensors onto one key"
    );
  }
  const { gridMeters, typeDepth, timeBucketSec } = resolveFingerprintOptions(opts);
  return fingerprintDigest(
    gridCell(centroid(evt.geometry), gridMeters),
    evt.domain,
    evt.type,
    typeDepth,
    timeBucket(evt.validFrom, timeBucketSec)
  );
}

/**
 * The fingerprints of the 3×3 spatial grid cells around the event's centroid,
 * crossed with the {t−1, t, t+1} time buckets — up to 27 DISTINCT fingerprints,
 * always including the event's own {@link phenomenonFingerprint}. The base cell
 * indices are computed ONCE and neighbors are enumerated as integer index
 * offsets (x±1, y±1), so a centroid arbitrarily close to a cell edge — where
 * re-quantizing a coordinate-offset point can lose the offset to floating-point
 * cancellation at large |lon| — still yields all nine cells exactly. This closes
 * the cell-boundary miss where two reports a metre apart straddle a cell edge:
 * their exact fingerprints differ, but each sits inside the other's
 * neighborhood, so a candidate lookup keyed on this set still pairs them. A
 * fingerprint match only OPENS a typed candidate set; it never merges
 * automatically.
 *
 * Known limitations (inherited from the {@link gridCell} quantization):
 * - The grid does not wrap at the antimeridian — cell indices run past ±180°,
 *   so a pair of reports straddling the ±180° meridian share no neighborhood.
 * - Longitude cells shrink toward the poles (equatorial-scaled step), so at
 *   high latitudes the 3×3 cell block covers less east–west ground than
 *   3×gridMeters.
 *
 * Same TypeError guards as {@link phenomenonFingerprint} (events-only, finite
 * coordinates, valid `validFrom`, valid options).
 */
export function phenomenonFingerprintNeighborhood(
  evt: ConditionEvent,
  opts: FingerprintOptions = {}
): string[] {
  if (evt.kind !== "event") {
    throw new TypeError(
      "phenomenonFingerprintNeighborhood is events-only: measurements carry no validFrom and would collapse distinct sensors onto one key"
    );
  }
  const { gridMeters, typeDepth, timeBucketSec } = resolveFingerprintOptions(opts);
  const [x, y] = gridCellIndices(centroid(evt.geometry), gridMeters);
  const baseBucket = timeBucket(evt.validFrom, timeBucketSec);
  const fingerprints = new Set<string>();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cell = cellKey(x + dx, y + dy);
      for (let dBucket = -1; dBucket <= 1; dBucket++) {
        fingerprints.add(
          fingerprintDigest(cell, evt.domain, evt.type, typeDepth, baseBucket + dBucket)
        );
      }
    }
  }
  return [...fingerprints];
}
