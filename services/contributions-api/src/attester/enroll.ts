/**
 * Reporter enrollment — the write side of the attester. Verifies that the
 * proof's keyId really is the RFC 7638 thumbprint of the presented public
 * JWK, applies the pure policy, upserts conditions.reporter, and mints the
 * HMAC reporting grant for non-blocked reporters.
 *
 * Re-enrollment NEVER resets reputation: the upsert's conflict branch touches
 * last_active_at, trust_signal, and entitlement_expires_at only.
 */
import type postgres from "postgres";
import { keyIdFromJwk } from "@openconditions/contrib-core";
import { createReportingGrant } from "./grant.js";
import {
  ATTESTER_POLICY,
  assessEntitlement,
  type DeviceProof,
  type Entitlement,
  type ReporterRow,
} from "./policy.js";

export interface EnrollLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
}

export interface EnrollDeps {
  grantSecret: Uint8Array;
  log: EnrollLogger;
}

/**
 * Enrolls (or re-enrolls) a reporter key and returns its entitlement. For a
 * blocked reporter the entitlement carries zero tokens and no grant.
 *
 * @throws TypeError when `proof.keyId` does not match the thumbprint of
 *   `pubJwk` (or the JWK itself is invalid) — a caller asserting someone
 *   else's key must fail loudly.
 */
export async function enrollReporter(
  sql: postgres.Sql,
  pubJwk: JsonWebKey,
  proof: DeviceProof,
  nowIso: string,
  deps: EnrollDeps
): Promise<Entitlement> {
  const thumbprint = await keyIdFromJwk(pubJwk);
  if (proof.keyId !== thumbprint) {
    throw new TypeError("enrollReporter: proof.keyId does not match the pubJwk thumbprint");
  }

  const existingRows = await sql<{ status: "active" | "blocked"; corroborated_count: number }[]>`
    SELECT status, corroborated_count FROM conditions.reporter WHERE key_id = ${thumbprint}
  `;

  // A key on the operator block list can never (re-)enroll to active — even if
  // it has no reporter row yet (block-before-enroll). The block list is the
  // source of truth; enrollment reflects it and fails closed.
  const blockRows = await sql`
    SELECT 1 FROM conditions.block_list WHERE key_id = ${thumbprint}
  `;
  const isBlockListed = blockRows.length > 0;

  const effectiveStatus: "active" | "blocked" = isBlockListed
    ? "blocked"
    : (existingRows[0]?.status ?? "active");
  const reporterRow: ReporterRow | null =
    existingRows[0] === undefined && !isBlockListed
      ? null
      : {
          keyId: thumbprint,
          status: effectiveStatus,
          corroboratedCount: existingRows[0]?.corroborated_count ?? 0,
        };

  const entitlement = assessEntitlement(proof, { now: nowIso, reporterRow });

  const now = new Date(nowIso);
  const expiresAt = new Date(now.getTime() + ATTESTER_POLICY.entitlementTtlMs);
  await sql`
    INSERT INTO conditions.reporter
      (key_id, pub_jwk, reputation_alpha, reputation_beta, trust_signal,
       entitlement_expires_at, status, created_at, last_active_at)
    VALUES
      (${thumbprint}, ${sql.json(pubJwk as never)}, ${ATTESTER_POLICY.cohortPriorAlpha},
       ${ATTESTER_POLICY.cohortPriorBeta}, ${entitlement.trustSignal}, ${expiresAt},
       ${isBlockListed ? "blocked" : "active"}, ${now}, ${now})
    ON CONFLICT (key_id) DO UPDATE SET
      last_active_at = EXCLUDED.last_active_at,
      trust_signal = EXCLUDED.trust_signal,
      entitlement_expires_at = EXCLUDED.entitlement_expires_at,
      status = CASE WHEN ${isBlockListed} THEN 'blocked' ELSE conditions.reporter.status END
  `;

  deps.log.info(
    {
      keyId: thumbprint,
      outcome: entitlement.grantTokens > 0 ? "enrolled" : "blocked",
      trustSignal: entitlement.trustSignal,
    },
    "reporter enrollment assessed"
  );

  if (entitlement.grantTokens === 0) {
    return entitlement;
  }
  const reportingGrant = await createReportingGrant(thumbprint, nowIso, deps.grantSecret);
  return { ...entitlement, reportingGrant };
}
