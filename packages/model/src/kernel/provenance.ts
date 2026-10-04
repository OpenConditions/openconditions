import { z } from "zod";
import { Iso8601, RecordRef, Sha256Hex } from "./scalars.js";
import type { Vocab } from "./vocab.js";

export const GRANT_STATES = ["yes", "no", "unknown"] as const;
export const EVIDENCE_STATES = [
  "self_reported",
  "corroborated",
  "externally_resolved",
  "negated",
  "expired",
] as const;
export const ORIGINS = ["feed", "crowd", "federation", "derived"] as const;
export const ACCESS_MODES = ["bulk", "on_demand"] as const;
/** Writer-derived: `authoritative` = released as published by a feed, whatever the publisher's tier. */
export const PRIVACY_CLASSES = [
  "authoritative",
  "aggregate",
  "k_anon",
  "dp_noised",
  "crowd_pseudonym",
] as const;
export const MERGE_LINKS = ["same_record", "same_phenomenon", "same_asset"] as const;
export const RELATIONS = [
  "part_of",
  "monitors",
  "controls",
  "serves",
  "group",
  "next_occurrence",
  "first_occurrence",
  "related_work_zone",
  "caused_by",
  "detour_for",
  "supersedes",
  "update_of",
  "cancels",
  "related",
] as const;
export const TOMBSTONE_REASONS = [
  "expired",
  "withdrawn",
  "superseded",
  "cancelled",
  "rights_revoked",
  "rejected",
] as const;

/**
 * What kind of publisher a source is (the source registry's `tier`). Fusion
 * ranks sources by it, then crowd rows by evidence state.
 */
export const SOURCE_TIERS = ["authoritative", "operator", "aggregator", "community"] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];
export type AccessMode = (typeof ACCESS_MODES)[number];
/** The default fusion order, highest first; a property may declare its own order. */
export const FUSION_TIERS = [
  ...SOURCE_TIERS,
  "crowd_externally_resolved",
  "crowd_corroborated",
  "crowd_self_reported",
] as const;
export type FusionTier = (typeof FUSION_TIERS)[number];

/** Source ids: dash-joined lower-case slugs (the feed catalogue's region-first ids). */
export const SOURCE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Instance ids may be hostnames: lower-case alphanumerics, dots and dashes. */
export const INSTANCE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
/** The sentinel source id of fused observation rows. */
export const FUSED_SOURCE_ID = "@fused";
/**
 * The sentinel source id of a public fusion: the fusion over a subject's
 * public contributors only, kept beside the `@fused` row when that one used
 * a contributor the public scope may not see.
 */
export const FUSED_PUBLIC_SOURCE_ID = "@fused-public";
/** Every fused row's source id. */
export const FUSED_SOURCE_IDS = [FUSED_SOURCE_ID, FUSED_PUBLIC_SOURCE_ID] as const;
export type FusedSourceId = (typeof FUSED_SOURCE_IDS)[number];
/** Whether a source id is a fused row's. */
export const isFusedSourceId = (sourceId: string): sourceId is FusedSourceId =>
  (FUSED_SOURCE_IDS as readonly string[]).includes(sourceId);

export const GrantState = z.enum(GRANT_STATES);
export const EvidenceState = z.enum(EVIDENCE_STATES);
export const InstanceId = z.string().regex(INSTANCE_ID_PATTERN);

export const RoutingRights = z.strictObject({
  source_redistribution: GrantState,
  derived_redistribution: GrantState,
  commercial_use: GrantState,
  attribution_required: GrantState,
  retention: GrantState,
  evidence_origin: z.string().nullable(),
  evidence_version: z.string().nullable(),
  reviewed_at: z.string().nullable(),
});

export const Attribution = z.strictObject({
  provider: z.string().min(1),
  license: z.string().min(1),
  /** The provider's page for this data. */
  url: z.url().optional(),
  licenseUrl: z.url().optional(),
  parentSourceId: z.string().min(1).optional(),
  childSourceId: z.string().min(1).optional(),
  policyIds: z.array(z.string().min(1)).min(1).optional(),
  rights: RoutingRights.optional(),
});

export const OriginHop = z.strictObject({
  instanceId: InstanceId,
  viaPeer: z.string().min(1).optional(),
  receivedAt: Iso8601,
});

export const MergedSource = z.strictObject({
  source: z.string().min(1),
  recordId: z.string().min(1),
  attribution: Attribution,
  link: z.enum(MERGE_LINKS).optional(),
});

export const Freshness = z.strictObject({
  /** The fetch that first delivered this content version; an identical re-fetch does not move it. */
  fetchedAt: Iso8601,
  expiresAt: Iso8601.optional(),
  staleAfter: Iso8601.optional(),
  /** Read-time joins from source_status, never hashed or persisted on the record. */
  sourceCheckedAt: Iso8601.optional(),
  freshnessWindowSec: z.number().int().positive().optional(),
  isStale: z.boolean().optional(),
});

export const Relation = z.strictObject({ ref: RecordRef, relation: z.enum(RELATIONS) });

export const EvidenceSummary = z.strictObject({
  state: EvidenceState,
  confidenceScore: z.number().min(0).max(1),
  routingEligible: z.boolean(),
  corroborations: z.number().int().nonnegative(),
  flaggedAt: Iso8601.optional(),
});

export const Tombstone = z.strictObject({ reason: z.enum(TOMBSTONE_REASONS), at: Iso8601 });

/** Stored provenance carries the writing instance; a parser draft never asserts it. */
export function provenanceSchema(vocab: Vocab, stage: "draft" | "stored") {
  return z
    .strictObject({
      origin: z.enum(ORIGINS),
      /** feed id | "crowd" | instance id | "@fused" or "@fused-public" (fused observation rows only). */
      sourceId: z.union([z.enum(FUSED_SOURCE_IDS), z.string().regex(INSTANCE_ID_PATTERN)]),
      sourceFormat: vocab("source_format"),
      accessMode: z.enum(ACCESS_MODES),
      /** Source-local id. */
      recordId: z.string().min(1),
      recordVersion: z.string().min(1).optional(),
      sourceUri: z.url().optional(),
      /** Publisher's record time; absent when the publisher gives none — never defaulted. */
      sourceUpdatedAt: Iso8601.optional(),
      attribution: Attribution,
      upstream: z
        .array(
          z.strictObject({
            publisher: z.string().min(1),
            recordId: z.string().min(1).optional(),
            license: z.string().min(1).optional(),
            attribution: z.string().min(1).optional(),
          }),
        )
        .min(1)
        .optional(),
      rawRef: z
        .strictObject({
          hash: Sha256Hex,
          part: z.string().min(1).optional(),
          pointer: z.string().min(1).optional(),
        })
        .optional(),
      instanceId: stage === "stored" ? InstanceId : z.never().optional(),
      originChain: z.array(OriginHop).min(1).optional(),
      mergedSources: z.array(MergedSource).min(1).optional(),
      derivedFrom: z
        .strictObject({
          records: z.array(RecordRef).min(1),
          method: z.string().min(1),
          version: z.string().min(1),
        })
        .optional(),
      /** Local rows only, stripped at every egress. */
      reporter: z
        .strictObject({ keyId: z.string().min(1), reputation: z.number().optional() })
        .optional(),
      privacy: z.strictObject({
        class: z.enum(PRIVACY_CLASSES),
        kAnonymity: z.number().int().min(2).optional(),
        dpEpsilon: z.number().positive().optional(),
        dpDelta: z.number().min(0).lt(1).optional(),
      }),
    })
    .superRefine((p, ctx) => {
      if (p.origin === "feed" && !SOURCE_ID_PATTERN.test(p.sourceId)) {
        ctx.addIssue({
          code: "custom",
          path: ["sourceId"],
          message: "a feed record's sourceId must be a source id ([a-z0-9-]+)",
        });
      }
      if (p.origin === "crowd" && p.sourceId !== "crowd") {
        ctx.addIssue({
          code: "custom",
          path: ["sourceId"],
          message: 'a crowd record\'s sourceId is "crowd"',
        });
      }
      if (isFusedSourceId(p.sourceId) && p.origin !== "derived") {
        ctx.addIssue({
          code: "custom",
          path: ["origin"],
          message: 'fused rows ("@fused", "@fused-public") have origin "derived"',
        });
      }
    });
}

export type GrantState = z.infer<typeof GrantState>;
export type EvidenceState = z.infer<typeof EvidenceState>;
export type RoutingRights = z.infer<typeof RoutingRights>;
export type Attribution = z.infer<typeof Attribution>;
export type OriginHop = z.infer<typeof OriginHop>;
export type MergedSource = z.infer<typeof MergedSource>;
export type Freshness = z.infer<typeof Freshness>;
export type Relation = z.infer<typeof Relation>;
export type EvidenceSummary = z.infer<typeof EvidenceSummary>;
export type Tombstone = z.infer<typeof Tombstone>;
export type PrivacyClass = (typeof PRIVACY_CLASSES)[number];
