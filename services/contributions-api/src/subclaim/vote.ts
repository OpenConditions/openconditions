import type { SignedSubClaim } from "@openconditions/contrib-core";
import { crowdLocalId, type EvidenceState, type Registry } from "@openconditions/model";
import type postgres from "postgres";
import { lockCrowd } from "../crowd.js";
import { recomputeEvidence } from "../evidence/recompute.js";
import { GeometryInvalidError, isGeometryError } from "../landing/land.js";

type Sql = postgres.Sql;

export type VoteOutcome =
  | { code: 404; error: string }
  | { code: 409; error: string }
  | { code: 200; action: "flag" }
  | {
      code: 200;
      action: "confirm" | "negate";
      record: { class: "situation"; id: string };
      evidenceState: EvidenceState | null;
      routingEligible: boolean;
    };

interface SituationVoteRow {
  tombstoned: boolean;
  evidence_state: EvidenceState | null;
  routing_eligible: boolean;
}

/**
 * Cast a verified, authorized sub-claim onto its target situation, atomically.
 *
 * All of it runs in ONE transaction under the crowd lock that first takes
 * `FOR UPDATE` on the target (serializing concurrent votes and the
 * recompute), then:
 *  - stores the signed sub-claim (`id` = the hash of the key and the nonce).
 *    The UNIQUE (subject, key, type) plus the id primary key make a repeat
 *    vote a no-op via `ON CONFLICT DO NOTHING` — one key can never
 *    double-count on a subject, and an exact replay collides on the id;
 *  - for `confirm`/`negate`, appends the matching `report_evidence` row
 *    (guarded on (situation, kind, key) so it never double-appends) and
 *    recomputes the evidence of a crowd report IN-TX. The corroboration,
 *    negation and retraction decision itself lives in core's
 *    `evaluateEvidence`. A feed situation's vote is recorded but changes
 *    nothing: its lifetime is its source's;
 *  - for `flag`, appends NO evidence (a flag is not evidence of truth or
 *    falsehood) and instead lights `flagged_at` on the first flag.
 *
 * Callers MUST have already checked action validity, the grant, the
 * signature, claimType↔action agreement, the subject against the route,
 * reporter enrollment, AND the geometry.
 */
export async function castSubClaimVote(
  sql: Sql,
  registry: Registry,
  situationId: string,
  subClaim: SignedSubClaim,
  now: string,
): Promise<VoteOutcome> {
  try {
    return await castWithin(sql, registry, situationId, subClaim, now);
  } catch (err) {
    if (isGeometryError(err)) throw new GeometryInvalidError(err);
    throw err;
  }
}

async function castWithin(
  sql: Sql,
  registry: Registry,
  situationId: string,
  subClaim: SignedSubClaim,
  now: string,
): Promise<VoteOutcome> {
  const action = subClaim.claimType;
  const subClaimId = crowdLocalId(subClaim.keyId, subClaim.nonce);
  const geom = subClaim.geometry === undefined ? null : JSON.stringify(subClaim.geometry);
  return sql.begin(async (tx) => {
    await lockCrowd(tx);
    const [target] = await tx<SituationVoteRow[]>`
      SELECT tombstoned_at IS NOT NULL AS tombstoned, evidence_state, routing_eligible
      FROM conditions.situation WHERE id = ${situationId} FOR UPDATE
    `;
    if (target === undefined) return { code: 404, error: "target situation not found" };
    if (target.tombstoned) return { code: 409, error: "target situation has ended" };
    // A settled report is closed to peer voting: once an external resolution
    // has landed it (externally_resolved or negated), a confirm/negate can
    // neither corroborate nor negate it — and a confirm arriving AFTER the
    // resolution must never earn reputation off it. Flagging stays open.
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
        ${subClaimId}, 'situation', ${situationId}, ${action}, ${subClaim.keyId},
        ${subClaim.reason ?? null},
        ${geom === null ? null : tx`ST_SetSRID(ST_GeomFromGeoJSON(${geom}), 4326)`},
        ${subClaim.signature}, ${now}
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    const isNew = inserted.length > 0;

    if (action === "flag") {
      if (isNew) {
        await tx`
          UPDATE conditions.situation SET flagged_at = ${now}
          WHERE id = ${situationId} AND flagged_at IS NULL
        `;
      }
      return { code: 200, action: "flag" };
    }

    let state = { evidenceState: target.evidence_state, routingEligible: target.routing_eligible };
    if (isNew) {
      await tx`
        INSERT INTO conditions.report_evidence
          (record_class, record_id, evidence_kind, actor_key_id, occurred_at, details)
        SELECT 'situation', ${situationId}, ${action}, ${subClaim.keyId}, ${now},
               ${tx.json({ via: "sub-claim", subClaimId })}
        WHERE NOT EXISTS (
          SELECT 1 FROM conditions.report_evidence
          WHERE record_class = 'situation' AND record_id = ${situationId}
            AND evidence_kind = ${action}
            AND actor_key_id = ${subClaim.keyId}
        )
      `;
      const result = await recomputeEvidence(sql, registry, situationId, now, tx);
      if (result !== null) {
        state = { evidenceState: result.state, routingEligible: result.routingEligible };
      }
    }
    return { code: 200, action, record: { class: "situation", id: situationId }, ...state };
  });
}
