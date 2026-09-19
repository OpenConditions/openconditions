import { z } from "zod";
import type { KernelBase } from "./build.js";
import { canonicalIdOf, parseRecordId, RECORD_ID_PATTERN } from "./identity.js";
import { EvidenceSummary, Freshness, Relation, Tombstone } from "./provenance.js";
import { Iso8601, type RecordClass, Sha256Hex } from "./scalars.js";

export const TEMPORALITIES = ["static", "scheduled", "live", "forecast"] as const;

/**
 * Stored/wire records carry every RecordBase field. Parser output is a draft:
 * the write seam derives `canonicalId`, `domain`, `contentHash` and
 * `provenance.instanceId`, storage assigns `revision`/`recordedAt`/`tombstone`,
 * and `evidence` is materialised from the evidence ledger — a draft that
 * asserts any of them is rejected, never silently overwritten.
 */
export type Stage = "draft" | "stored";

export function recordBaseShape(k: KernelBase, stage: Stage) {
  const provenance = stage === "stored" ? k.Provenance : k.ProvenanceDraft;
  const shape = {
    id: z.string().regex(RECORD_ID_PATTERN),
    temporality: z.enum(TEMPORALITIES),
    externalIds: z.array(k.ExternalId).min(1).optional(),
    location: k.LocationRef,
    relations: z.array(Relation).min(1).optional(),
    provenance,
    freshness: Freshness,
    /** Allow-listed source tokens (source registry `extrasAllow`), soft-validated. */
    extras: z.record(z.string(), z.unknown()).optional(),
  };
  const derived = {
    canonicalId: Sha256Hex,
    domain: z.string().min(1),
    contentHash: Sha256Hex,
    revision: z.number().int().positive(),
    recordedAt: Iso8601,
    tombstone: Tombstone.optional(),
    evidence: EvidenceSummary.optional(),
  };
  const absent = {
    canonicalId: z.never().optional(),
    domain: z.never().optional(),
    contentHash: z.never().optional(),
    revision: z.never().optional(),
    recordedAt: z.never().optional(),
    tombstone: z.never().optional(),
    evidence: z.never().optional(),
  };
  return stage === "stored" ? { ...shape, ...derived } : { ...shape, ...absent };
}

/**
 * Rules every record obeys: the id names its class, and on stored records the
 * canonical id matches the id and the domain is the kind's registered domain.
 */
export function checkRecordBase(
  record: object,
  cls: RecordClass,
  domain: string | undefined,
  ctx: z.RefinementCtx,
): void {
  const r = record as { id: string; canonicalId?: string; domain?: string };
  if (r.domain !== undefined && r.domain !== domain) {
    ctx.addIssue({
      code: "custom",
      path: ["domain"],
      message: `the registered domain is "${domain}"`,
    });
  }
  const parts = parseRecordId(r.id);
  if (parts === null) return;
  if (parts.class !== cls) {
    ctx.addIssue({ code: "custom", path: ["id"], message: `a ${cls} id starts with oc:${cls}:` });
  }
  if (
    r.canonicalId !== undefined &&
    r.canonicalId !== canonicalIdOf(parts.namespace, parts.localId)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["canonicalId"],
      message: "canonicalId is sha256([namespace, localId]) of the id",
    });
  }
}
