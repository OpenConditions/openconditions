import { observationId } from "../classes/observation.js";
import { jcs } from "../kernel/identity.js";
import {
  type Attribution,
  type EvidenceState,
  FUSED_SOURCE_ID,
  FUSION_TIERS,
  type FusionTier,
  type GrantState,
  type RoutingRights,
  type SourceTier,
} from "../kernel/provenance.js";
import type { Result } from "../kernel/result.js";
import type { LocationRef } from "../kernel/types.js";
import type { Registry, ValidationResult } from "../registry/build.js";

/** The parts of a stored observation fusion reads and copies. */
export interface FusableObservation {
  id: string;
  property: string;
  qualifiers?: Record<string, unknown>;
  result: Result;
  phenomenonTime: { instant: string } | { start: string; end: string };
  resultTime?: string;
  validUntil?: string;
  aggregation: string;
  temporality: string;
  forecast?: { issuedAt: string; leadTime: unknown; model?: string; probability?: number };
  quality?: Record<string, unknown>;
  provenance: {
    origin: string;
    sourceId: string;
    accessMode: string;
    attribution: Attribution;
    privacy: { class: string };
  };
  freshness: { expiresAt?: string };
}

/** One per-source row competing for a canonical subject's fused row. */
export interface FusionCandidate {
  observation: FusableObservation;
  /** Feed, federated and derived rows: the tier of the source that published them. */
  sourceTier?: SourceTier;
  /** Crowd rows: their evidence state. */
  evidence?: { state: EvidenceState };
  /** Whether the row's source is stale now: the read-time join, never stored. */
  stale: boolean;
}

export interface Fusion {
  winner: FusionCandidate;
  /** The winner and every row of its tier and freshness that published the same result. */
  contributors: readonly FusionCandidate[];
  /** Every contributing source is stale: nothing fresh was left to fuse. */
  stale: boolean;
}

const CROWD_TIER: Partial<Record<EvidenceState, FusionTier>> = {
  externally_resolved: "crowd_externally_resolved",
  corroborated: "crowd_corroborated",
  self_reported: "crowd_self_reported",
};

/**
 * A row's fusion tier: a crowd row's by its evidence (a negated or expired
 * report has none and never fuses), any other row's by its source's tier.
 */
export function fusionTierOf(candidate: FusionCandidate): FusionTier | undefined {
  if (candidate.observation.provenance.origin === "crowd") {
    return candidate.evidence === undefined ? undefined : CROWD_TIER[candidate.evidence.state];
  }
  if (candidate.sourceTier === undefined) {
    throw new TypeError(
      `fusion needs the tier of source ${candidate.observation.provenance.sourceId}`,
    );
  }
  return candidate.sourceTier;
}

const startOf = (o: FusableObservation) => {
  const t = o.phenomenonTime;
  return Date.parse("instant" in t ? t.instant : t.start);
};

/**
 * Picks the value a canonical subject shows for one property: among rows in
 * effect now (started, not past their `validUntil`, and for a crowd report not
 * past its `freshness.expiresAt`) whose tier the
 * property fuses, a fresh row beats a stale one, then the higher tier wins,
 * then the later reading, then the smaller id. So a crowd report never
 * overrides a fresh authoritative status, and surfaces when the feed is stale
 * or silent. Undefined when no row qualifies.
 */
export function fuse(
  registry: Registry,
  property: string,
  candidates: readonly FusionCandidate[],
  now: string,
): Fusion | undefined {
  const entry = registry.property(property);
  if (entry === undefined) throw new TypeError(`unknown property ${property}`);
  const order: readonly FusionTier[] = entry.fusionTiers ?? FUSION_TIERS;
  const nowMs = Date.parse(now);
  const ranked = candidates
    .flatMap((c) => {
      const o = c.observation;
      if (o.property !== property) return [];
      const tier = fusionTierOf(c);
      const rank = tier === undefined ? -1 : order.indexOf(tier);
      if (rank < 0 || startOf(o) > nowMs) return [];
      if (o.validUntil !== undefined && Date.parse(o.validUntil) <= nowMs) return [];
      // A crowd report's life is its expiry, which its evidence may not have caught up with
      // yet (a peer's report is never re-evaluated here).
      const expiresAt = o.provenance.origin === "crowd" ? o.freshness.expiresAt : undefined;
      if (expiresAt !== undefined && Date.parse(expiresAt) <= nowMs) return [];
      return [{ c, rank }];
    })
    .sort(
      (a, b) =>
        Number(a.c.stale) - Number(b.c.stale) ||
        a.rank - b.rank ||
        startOf(b.c.observation) - startOf(a.c.observation) ||
        a.c.observation.id.localeCompare(b.c.observation.id),
    );
  const first = ranked[0];
  if (first === undefined) return undefined;
  const value = jcs(first.c.observation.result);
  const contributors = ranked
    .filter(
      (r) =>
        r.rank === first.rank &&
        r.c.stale === first.c.stale &&
        jcs(r.c.observation.result) === value,
    )
    .map((r) => r.c);
  return { winner: first.c, contributors, stale: first.c.stale };
}

const GRANT_ORDER: readonly GrantState[] = ["no", "unknown", "yes"];
/** Grants that permit: the most restrictive is the least granted. */
const PERMISSIONS = [
  "source_redistribution",
  "derived_redistribution",
  "commercial_use",
  "retention",
] as const;

/**
 * The rights of a value several sources published: each grant is the most
 * restrictive any of them gives, and a source that declares no rights grants
 * nothing known. Undefined when none declares any.
 */
export function mostRestrictiveRights(
  attributions: readonly Attribution[],
): RoutingRights | undefined {
  const declared = attributions.map((a) => a.rights);
  const first = declared.find((r) => r !== undefined);
  if (first === undefined) return undefined;
  const rights: RoutingRights = { ...first };
  for (const grant of PERMISSIONS) {
    rights[grant] = declared
      .map((r) => r?.[grant] ?? "unknown")
      .reduce((a, b) => (GRANT_ORDER.indexOf(a) <= GRANT_ORDER.indexOf(b) ? a : b));
  }
  // Attribution is an obligation, not a permission: the most restrictive is the most required.
  rights.attribution_required = declared
    .map((r) => r?.attribution_required ?? "unknown")
    .reduce((a, b) => (GRANT_ORDER.indexOf(a) >= GRANT_ORDER.indexOf(b) ? a : b));
  return rights;
}

/** Where the fused row lives: the canonical feature (and component), or a location subject. */
export interface FusedSubject {
  subject: { kind: "feature"; featureId: string; componentKey?: string } | { kind: "location" };
  location: LocationRef;
}

/**
 * The `@fused` row of a canonical subject: the winner's value and times on
 * the canonical subject, its contributors in `derivedFrom` and
 * `mergedSources`, credited to the winner's publisher with the most
 * restrictive rights of all contributors. A value derived from an on-demand
 * source stays on demand and expires with the earliest such contributor, so
 * fusing never turns a read-through answer into history.
 */
export function fusedObservation(
  registry: Registry,
  fusion: Fusion,
  at: FusedSubject & { instanceId: string; now: string },
): ValidationResult {
  const w = fusion.winner.observation;
  const contributors = fusion.contributors.map((c) => c.observation);
  const onDemand = contributors.filter((o) => o.provenance.accessMode === "on_demand");
  const expiries = onDemand.flatMap((o) =>
    o.freshness.expiresAt === undefined ? [] : [Date.parse(o.freshness.expiresAt)],
  );
  const rights = mostRestrictiveRights(contributors.map((o) => o.provenance.attribution));
  const { rights: _ignored, ...credit } = w.provenance.attribution;
  const draft: Record<string, unknown> = {
    id: "",
    class: "observation",
    kind: "observation",
    property: w.property,
    subject: at.subject,
    ...(w.qualifiers === undefined ? {} : { qualifiers: w.qualifiers }),
    result: w.result,
    phenomenonTime: w.phenomenonTime,
    ...(w.resultTime === undefined ? {} : { resultTime: w.resultTime }),
    ...(w.validUntil === undefined ? {} : { validUntil: w.validUntil }),
    aggregation: w.aggregation,
    ...(w.forecast === undefined ? {} : { forecast: w.forecast }),
    ...(w.quality === undefined ? {} : { quality: w.quality }),
    temporality: w.temporality,
    location: at.location,
    provenance: {
      origin: "derived",
      sourceId: FUSED_SOURCE_ID,
      sourceFormat: "derived",
      accessMode: onDemand.length > 0 ? "on_demand" : "bulk",
      recordId: "",
      attribution: rights === undefined ? credit : { ...credit, rights },
      mergedSources: contributors.map((o) => ({
        source: o.provenance.sourceId,
        recordId: o.id,
        attribution: o.provenance.attribution,
      })),
      derivedFrom: {
        records: contributors.map((o) => ({ class: "observation", id: o.id })),
        method: "fusion",
        version: "1",
      },
      privacy: { class: w.provenance.privacy.class },
    },
    freshness: {
      fetchedAt: at.now,
      ...(expiries.length > 0 ? { expiresAt: new Date(Math.min(...expiries)).toISOString() } : {}),
    },
  };
  draft["id"] = observationId(at.instanceId, draft as never);
  (draft["provenance"] as Record<string, unknown>)["recordId"] = (draft["id"] as string)
    .split(":")
    .slice(3)
    .join(":");
  return registry.validateDraft(draft);
}
