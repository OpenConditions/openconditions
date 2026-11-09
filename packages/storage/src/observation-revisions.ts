import { jcs } from "@openconditions/model";
import type { Sql } from "./bulk.js";
import type { SnapshotDrafts, WriteContext } from "./write-records.js";

type Rec = Record<string, unknown>;
const rights = (r: Rec) => {
  const p = r["provenance"] as Rec;
  return jcs([
    p["attribution"] ?? null,
    p["upstream"] ?? [],
    p["mergedSources"] ?? [],
    p["accessMode"] ?? null,
    p["privacy"] ?? null,
  ]);
};

/** Refuse a rights transition while retained readings still carry the earlier grant and credit. */
export async function guardRetainedRights(tx: Sql, source: string, drafts: SnapshotDrafts) {
  const held = await tx<
    { id: string; record: Rec }[]
  >`SELECT f.id, f.record FROM conditions.feature f
    WHERE f.source_id = ${source} AND EXISTS
      (SELECT 1 FROM conditions.observation_latest l WHERE l.feature_id = f.id AND l.source_id = ${source})`;
  const features = new Map(held.map((r) => [r.id, r.record]));
  for (const draft of drafts.features ?? []) {
    const prior = features.get(draft["id"] as string);
    if (prior && rights(prior) !== rights(draft))
      throw new Error("atomic candidate rejected: retained reading rights transition");
  }
  for (const draft of drafts.observations ?? []) {
    const subject = draft["subject"] as Rec;
    const feature = features.get(subject?.["featureId"] as string);
    if (feature && rights(feature) !== rights(draft))
      throw new Error("atomic candidate rejected: reading and feature rights differ");
  }
}

/** Called only under the source publication lock; the authority survives process/cache restarts. */
export async function applyObservationRevisions(
  tx: Sql,
  source: string,
  observations: readonly Rec[],
  ctx: WriteContext,
) {
  const blocked = new Set<string>();
  const ended: { featureId: string; property: string }[] = [];
  for (const revision of ctx.observationRevisions ?? []) {
    const key = `${revision.featureId}/${revision.property}`;
    const [prior] = await tx<
      { measured_at: Date; rank: string; signature: string; suppressed: boolean }[]
    >`
      SELECT measured_at, rank, signature, suppressed FROM conditions.observation_revision
      WHERE source_id=${source} AND feature_id=${revision.featureId} AND property=${revision.property}`;
    const clock = Date.parse(revision.measuredAt);
    const previous = prior?.measured_at.getTime();
    if (
      prior &&
      previous === clock &&
      prior.rank === revision.rank &&
      prior.signature !== revision.signature
    )
      throw new Error("atomic candidate rejected: ambiguous equal-time provider correction");
    if (
      prior &&
      ((previous ?? -Infinity) > clock || (previous === clock && prior.rank > revision.rank))
    ) {
      blocked.add(key);
      continue;
    }
    await tx`INSERT INTO conditions.observation_revision
      (source_id, feature_id, property, measured_at, rank, signature, suppressed)
      VALUES (${source}, ${revision.featureId}, ${revision.property}, ${revision.measuredAt}, ${revision.rank}, ${revision.signature}, ${revision.suppressed})
      ON CONFLICT (source_id, feature_id, property) DO UPDATE SET
      measured_at=excluded.measured_at, rank=excluded.rank, signature=excluded.signature, suppressed=excluded.suppressed`;
    if (!revision.suppressed) continue;
    blocked.add(key);
    await tx`UPDATE conditions.observation_latest l SET expires_at=${ctx.now}::timestamptz,
      reading=jsonb_set(jsonb_set(l.reading, '{freshness,expiresAt}', to_jsonb(${ctx.now}::text)), '{validUntil}', to_jsonb(${ctx.now}::text)), effective_until=${ctx.now}::timestamptz, updated_at=${ctx.now}::timestamptz
      WHERE source_id=${source} AND feature_id=${revision.featureId} AND property=${revision.property}
      AND (expires_at IS NULL OR expires_at > ${ctx.now}::timestamptz)`;
    ended.push({ featureId: revision.featureId, property: revision.property });
  }
  return {
    observations: observations.filter(
      (o) => !blocked.has(`${(o["subject"] as Rec)?.["featureId"]}/${o["property"]}`),
    ),
    ended,
  };
}
