/**
 * The federation Actor document — the public, self-describing identity an
 * instance serves at `/.well-known/openconditions/actor.json` as plain
 * `application/json` (some field names are borrowed from ActivityStreams, but
 * the document is not an ActivityStreams object). Pure builder: route wiring
 * lives in the federation service. The document carries every instance key
 * valid "now" as a Multikey entry with the previous key's endorsement of it,
 * so peers keep verifying through a rotation overlap and learn the new key
 * from the old.
 * Private key material never appears here by construction.
 *
 * What the instance can do is advertised from the running build, never
 * configured, so a peer acting on it is never misled: the schema versions of
 * its registry, the wire format it serves, the delivery modes and filter keys
 * its subscriptions accept. The operator configures only the protocol
 * versions it offers and the convergence bound it promises.
 */
import type { KeyEndorsement, PublicInstanceKey } from "./keys.js";
import { RECORD_FILTER_KEYS } from "./record-filter.js";
import { DELIVERY_MODES } from "./subscriptions.js";

export interface ActorCoverage {
  iso3166?: string[];
  bbox?: [number, number, number, number];
}

export interface ActorCapabilities {
  protocolVersion: string;
  /** The full set of protocol versions still supported (e.g. during a
   *  dual-support window); when absent, {@link protocolVersion} is the only one.
   *  Used by capability negotiation to pick the highest mutually-supported. */
  protocolVersions?: string[];
  /**
   * Every schema this instance's registry runs, as `<key>@<major>.<minor>`
   * (`kernel@1.0`, `situation/incident@1.2`); advertised from the registry,
   * never configured, so a peer always sees what the running build accepts.
   */
  schemaVersions: string[];
  /** The media types its documents are served in: {@link FEDERATION_JSON}. */
  wireFormats: string[];
  /** The delivery modes its subscriptions accept. */
  deliveryModes: string[];
  /** The filter keys its subscriptions and journal reads accept. */
  subscriptionFilters: string[];
  convergenceBound: number;
}

/** The capabilities an operator configures; the rest come from the build. */
export type ConfiguredCapabilities = Omit<
  ActorCapabilities,
  "schemaVersions" | "wireFormats" | "deliveryModes" | "subscriptionFilters"
>;

export interface ActorConfig {
  instanceId: string;
  baseUrl: string;
  operator: string;
  jurisdiction: string;
  transparencyReportUrl?: string;
  coverage: ActorCoverage;
  license: string;
  policyDocument?: string;
  trustTier: 0 | 1 | 2;
  capabilities: ConfiguredCapabilities;
  /** publicKeyMultibase values of Tier-2 governance anchor keys. */
  trustAnchors?: string[];
}

/** One served instance key, in W3C Multikey form. */
export interface ActorPublicKey {
  id: string;
  owner: string;
  type: "Multikey";
  publicKeyMultibase: string;
  /** The previous key's signature over this key's id; absent on the first key. */
  endorsement?: KeyEndorsement;
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
  subscriptions: string;
  backfill: string;
  stream: string;
  coverage: ActorCoverage;
  capabilities: ActorCapabilities;
  license: string;
  policyDocument?: string;
  trustTier: 0 | 1 | 2;
  trustAnchor: string[];
}

/**
 * Media type of every federation document: the actor and peers documents and
 * the outbox, backfill and pushed pages. They are plain JSON, not
 * ActivityStreams, although some field names are borrowed from it.
 */
export const FEDERATION_JSON = "application/json";

export const ACTOR_WELL_KNOWN_PATH = "/.well-known/openconditions/actor.json";
export const PEERS_WELL_KNOWN_PATH = "/.well-known/openconditions/peers.json";

/**
 * The capabilities an instance advertises: the configured ones, and what the
 * running build does, with the schema versions its registry runs.
 */
export function actorCapabilities(
  configured: ConfiguredCapabilities,
  schemaVersions: readonly string[],
): ActorCapabilities {
  return {
    ...configured,
    schemaVersions: [...schemaVersions],
    wireFormats: [FEDERATION_JSON],
    deliveryModes: [...DELIVERY_MODES],
    subscriptionFilters: [...RECORD_FILTER_KEYS],
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

/**
 * Builds the Actor document for the given config, the keys valid now and the
 * schema versions the running registry advertises. Refuses an empty key set:
 * an actor without a verifiable key must never be served (a peer would cache
 * an identity nothing can ever sign for).
 */
export function buildActorDocument(
  cfg: ActorConfig,
  activeKeys: readonly PublicInstanceKey[],
  schemaVersions: readonly string[],
): ActorDocument {
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
      ...(key.endorsement === undefined ? {} : { endorsement: key.endorsement }),
    })),
    outbox: `${base}/peer/outbox`,
    inbox: `${base}/peer/inbox`,
    subscriptions: `${base}/peer/subscriptions`,
    backfill: `${base}/peer/backfill`,
    stream: `${base}/peer/stream`,
    coverage: cfg.coverage,
    capabilities: actorCapabilities(cfg.capabilities, schemaVersions),
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
  if (cfg["supportedTypes"] !== undefined) {
    fail(
      "supportedTypes",
      "is gone: the registry's schema versions say what this instance carries",
    );
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
  if (caps["protocolVersions"] !== undefined && !isStringArray(caps["protocolVersions"])) {
    fail("capabilities.protocolVersions", "must be a string array");
  }
  if (caps["schemaVersions"] !== undefined) {
    fail("capabilities.schemaVersions", "is advertised from the registry, not configured");
  }
  for (const field of ["wireFormats", "deliveryModes", "subscriptionFilters"] as const) {
    if (caps[field] !== undefined) {
      fail(`capabilities.${field}`, "is advertised from the build, not configured");
    }
  }
  if (caps["maxEventRate"] !== undefined) {
    fail(
      "capabilities.maxEventRate",
      "is gone: a peer's rate is the budget of the tier its receiver pinned it at",
    );
  }
  if (caps["mtlsRequired"] !== undefined) {
    fail(
      "capabilities.mtlsRequired",
      "is gone: whether a peer must use mutual TLS is the receiving operator's per-peer setting",
    );
  }
  if (typeof caps["convergenceBound"] !== "number" || !Number.isFinite(caps["convergenceBound"])) {
    fail("capabilities.convergenceBound", "must be a finite number");
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
