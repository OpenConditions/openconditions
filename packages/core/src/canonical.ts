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
 * Snap to an equatorial-scaled grid: longitude cells shrink toward the poles,
 * accepted for a starting quantization (the tuning seam is FingerprintOptions).
 */
export function gridCell([lon, lat]: [number, number], gridMeters: number): string {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new TypeError("gridCell requires finite coordinates");
  }
  const latStep = gridMeters / METERS_PER_DEG_LAT;
  const lonStep = latStep;
  return `${Math.floor(lon / lonStep)}:${Math.floor(lat / latStep)}`;
}

export function truncateType(domain: string, type: string, depth: number): string[] {
  // Domain and type stay separate hash-input elements so ("a/b","c") and
  // ("a","b/c") cannot collide.
  return depth <= 1 ? [domain] : [domain, type];
}

const HAS_ZONE_DESIGNATOR = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

export function timeBucket(validFrom: string | null | undefined, bucketSec: number): number {
  if (!validFrom) {
    throw new TypeError("timeBucket requires a validFrom timestamp");
  }
  // An offset-less datetime is pinned to UTC: cross-instance determinism of the
  // key outweighs absolute wall-clock correctness for a 300 s bucket.
  const pinned =
    validFrom.includes("T") && !HAS_ZONE_DESIGNATOR.test(validFrom) ? `${validFrom}Z` : validFrom;
  const epochMs = Date.parse(pinned);
  if (!Number.isFinite(epochMs)) {
    throw new TypeError(`timeBucket got an invalid date: ${validFrom}`);
  }
  return Math.floor(epochMs / 1000 / bucketSec);
}

export function phenomenonFingerprint(evt: ConditionEvent, opts: FingerprintOptions = {}): string {
  if (evt.kind !== "event") {
    throw new TypeError(
      "phenomenonFingerprint is events-only: measurements carry no validFrom and would collapse distinct sensors onto one key"
    );
  }
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
  return sha256Hex([
    gridCell(centroid(evt.geometry), gridMeters),
    ...truncateType(evt.domain, evt.type, typeDepth),
    String(timeBucket(evt.validFrom, timeBucketSec)),
  ]);
}
