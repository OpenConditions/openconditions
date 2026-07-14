/**
 * The federation registry schema — one YAML document per instance, published
 * as a TUF target file named `<id>.yaml`. The registry is a DISCOVERY layer:
 * an entry's `keys` are the Ed25519 publicKeyMultibase values the registry
 * governance has authorized for that instance, and they become the
 * `pinnedKeys` of a T1 {@link PeerRecord}, so a registry-discovered actor's
 * runtime keys are trusted only if they chain to the TUF-signed `keys` list
 * (or to an operator's own out-of-band bilateral pin, which needs no registry
 * at all). Parsing is strict and fail-closed: a malformed entry throws
 * instead of degrading into an unpinned peer.
 */
import { parse } from "yaml";
import type { ActorCoverage } from "./actor.js";
import { rawEd25519FromMultibase } from "./multibase.js";
import type { PeerRecord } from "./peers.js";

export interface RegistryOperator {
  name: string;
  contact: string;
  jurisdiction: string;
}

export interface RegistryEntry {
  /** Instance slug; doubles as the TUF target file name (`<id>.yaml`). */
  id: string;
  /** The instance's Actor document URL. */
  actor: string;
  operator: RegistryOperator;
  coverage: ActorCoverage;
  trustTier: 0 | 1 | 2;
  /** TUF-authorized Ed25519 publicKeyMultibase values for this instance. */
  keys: string[];
}

/**
 * Registry ids are lowercase slugs because they double as target file names
 * inside the TUF repository — no path separators, dots, or case games.
 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function fail(message: string): never {
  throw new TypeError(`invalid registry entry: ${message}`);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function parseOperator(value: unknown): RegistryOperator {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("operator must be an object");
  }
  const operator = value as Record<string, unknown>;
  for (const field of ["name", "contact", "jurisdiction"] as const) {
    if (typeof operator[field] !== "string" || operator[field].length === 0) {
      fail(`operator.${field} must be a non-empty string`);
    }
  }
  return {
    name: operator["name"] as string,
    contact: operator["contact"] as string,
    jurisdiction: operator["jurisdiction"] as string,
  };
}

function parseCoverage(value: unknown): ActorCoverage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("coverage must be an object");
  }
  const raw = value as Record<string, unknown>;
  const coverage: ActorCoverage = {};
  if (raw["iso3166"] !== undefined) {
    const iso = raw["iso3166"];
    if (!Array.isArray(iso) || iso.some((code) => typeof code !== "string" || code.length === 0)) {
      fail("coverage.iso3166 must be an array of non-empty strings");
    }
    coverage.iso3166 = iso as string[];
  }
  if (raw["bbox"] !== undefined) {
    const bbox = raw["bbox"];
    if (
      !Array.isArray(bbox) ||
      bbox.length !== 4 ||
      bbox.some((coord) => typeof coord !== "number" || !Number.isFinite(coord))
    ) {
      fail("coverage.bbox must be [minLon, minLat, maxLon, maxLat]");
    }
    const [minLon, minLat, maxLon, maxLat] = bbox as [number, number, number, number];
    if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) {
      fail("coverage.bbox coordinates are out of range");
    }
    if (minLon > maxLon || minLat > maxLat) {
      fail("coverage.bbox min corner must not exceed the max corner");
    }
    coverage.bbox = [minLon, minLat, maxLon, maxLat];
  }
  return coverage;
}

function parseKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("keys must be a non-empty array of Ed25519 publicKeyMultibase values");
  }
  const seen = new Set<string>();
  for (const key of value) {
    if (typeof key !== "string") fail("keys entries must be strings");
    try {
      rawEd25519FromMultibase(key);
    } catch (err) {
      fail(`key ${JSON.stringify(key)} is not an Ed25519 multikey: ${(err as Error).message}`);
    }
    if (seen.has(key)) fail(`duplicate key ${JSON.stringify(key)}`);
    seen.add(key);
  }
  return value as string[];
}

/**
 * Parses and validates one registry YAML document. Unknown top-level fields
 * are ignored (a newer registry may carry fields an older instance does not
 * understand); every KNOWN field is validated strictly and a malformed entry
 * throws a TypeError.
 */
export function parseRegistryEntry(yamlText: string): RegistryEntry {
  const value: unknown = parse(yamlText);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("document must be a YAML mapping");
  }
  const raw = value as Record<string, unknown>;

  const id = raw["id"];
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    fail("id must be a lowercase slug ([a-z0-9-])");
  }
  if (!isHttpUrl(raw["actor"])) fail("actor must be an http(s) URL");

  const trustTier = raw["trustTier"];
  if (trustTier !== 0 && trustTier !== 1 && trustTier !== 2) {
    fail("trustTier must be 0, 1, or 2");
  }

  return {
    id,
    actor: raw["actor"] as string,
    operator: parseOperator(raw["operator"]),
    coverage: parseCoverage(raw["coverage"]),
    trustTier,
    keys: parseKeys(raw["keys"]),
  };
}

/** The TUF target file name a registry entry is published under. */
export function registryEntryFileName(id: string): string {
  return `${id}.yaml`;
}

/**
 * Maps registry entries to T1 peer records: the TUF-authorized `keys` become
 * the peer's `pinnedKeys`, so the existing bilateral-pin verification
 * ({@link verifyActorAgainstPin}) is the single runtime trust check whether a
 * peer was pinned out-of-band or discovered through the registry.
 */
export function registryToPeerRecords(entries: RegistryEntry[]): PeerRecord[] {
  return entries.map((entry) => ({
    instanceId: entry.id,
    actorUrl: entry.actor,
    coverage: entry.coverage,
    trustTier: entry.trustTier,
    pinnedKeys: [...entry.keys],
  }));
}
