import type { z } from "zod";
import type { featureSchema } from "./classes/feature.js";
import type { observationSchema } from "./classes/observation.js";
import type { offerSchema } from "./classes/offer.js";
import type { situationSchema } from "./classes/situation.js";
import type { KernelBase } from "./kernel/build.js";
import { jcs, sha256Hex } from "./kernel/identity.js";

export type Situation = z.output<ReturnType<typeof situationSchema>>;
export type Feature = z.output<ReturnType<typeof featureSchema>>;
export type Observation = z.output<ReturnType<typeof observationSchema>>;
export type Offer = z.output<ReturnType<typeof offerSchema>>;
export type AnyRecord = Situation | Feature | Observation | Offer;
type Provenance = z.output<KernelBase["Provenance"]>;

/**
 * What a record key is for the content hash. `content` keys are hashed;
 * `derived` keys are computed by OC (identity, revisions, evidence, fusion,
 * matching) or read-time joins, and never are. The maps are typed as a
 * `Record` over each record type's keys, so adding a field to a class schema
 * without classifying it here fails the typecheck: the exclusion list is
 * complete by construction, not by review.
 */
type Role = "content" | "derived";

const BASE = {
  id: "content",
  class: "content",
  kind: "content",
  temporality: "content",
  externalIds: "content",
  location: "content",
  relations: "content",
  provenance: "content",
  extras: "content",
  freshness: "derived",
  canonicalId: "derived",
  domain: "derived",
  contentHash: "derived",
  revision: "derived",
  recordedAt: "derived",
  tombstone: "derived",
  evidence: "derived",
} as const;

const SITUATION: Record<keyof Situation, Role> = {
  ...BASE,
  type: "content",
  subtype: "content",
  causes: "content",
  planned: "content",
  certainty: "content",
  severity: "content",
  headline: "content",
  description: "content",
  instruction: "content",
  comments: "content",
  validity: "content",
  effects: "content",
  affects: "content",
  groupId: "content",
  details: "content",
};

const FEATURE: Record<keyof Feature, Role> = {
  ...BASE,
  type: "content",
  subtype: "content",
  name: "content",
  description: "content",
  lifecycle: "content",
  operator: "content",
  owner: "content",
  publisher: "content",
  openingHours: "content",
  access: "content",
  amenities: "content",
  images: "content",
  components: "content",
  details: "content",
  osmMatch: "derived",
};

const OBSERVATION: Record<keyof Observation, Role> = {
  ...BASE,
  property: "content",
  subject: "content",
  qualifiers: "content",
  result: "content",
  phenomenonTime: "content",
  resultTime: "content",
  validUntil: "content",
  aggregation: "content",
  forecast: "content",
  quality: "content",
  baseline: "content",
  sinceAt: "derived",
};

const OFFER: Record<keyof Offer, Role> = {
  ...BASE,
  subject: "content",
  currency: "content",
  tariffType: "content",
  scope: "content",
  elements: "content",
  minPrice: "content",
  maxPrice: "content",
  priceIncludesVat: "content",
  altText: "content",
  url: "content",
  validity: "content",
  applicability: "content",
  energyMix: "content",
  displayText: "content",
};

/**
 * Provenance fields that are hop, fusion or storage metadata: which instance
 * wrote the row, how it travelled, which duplicates were merged into it, who
 * reported it, which raw payload delivered it (a new payload hash every poll
 * must not become a new revision).
 */
const PROVENANCE: Record<keyof Provenance, Role> = {
  origin: "content",
  sourceId: "content",
  sourceFormat: "content",
  accessMode: "content",
  recordId: "content",
  recordVersion: "content",
  sourceUri: "content",
  sourceUpdatedAt: "content",
  attribution: "content",
  upstream: "content",
  derivedFrom: "content",
  privacy: "content",
  rawRef: "derived",
  instanceId: "derived",
  originChain: "derived",
  mergedSources: "derived",
  reporter: "derived",
};

const ROLES: Record<string, Record<string, Role>> = {
  situation: SITUATION,
  feature: FEATURE,
  observation: OBSERVATION,
  offer: OFFER,
};

function pick(value: Record<string, unknown>, roles: Record<string, Role>, where: string) {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const role = roles[key];
    if (role === undefined) throw new TypeError(`${where}: unclassified key "${key}"`);
    if (role === "content" && v !== undefined) out[key] = v;
  }
  return out;
}

/** The content fields of a (draft or stored) record, derived fields removed. */
export function contentOf(record: Record<string, unknown>): Record<string, unknown> {
  const cls = record["class"];
  const roles = typeof cls === "string" ? ROLES[cls] : undefined;
  if (roles === undefined) throw new TypeError(`unknown class ${String(cls)}`);
  const content = pick(record, roles, String(cls));
  const provenance = record["provenance"];
  if (typeof provenance === "object" && provenance !== null) {
    content["provenance"] = pick(provenance as Record<string, unknown>, PROVENANCE, "provenance");
  }
  return content;
}

/** sha256 of the RFC 8785 JCS of `contentOf(record)`. A feature's hash covers its components. */
export function contentHash(record: Record<string, unknown>): string {
  return sha256Hex(jcs(contentOf(record)));
}
