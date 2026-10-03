import type { SignedSubClaim } from "@openconditions/contrib-core";
import { crowdLocalId, type EvidenceState, type Registry } from "@openconditions/model";
import type postgres from "postgres";
import { lockCrowd } from "../crowd.js";
import { recomputeObservationEvidence } from "../evidence/recompute.js";
import { GeometryInvalidError, isGeometryError } from "../landing/land.js";
import type { VoteOutcome } from "./vote.js";

type Sql = postgres.Sql;

export type ObservationVoteOutcome =
  | Exclude<VoteOutcome, { record: unknown }>
  | {
      code: 200;
      action: "confirm" | "negate";
      record: { class: "observation"; id: string };
      evidenceState: EvidenceState | null;
    };

/**
 * Casts a verified sub-claim on a crowd observation: the reading a crowd row
 * holds now, by its record id. As on a situation, the signed sub-claim is
 * stored once per (record, key, type); a confirm or negate appends its
 * evidence and recomputes the reading's evidence, lifetime and the fused row
 * of its subject, all under the crowd lock. A flag is recorded and changes
 * nothing: an observation has no flag queue. A reading its series has moved
 * past, or a settled one, takes no confirm or negate.
 */
export async function castObservationVote(
  sql: Sql,
  registry: Registry,
  observationId: string,
  subClaim: SignedSubClaim,
  now: string,
): Promise<ObservationVoteOutcome> {
  const action = subClaim.claimType;
  const subClaimId = crowdLocalId(subClaim.keyId, subClaim.nonce);
  const geom = subClaim.geometry === undefined ? null : JSON.stringify(subClaim.geometry);
  try {
    return await sql.begin(async (tx) => {
      await lockCrowd(tx);
      const [target] = await tx<{ evidence_state: EvidenceState | null; expired: boolean }[]>`
        SELECT evidence_state, expires_at <= ${now}::timestamptz AS expired
          FROM conditions.observation_latest
         WHERE crowd_record_id = ${observationId} FOR UPDATE`;
      if (target === undefined) return { code: 404, error: "target observation not found" };
      if (action !== "flag" && target.expired) {
        return { code: 409, error: "target observation has ended" };
      }
      if (
        action !== "flag" &&
        (target.evidence_state === "externally_resolved" || target.evidence_state === "negated")
      ) {
        return { code: 409, error: "report already resolved" };
      }
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO conditions.sub_claim
          (id, subject_class, subject_id, claim_type, key_id, reason, geom, signature, created_at)
        VALUES (
          ${subClaimId}, 'observation', ${observationId}, ${action}, ${subClaim.keyId},
          ${subClaim.reason ?? null},
          ${geom === null ? null : tx`ST_SetSRID(ST_GeomFromGeoJSON(${geom}), 4326)`},
          ${subClaim.signature}, ${now}
        )
        ON CONFLICT DO NOTHING
        RETURNING id`;
      if (action === "flag") return { code: 200, action: "flag" };
      let evidenceState = target.evidence_state;
      if (inserted.length > 0) {
        await tx`
          INSERT INTO conditions.report_evidence
            (record_class, record_id, evidence_kind, actor_key_id, occurred_at, details)
          SELECT 'observation', ${observationId}, ${action}, ${subClaim.keyId}, ${now},
                 ${tx.json({ via: "sub-claim", subClaimId })}
          WHERE NOT EXISTS (
            SELECT 1 FROM conditions.report_evidence
             WHERE record_class = 'observation' AND record_id = ${observationId}
               AND evidence_kind = ${action} AND actor_key_id = ${subClaim.keyId})`;
        const result = await recomputeObservationEvidence(tx, registry, observationId, now);
        if (result !== null) evidenceState = result.state;
      }
      return {
        code: 200,
        action,
        record: { class: "observation", id: observationId },
        evidenceState,
      };
    });
  } catch (err) {
    if (isGeometryError(err)) throw new GeometryInvalidError(err);
    throw err;
  }
}
