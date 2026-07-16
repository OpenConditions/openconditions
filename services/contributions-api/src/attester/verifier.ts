/**
 * Attestation verification seam. The attester's trust bump for a platform
 * attestation (Play Integrity / App Attest / Android Keystore) MUST require an
 * actual verification result, never the mere PRESENCE of a blob — a forgeable
 * blob is worse than no signal, since a Sybil could otherwise buy trust for
 * free by sending arbitrary bytes.
 *
 * This module defines the pluggable {@link AttestationVerifier} contract plus
 * the default production {@link UNVERIFIED_ATTESTATION} verifier, which refuses
 * to confirm anything because no real platform verifier is wired here yet.
 * Real Play Integrity / App Attest / Android Key Attestation verification needs
 * Google/Apple infra and real device tokens; it is a mobile + infra FOLLOW-ON
 * that plugs into this seam by supplying its own {@link AttestationVerifier}.
 */

/** The platform attestation payload carried on a device proof. */
export interface AttestationClaim {
  kind: "android-keystore" | "app-attest" | "play-integrity";
  blob: string;
}

/** Context the verifier may need to bind the attestation to the reporter. */
export interface AttestationVerifierCtx {
  /** RFC 7638 thumbprint of the reporter key the attestation is claimed for. */
  keyId: string;
}

/** Outcome of a verification attempt. `verified` gates the trust bump. */
export interface AttestationVerificationResult {
  verified: boolean;
  reason?: string;
}

/**
 * Pluggable platform-attestation verifier. An implementation cryptographically
 * checks the blob against the relevant platform's roots and binds it to the
 * reporter key. Only a `verified: true` result grants the advisory trust bump.
 */
export interface AttestationVerifier {
  verify(
    attestation: AttestationClaim,
    ctx: AttestationVerifierCtx
  ): Promise<AttestationVerificationResult>;
}

/**
 * Default production verifier: confirms NOTHING. With no real platform verifier
 * wired, every attestation claim is treated as unverified, so a fabricated blob
 * grants no trust. Absent OR unverified attestation leaves the reporter fully
 * eligible — attestation is advisory, never a gate.
 */
export const UNVERIFIED_ATTESTATION: AttestationVerifier = {
  async verify() {
    return { verified: false, reason: "no-platform-verifier-configured" };
  },
};
