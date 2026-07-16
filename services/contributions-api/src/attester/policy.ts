/**
 * Attester policy — the PURE entitlement decision for the commons' single
 * Sybil-cost gate. No I/O, no crypto: {@link assessEntitlement} maps a device
 * proof plus what we already know about the reporter to an {@link Entitlement}.
 *
 * Honesty constraints (binding, from the architecture record):
 * - Attestation (Play Integrity / App Attest / Android Keystore) is a SOFT
 *   advisory signal, NEVER a gate. A device with no attestation at all
 *   (GrapheneOS, F-Droid builds) is fully eligible. The attestation trust bump
 *   requires an actual verification result (`ctx.attestationVerified === true`),
 *   NOT the mere presence of a blob — a forgeable, unverified blob buys no
 *   trust. The async caller resolves that boolean through the pluggable
 *   {@link ./verifier.AttestationVerifier} seam; this pure policy only consumes
 *   the already-decided verdict.
 * - `grantTokens` bounds token ISSUANCE per epoch. N redeemed tokens do NOT
 *   prove N distinct contributors, and per-cell bounding is NOT provided here
 *   (the probe plan's gate owns that problem).
 * - Nothing in this module proves one-report-one-human. `trustSignal` is an
 *   advisory 0..1 input to reputation/confidence weighting, nothing more.
 */

export interface DeviceProof {
  /** RFC 7638 thumbprint of the reporter's public key. */
  keyId: string;
  /**
   * @deprecated IGNORED by the trust computation. Account tenure is now derived
   * server-side from the reporter's `created_at` (see {@link AttesterCtx}), so a
   * self-declared age buys no trust. Retained on the wire only for
   * backward-compatibility; a future major may drop it.
   */
  accountAgeDays?: number;
  /**
   * Optional platform attestation. The blob is verified out-of-band by the
   * caller's {@link ./verifier.AttestationVerifier}; the policy only grants a
   * trust bump when that verification succeeded (see `attestationVerified`).
   */
  attestation?: { kind: "android-keystore" | "app-attest" | "play-integrity"; blob: string };
  /**
   * Optional OSM auth token. The token is verified out-of-band by the caller's
   * {@link ./verifier.OsmAuthVerifier}; the policy only grants a trust bump when
   * that verification succeeded (see `osmAuthVerified`) — mere presence buys
   * nothing.
   */
  osmAuth?: string;
}

const ATTESTATION_KINDS = ["android-keystore", "app-attest", "play-integrity"] as const;

/**
 * Shape-validates the OPTIONAL fields of a DeviceProof at the trust boundary.
 * `keyId` is validated by the enroll route; this rejects malformed optional
 * fields — a null/garbage `attestation`, a non-string `osmAuth`, a non-finite
 * `accountAgeDays` — so a lie like `attestation: null` (which passes a bare
 * `!== undefined` check) never reaches a verifier typed to trust its shape.
 * Absent fields are fine (all optional). Throws {@link TypeError}, which the
 * enroll route maps to a 400. Does NOT judge trust — a well-formed field still
 * only earns a bump when its verifier confirms it.
 */
export function validateDeviceProof(proof: DeviceProof): void {
  if (
    proof.accountAgeDays !== undefined &&
    (typeof proof.accountAgeDays !== "number" || !Number.isFinite(proof.accountAgeDays))
  ) {
    throw new TypeError("proof.accountAgeDays must be a finite number when present");
  }
  if (proof.osmAuth !== undefined && typeof proof.osmAuth !== "string") {
    throw new TypeError("proof.osmAuth must be a string when present");
  }
  if (proof.attestation !== undefined) {
    const attestation: unknown = proof.attestation;
    if (attestation === null || typeof attestation !== "object" || Array.isArray(attestation)) {
      throw new TypeError("proof.attestation must be an object when present");
    }
    const { kind, blob } = attestation as { kind?: unknown; blob?: unknown };
    if (typeof kind !== "string" || !ATTESTATION_KINDS.includes(kind as never)) {
      throw new TypeError(
        "proof.attestation.kind must be one of android-keystore, app-attest, play-integrity"
      );
    }
    if (typeof blob !== "string" || blob.length === 0) {
      throw new TypeError("proof.attestation.blob must be a non-empty string");
    }
  }
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
  /**
   * When this reporter key was first enrolled (set once at INSERT, never
   * overwritten on re-enroll). Account tenure is derived from this instant —
   * NULL for a synthetic block-before-enroll row that has no real created_at,
   * which resolves to zero tenure.
   */
  createdAt: Date | null;
}

export interface AttesterCtx {
  /** ISO 8601 instant of the assessment. */
  now: string;
  /** The existing reporter row for this key, if any. */
  reporterRow?: ReporterRow | null;
  /**
   * Whether the presented attestation blob was actually verified by the
   * caller's {@link ./verifier.AttestationVerifier}. The attestation trust bump
   * is granted ONLY when this is true — never on mere presence. Defaults to
   * false (unverified), so a fabricated blob buys no trust.
   */
  attestationVerified?: boolean;
  /**
   * Whether the presented OSM auth token was actually verified by the caller's
   * {@link ./verifier.OsmAuthVerifier}. The osmAuth trust bump is granted ONLY
   * when this is true — never on mere presence. Defaults to false (unverified),
   * so a self-asserted token buys no trust.
   */
  osmAuthVerified?: boolean;
}

/** Whole days between the reporter's first enrollment and the assessment. */
function tenureDays(createdAt: Date | null, nowIso: string): number {
  if (createdAt === null) return 0;
  return (Date.parse(nowIso) - createdAt.getTime()) / 86_400_000;
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

  // Tenure is SERVER-observed (now − reporter.created_at), never the client's
  // self-declared proof.accountAgeDays — a self-asserted age buys no trust.
  const tenure = tenureDays(reporter?.createdAt ?? null, ctx.now);

  const signals: string[] = [];
  let trust = weights.base;
  if (tenure >= 7) {
    trust += weights.accountAgeAtLeast7Days;
  }
  if (tenure >= 30) {
    trust += weights.accountAgeAtLeast30Days;
  }
  if (tenure >= 7) {
    signals.push(`tenure ${Math.floor(tenure)}d (server-observed)`);
  }
  if (proof.attestation !== undefined && ctx.attestationVerified === true) {
    trust += weights.attestationPresent;
    signals.push(`attestation verified (${proof.attestation.kind})`);
  }
  if (proof.osmAuth !== undefined && ctx.osmAuthVerified === true) {
    trust += weights.osmAuthPresent;
    signals.push("osm auth verified");
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
