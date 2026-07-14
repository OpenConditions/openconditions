/**
 * Optional mutual-TLS gate for a Tier-1 bilateral link — defence-in-depth
 * UNDER the mandatory RFC 9421 payload signing, never a replacement for it.
 *
 * When an operator marks a peer `mtlsRequired`, a request from that peer must,
 * in addition to carrying a valid federation signature, arrive over a TLS
 * connection whose client certificate the TLS layer verified (and, when
 * fingerprints are pinned, whose cert fingerprint is in the pinned set). A peer
 * without `mtlsRequired` — every Tier-0 / non-mTLS peer — is unaffected.
 *
 * This module is only the APPLICATION gate: it enforces `mtlsRequired` given
 * the TLS layer's verdict. Actually requesting and verifying client certs is
 * OPERATOR infra — the Tier-1 bilateral link's HTTPS server must be configured
 * with `requestCert: true` and a trusted `ca: [...]` so the socket carries an
 * authorized peer certificate for this gate to read.
 */

/** The TLS layer's verdict on a request's client certificate. */
export interface MtlsContext {
  /** The TLS layer verified the presented client cert against a trusted CA/pin. */
  authorized: boolean;
  /** The presented client cert's fingerprint, for pinning against the peer record. */
  fingerprint?: string;
}

/** The gate's decision; `reason` names the failure for the Federation-Reason header. */
export interface MtlsResult {
  ok: boolean;
  reason?: string;
}

/**
 * Applies a peer's optional mTLS requirement to the request's TLS client-cert
 * context:
 *  - a peer that does not require mTLS → always ok (non-mTLS peers unaffected);
 *  - required but no verified cert (missing or unauthorized) → `mtls-required`;
 *  - required, authorized, and fingerprints pinned → the presented fingerprint
 *    must be in the pinned set, else `mtls-fingerprint-mismatch`;
 *  - required, authorized, no fingerprints pinned → ok (CA-trust only).
 */
export function checkMtls(
  peer: { mtlsRequired?: boolean; mtlsFingerprints?: string[] },
  cert: MtlsContext | undefined
): MtlsResult {
  if (peer.mtlsRequired !== true) return { ok: true };
  if (cert === undefined || !cert.authorized) return { ok: false, reason: "mtls-required" };
  const pins = peer.mtlsFingerprints;
  if (pins !== undefined && pins.length > 0) {
    if (cert.fingerprint === undefined || !pins.includes(cert.fingerprint)) {
      return { ok: false, reason: "mtls-fingerprint-mismatch" };
    }
  }
  return { ok: true };
}
