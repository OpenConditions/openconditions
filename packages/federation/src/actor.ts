/**
 * The federation Actor document — the public, self-describing identity an
 * instance serves at `/.well-known/openconditions/actor.json` (as
 * `application/activity+json`). Pure builder: route wiring lives in the
 * federation service. The document carries every instance key valid "now" as
 * a Multikey entry, so peers keep verifying through a rotation overlap.
 * Private key material never appears here by construction.
 */
import type { InstanceKey } from "./keys.js";

export interface ActorCoverage {
  iso3166?: string[];
  bbox?: [number, number, number, number];
}

export interface ActorCapabilities {
  protocolVersion: string;
  schemaVersions: string[];
  wireFormats: string[];
  deliveryModes: string[];
  subscriptionFilters: string[];
  maxEventRate: number;
  convergenceBound: number;
  mtlsRequired?: boolean;
}

export interface ActorConfig {
  instanceId: string;
  baseUrl: string;
  operator: string;
  jurisdiction: string;
  transparencyReportUrl?: string;
  coverage: ActorCoverage;
  supportedTypes: string[];
  license: string;
  policyDocument?: string;
  trustTier: 0 | 1 | 2;
  capabilities: ActorCapabilities;
  /** publicKeyMultibase values of Tier-2 governance anchor keys. */
  trustAnchors?: string[];
}

/** One served instance key, in W3C Multikey form. */
export interface ActorPublicKey {
  id: string;
  owner: string;
  type: "Multikey";
  publicKeyMultibase: string;
}

export interface ActorDocument {
  id: string;
  type: ["Service", "MobilityCommonsInstance"];
  operator: string;
  jurisdiction: string;
  transparencyReportUrl?: string;
  publicKey: ActorPublicKey[];
  outbox: string;
  inbox: string;
  subscribe: string;
  /** URI template — `{id}` is the event id placeholder. */
  events: string;
  tombstones: string;
  coverage: ActorCoverage;
  supportedTypes: string[];
  capabilities: ActorCapabilities;
  license: string;
  policyDocument?: string;
  trustTier: 0 | 1 | 2;
  trustAnchor: string[];
}

/** Media type the actor (and peers) documents are served as. */
export const ACTIVITY_JSON = "application/activity+json";

export const ACTOR_WELL_KNOWN_PATH = "/.well-known/openconditions/actor.json";
export const PEERS_WELL_KNOWN_PATH = "/.well-known/openconditions/peers.json";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

/**
 * Builds the Actor document for the given config and the keys valid now.
 * Refuses an empty key set: an actor without a verifiable key must never be
 * served (a peer would cache an identity nothing can ever sign for).
 */
export function buildActorDocument(cfg: ActorConfig, activeKeys: InstanceKey[]): ActorDocument {
  if (activeKeys.length === 0) {
    throw new TypeError("cannot build an actor document without an active instance key");
  }
  const base = normalizeBaseUrl(cfg.baseUrl);
  const actorId = `${base}${ACTOR_WELL_KNOWN_PATH}`;
  const doc: ActorDocument = {
    id: actorId,
    type: ["Service", "MobilityCommonsInstance"],
    operator: cfg.operator,
    jurisdiction: cfg.jurisdiction,
    publicKey: activeKeys.map((key) => ({
      id: `${actorId}#${key.keyId}`,
      owner: actorId,
      type: "Multikey",
      publicKeyMultibase: key.publicKeyMultibase,
    })),
    outbox: `${base}/peer/outbox`,
    inbox: `${base}/peer/inbox`,
    subscribe: `${base}/peer/subscribe`,
    events: `${base}/peer/event/{id}`,
    tombstones: `${base}/peer/tombstones`,
    coverage: cfg.coverage,
    supportedTypes: cfg.supportedTypes,
    capabilities: cfg.capabilities,
    license: cfg.license,
    trustTier: cfg.trustTier,
    trustAnchor: cfg.trustAnchors ?? [],
  };
  if (cfg.transparencyReportUrl !== undefined) {
    doc.transparencyReportUrl = cfg.transparencyReportUrl;
  }
  if (cfg.policyDocument !== undefined) {
    doc.policyDocument = cfg.policyDocument;
  }
  return doc;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
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

function fail(field: string, expectation: string): never {
  throw new TypeError(`invalid actor config: ${field} ${expectation}`);
}

/**
 * Parses and validates an operator-supplied ActorConfig (JSON text or an
 * already-parsed value). Throws TypeError naming the first offending field —
 * the federation service fails its boot closed on this.
 */
export function parseActorConfig(source: string | unknown): ActorConfig {
  let value: unknown = source;
  if (typeof source === "string") {
    try {
      value = JSON.parse(source);
    } catch (err) {
      throw new TypeError(`invalid actor config: not valid JSON (${(err as Error).message})`);
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("document", "must be a JSON object");
  }
  const cfg = value as Record<string, unknown>;

  for (const field of ["instanceId", "operator", "jurisdiction", "license"] as const) {
    if (typeof cfg[field] !== "string" || cfg[field].length === 0) {
      fail(field, "must be a non-empty string");
    }
  }
  if (!isHttpUrl(cfg["baseUrl"])) fail("baseUrl", "must be an http(s) URL");
  if (cfg["trustTier"] !== 0 && cfg["trustTier"] !== 1 && cfg["trustTier"] !== 2) {
    fail("trustTier", "must be 0, 1, or 2");
  }
  if (!isStringArray(cfg["supportedTypes"]) || cfg["supportedTypes"].length === 0) {
    fail("supportedTypes", "must be a non-empty string array");
  }

  const coverage = cfg["coverage"];
  if (coverage === null || typeof coverage !== "object" || Array.isArray(coverage)) {
    fail("coverage", "must be an object");
  }
  const cov = coverage as Record<string, unknown>;
  if (cov["iso3166"] !== undefined && !isStringArray(cov["iso3166"])) {
    fail("coverage.iso3166", "must be a string array");
  }
  if (
    cov["bbox"] !== undefined &&
    (!Array.isArray(cov["bbox"]) ||
      cov["bbox"].length !== 4 ||
      !cov["bbox"].every((n) => typeof n === "number" && Number.isFinite(n)))
  ) {
    fail("coverage.bbox", "must be [west, south, east, north] finite numbers");
  }

  const capabilities = cfg["capabilities"];
  if (capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    fail("capabilities", "must be an object");
  }
  const caps = capabilities as Record<string, unknown>;
  if (typeof caps["protocolVersion"] !== "string" || caps["protocolVersion"].length === 0) {
    fail("capabilities.protocolVersion", "must be a non-empty string");
  }
  for (const field of [
    "schemaVersions",
    "wireFormats",
    "deliveryModes",
    "subscriptionFilters",
  ] as const) {
    if (!isStringArray(caps[field])) fail(`capabilities.${field}`, "must be a string array");
  }
  for (const field of ["maxEventRate", "convergenceBound"] as const) {
    if (typeof caps[field] !== "number" || !Number.isFinite(caps[field])) {
      fail(`capabilities.${field}`, "must be a finite number");
    }
  }
  if (caps["mtlsRequired"] !== undefined && typeof caps["mtlsRequired"] !== "boolean") {
    fail("capabilities.mtlsRequired", "must be a boolean");
  }

  for (const field of ["transparencyReportUrl", "policyDocument"] as const) {
    if (cfg[field] !== undefined && !isHttpUrl(cfg[field])) {
      fail(field, "must be an http(s) URL");
    }
  }
  if (cfg["trustAnchors"] !== undefined && !isStringArray(cfg["trustAnchors"])) {
    fail("trustAnchors", "must be a string array of publicKeyMultibase values");
  }

  return cfg as unknown as ActorConfig;
}
