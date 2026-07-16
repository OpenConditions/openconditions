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
  validateDeviceProof,
  type DeviceProof,
  type Entitlement,
  type ReporterRow,
} from "./policy.js";
import {
  UNVERIFIED_ATTESTATION,
  UNVERIFIED_OSM_AUTH,
  type AttestationVerifier,
  type OsmAuthVerifier,
} from "./verifier.js";

export interface EnrollLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
}

/**
 * Sanitize a verifier's thrown error for logging. A real attestation / OSM-auth
 * verifier's error could embed the raw secret (token or attestation blob) in its
 * `message` or `stack`; passing the {@link Error} straight to the logger would
 * leak it, because pino's default `err` serializer emits both. This returns a
 * plain `{ name, message }` shape (NO stack) with every occurrence of the secret
 * redacted, so the secret can never reach the log stream.
 */
function redactSecretFromError(
  err: unknown,
  secret: string | undefined
): {
  name?: string;
  message: string;
} {
  const asError = err instanceof Error ? err : undefined;
  const rawMessage = asError?.message ?? String(err);
  const message =
    secret !== undefined && secret.length > 0
      ? rawMessage.replaceAll(secret, "[redacted-secret]")
      : rawMessage;
  return { name: asError?.name, message };
}

export interface EnrollDeps {
  grantSecret: Uint8Array;
  log: EnrollLogger;
  /**
   * Verifies a presented platform-attestation blob. Only a `verified: true`
   * result grants the advisory trust bump — a present-but-unverified (e.g.
   * forged) attestation adds nothing. Defaults to {@link UNVERIFIED_ATTESTATION},
   * which confirms nothing until a real platform verifier is wired in.
   */
  attestationVerifier?: AttestationVerifier;
  /**
   * Verifies a presented OSM auth token. Only a `verified: true` result grants
   * the advisory trust bump — a present-but-unverified token adds nothing.
   * Defaults to {@link UNVERIFIED_OSM_AUTH}, which confirms nothing until a real
   * OSM API verifier is wired in.
   */
  osmAuthVerifier?: OsmAuthVerifier;
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
  // Reject malformed optional proof fields at the trust boundary before any of
  // them reaches a verifier typed to trust their shape (throws TypeError → 400).
  validateDeviceProof(proof);
  const thumbprint = await keyIdFromJwk(pubJwk);
  if (proof.keyId !== thumbprint) {
    throw new TypeError("enrollReporter: proof.keyId does not match the pubJwk thumbprint");
  }

  const existingRows = await sql<
    { status: "active" | "blocked"; corroborated_count: number; created_at: Date }[]
  >`
    SELECT status, corroborated_count, created_at
    FROM conditions.reporter WHERE key_id = ${thumbprint}
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
          // Tenure comes from the pre-insert created_at (set once, never reset).
          // A block-before-enroll synthetic row has no real created_at → null →
          // zero tenure, never a crash.
          createdAt: existingRows[0]?.created_at ?? null,
        };

  // Resolve the attestation verdict OUT of the pure policy: a present blob only
  // earns the trust bump when the injected verifier confirms it. Absent or
  // unverified attestation is never a gate — the reporter stays fully eligible.
  const verifier = deps.attestationVerifier ?? UNVERIFIED_ATTESTATION;
  let attestationVerified = false;
  if (proof.attestation !== undefined) {
    try {
      const outcome = await verifier.verify(proof.attestation, { keyId: thumbprint });
      attestationVerified = outcome.verified;
    } catch (err) {
      // A verifier fault is treated as "unverified" — attestation is advisory
      // and must NEVER gate enrollment. The reporter stays fully eligible; it
      // simply earns no attestation trust bump. Scrub the attestation blob from
      // the logged error: a real Play Integrity / App Attest verifier's error
      // could embed the blob in its message/stack.
      attestationVerified = false;
      deps.log.warn(
        { err: redactSecretFromError(err, proof.attestation.blob), keyId: thumbprint },
        "attestation verifier threw; treating as unverified"
      );
    }
  }

  // Resolve the OSM-auth verdict the same way: a present token only earns the
  // trust bump when the injected verifier confirms it. Absent or unverified
  // osmAuth is never a gate — the reporter stays fully eligible.
  const osmAuthVerifier = deps.osmAuthVerifier ?? UNVERIFIED_OSM_AUTH;
  let osmAuthVerified = false;
  if (proof.osmAuth !== undefined) {
    try {
      const outcome = await osmAuthVerifier.verify(proof.osmAuth, { keyId: thumbprint });
      osmAuthVerified = outcome.verified;
    } catch (err) {
      // A verifier fault is treated as "unverified" — osmAuth is advisory and
      // must NEVER gate enrollment. Scrub the token from the logged error: a real
      // OSM verifier's error could embed the token value in its message/stack, so
      // the raw Error is never passed to the logger.
      osmAuthVerified = false;
      deps.log.warn(
        { err: redactSecretFromError(err, proof.osmAuth), keyId: thumbprint },
        "osm auth verifier threw; treating as unverified"
      );
    }
  }

  const entitlement = assessEntitlement(proof, {
    now: nowIso,
    reporterRow,
    attestationVerified,
    osmAuthVerified,
  });

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
