import type postgres from "postgres";
import type { EvidenceState } from "@openconditions/core";
import type { SignedSubClaim } from "@openconditions/contrib-core";
import { recomputeEvidence } from "../evidence/recompute.js";
import { GeometryInvalidError, isGeometryError } from "../landing/insert.js";

type Sql = postgres.Sql;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Jsonb = any;

export type VoteOutcome =
  | { code: 404; error: string }
  | { code: 409; error: string }
  | { code: 200; action: "flag" }
  | {
      code: 200;
      action: "confirm" | "negate";
      observationId: string;
      evidenceState: EvidenceState | null;
      routingEligible: boolean;
    };

interface ObservationVoteRow {
  status: string;
  evidence_state: EvidenceState | null;
  routing_eligible: boolean;
}

/**
 * Cast a verified, authorized sub-claim onto its target observation, atomically.
 *
 * All of it runs in ONE transaction that first takes `FOR UPDATE` on the target
 * observation (serializing concurrent votes and the recompute), then:
 *  - stores the signed sub-claim (`id = "sub:"+keyId+":"+nonce`). The UNIQUE
 *    (subject_id, key_id, claim_type) plus the id primary key make a repeat vote
 *    a no-op via `ON CONFLICT DO NOTHING` — one key can never double-count on a
 *    subject, and an exact replay (same nonce) collides on the id;
 *  - for `confirm`/`negate`, appends the matching `report_evidence` row (guarded
 *    by `WHERE NOT EXISTS` on (observation, kind, actor_key_id) so it can never
 *    double-append) and recomputes the observation's evidence state IN-TX. The
 *    corroboration/negation/retraction decision itself lives in core's
 *    `evaluateEvidence`; this only appends the row and recomputes;
 *  - for `flag`, appends NO evidence (a flag is not evidence of truth/falsehood)
 *    and instead lights `flagged_at` on the first flag; the state is untouched.
 *
 * On an idempotent replay (the sub-claim insert conflicted) no evidence is
 * appended and the observation's current derived state is returned unchanged.
 *
 * Callers MUST have already checked action validity, the grant, the signature,
 * claimType↔action agreement, subject resolution, reporter enrollment, AND the
 * geometry (a present geometry must be a plausibility-valid Point). The
 * `ST_GeomFromGeoJSON` path is still wrapped in a {@link GeometryInvalidError}
 * backstop so any residual PostGIS geometry error surfaces as a clean 422
 * rather than a 500, mirroring the landing path.
 */
export async function castSubClaimVote(
  sql: Sql,
  observationId: string,
  subClaim: SignedSubClaim,
  now: string
): Promise<VoteOutcome> {
  const action = subClaim.claimType;
  const subClaimId = `sub:${subClaim.keyId}:${subClaim.nonce}`;
  const geom = subClaim.geometry !== undefined ? JSON.stringify(subClaim.geometry) : null;

  try {
    return await castWithin(sql, observationId, subClaim, action, subClaimId, geom, now);
  } catch (err) {
    if (isGeometryError(err)) {
      throw new GeometryInvalidError(err);
    }
    throw err;
  }
}

async function castWithin(
  sql: Sql,
  observationId: string,
  subClaim: SignedSubClaim,
  action: "confirm" | "negate" | "flag",
  subClaimId: string,
  geom: string | null,
  now: string
): Promise<VoteOutcome> {
  return sql.begin(async (tx) => {
    const obsRows = await tx<ObservationVoteRow[]>`
      SELECT status, evidence_state, routing_eligible
      FROM conditions.observations WHERE id = ${observationId} FOR UPDATE
    `;
    const obs = obsRows[0];
    if (obs === undefined) {
      return { code: 404, error: "target observation not found" };
    }
    if (obs.status !== "active") {
      return { code: 409, error: "target observation is not active" };
    }

    const inserted = await tx<{ id: string }[]>`
      INSERT INTO conditions.sub_claim
        (id, subject_id, claim_type, key_id, reason, geom, signature, created_at)
      VALUES (
        ${subClaimId}, ${observationId}, ${action}, ${subClaim.keyId},
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
          UPDATE conditions.observations SET flagged_at = ${now}
          WHERE id = ${observationId} AND flagged_at IS NULL
        `;
      }
      return { code: 200, action: "flag" };
    }

    if (isNew) {
      await tx`
        INSERT INTO conditions.report_evidence
          (observation_id, evidence_kind, actor_key_id, occurred_at, details)
        SELECT ${observationId}, ${action}, ${subClaim.keyId}, ${now},
               ${tx.json({ via: "sub-claim", subClaimId } as Jsonb)}
        WHERE NOT EXISTS (
          SELECT 1 FROM conditions.report_evidence
          WHERE observation_id = ${observationId}
            AND evidence_kind = ${action}
            AND actor_key_id = ${subClaim.keyId}
        )
      `;
      const result = await recomputeEvidence(sql, observationId, now, tx);
      return {
        code: 200,
        action,
        observationId,
        evidenceState: result?.state ?? obs.evidence_state,
        routingEligible: result?.routingEligible ?? obs.routing_eligible,
      };
    }

    return {
      code: 200,
      action,
      observationId,
      evidenceState: obs.evidence_state,
      routingEligible: obs.routing_eligible,
    };
  });
}
