/**
 * Attester policy — the PURE entitlement decision for the commons' single
 * Sybil-cost gate. No I/O, no crypto: {@link assessEntitlement} maps a device
 * proof plus what we already know about the reporter to an {@link Entitlement}.
 *
 * Honesty constraints (binding, from the architecture record):
 * - Attestation (Play Integrity / App Attest / Android Keystore) is a SOFT
 *   advisory signal, NEVER a gate. A device with no attestation at all
 *   (GrapheneOS, F-Droid builds) is fully eligible. v1 does NOT verify
 *   attestation blobs cryptographically — there are no vendor keys here; only
 *   the KIND and PRESENCE of an attestation feed `trustSignal`.
 * - `grantTokens` bounds token ISSUANCE per epoch. N redeemed tokens do NOT
 *   prove N distinct contributors, and per-cell bounding is NOT provided here
 *   (the probe plan's gate owns that problem).
 * - Nothing in this module proves one-report-one-human. `trustSignal` is an
 *   advisory 0..1 input to reputation/confidence weighting, nothing more.
 */

export interface DeviceProof {
  /** RFC 7638 thumbprint of the reporter's public key. */
  keyId: string;
  /** Self-declared age of the client-side key/account, in whole days. */
  accountAgeDays?: number;
  /**
   * Optional platform attestation. Recorded as kind + presence only — the
   * blob is NOT cryptographically verified in v1 and is never sent anywhere.
   */
  attestation?: { kind: "android-keystore" | "app-attest" | "play-integrity"; blob: string };
  /** Presence of an OSM auth token; OSM-side verification is a later task. */
  osmAuth?: string;
}

export interface Entitlement {
  /**
   * HMAC reporting grant, minted by the enrollment flow. Empty from
   * {@link assessEntitlement} itself — policy is pure; the caller mints the
   * grant (see attester/grant.ts) for non-blocked reporters.
   */
  reportingGrant: string;
  /** Per-epoch token-issuance ceiling for this key. A quota, not a proof. */
  grantTokens: number;
  /** Advisory 0..1 signal for reputation/confidence weighting. */
  trustSignal: number;
  /** Human-readable summary of how the decision was reached. */
  reason: string;
}

/** The subset of a conditions.reporter row the policy consults. */
export interface ReporterRow {
  keyId: string;
  status: "active" | "blocked";
  corroboratedCount: number;
}

export interface AttesterCtx {
  /** ISO 8601 instant of the assessment. */
  now: string;
  /** The existing reporter row for this key, if any. */
  reporterRow?: ReporterRow | null;
}

/**
 * Data-driven policy constants. Change the numbers here, not the code paths.
 */
export const ATTESTER_POLICY = {
  /** Per-epoch issuance ceiling granted to every eligible key. */
  grantTokensPerEpoch: 20,
  /** Reporting-grant lifetime. */
  grantTtlMs: 24 * 60 * 60 * 1000,
  /** conditions.reporter entitlement window written at enrollment. */
  entitlementTtlMs: 24 * 60 * 60 * 1000,
  /** Cohort prior for a brand-new reporter's Beta reliability posterior. */
  cohortPriorAlpha: 2,
  cohortPriorBeta: 2,
  /** Enrollment endpoint rate limit, per client IP. */
  enrollRateLimitPerMinute: 10,
  /** Additive trustSignal weights (clamped to [0, 1] after summing). */
  trust: {
    base: 0.3,
    accountAgeAtLeast7Days: 0.2,
    accountAgeAtLeast30Days: 0.2,
    attestationPresent: 0.1,
    osmAuthPresent: 0.1,
    activeWithCorroboratedHistory: 0.1,
  },
} as const;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Pure entitlement policy. The ONLY zero-token path is an explicitly blocked
 * reporter; absence of signals (no attestation, no account age, no OSM auth)
 * never reduces `grantTokens` — it only leaves `trustSignal` at its base.
 */
export function assessEntitlement(proof: DeviceProof, ctx: AttesterCtx): Entitlement {
  const weights = ATTESTER_POLICY.trust;
  const reporter = ctx.reporterRow ?? null;

  const signals: string[] = [];
  let trust = weights.base;
  if (proof.accountAgeDays !== undefined && proof.accountAgeDays >= 7) {
    trust += weights.accountAgeAtLeast7Days;
    signals.push("account age >= 7d");
  }
  if (proof.accountAgeDays !== undefined && proof.accountAgeDays >= 30) {
    trust += weights.accountAgeAtLeast30Days;
    signals.push("account age >= 30d");
  }
  if (proof.attestation !== undefined) {
    trust += weights.attestationPresent;
    signals.push(`attestation present (${proof.attestation.kind}, unverified)`);
  }
  if (proof.osmAuth !== undefined) {
    trust += weights.osmAuthPresent;
    signals.push("osm auth present (unverified)");
  }
  if (reporter !== null && reporter.status === "active" && reporter.corroboratedCount > 0) {
    trust += weights.activeWithCorroboratedHistory;
    signals.push("corroborated history");
  }
  const trustSignal = clamp01(trust);

  if (reporter !== null && reporter.status === "blocked") {
    return {
      reportingGrant: "",
      grantTokens: 0,
      trustSignal,
      reason: "reporter key is blocked; no reporting grant is issued",
    };
  }

  return {
    reportingGrant: "",
    grantTokens: ATTESTER_POLICY.grantTokensPerEpoch,
    trustSignal,
    reason:
      signals.length > 0
        ? `eligible; advisory signals: ${signals.join(", ")}`
        : "eligible; no advisory signals beyond base trust",
  };
}
