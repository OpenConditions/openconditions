import { toBase64Url } from "./base64url.js";
import { boundedCanonicalBytes } from "./jcs.js";
import type { ReporterKey } from "./keys.js";
import { normalizeLowS } from "./lowS.js";
import type { ReportClaim, SignedReport, VerifyResult } from "./types.js";
import { validateReportClaim } from "./validate.js";
import {
  ECDSA_SIGN_PARAMS,
  decodeRawSignature,
  errorMessage,
  importVerifyKey,
  resolveVerificationJwk,
} from "./verifyCommon.js";

/**
 * Sign a report claim: ES256 (WebCrypto ECDSA P-256 + SHA-256) over the
 * claim's RFC 8785 canonical bytes, normalized to the canonical low-S form
 * (see `normalizeLowS`). The returned envelope embeds the public JWK for
 * first submission; a server that already caches the key may drop it.
 *
 * The size cap runs before the recursive claim validation so an oversized
 * payload is rejected without walking its whole tree.
 *
 * @throws TypeError when the claim violates the wire contract (see
 *   `validateReportClaim`) or exceeds the 64 KiB canonical size cap.
 */
export async function signReport(claim: ReportClaim, key: ReporterKey): Promise<SignedReport> {
  const bytes = boundedCanonicalBytes(claim, "claim");
  validateReportClaim(claim);
  const raw = await globalThis.crypto.subtle.sign(ECDSA_SIGN_PARAMS, key.privateKey, bytes);
  return {
    alg: "ES256",
    keyId: key.keyId,
    pubJwk: key.publicJwk,
    claim,
    signature: toBase64Url(normalizeLowS(new Uint8Array(raw) as Uint8Array<ArrayBuffer>)),
  };
}

/**
 * Verify a signed report. Never throws: every failed check is surfaced as
 * `{ ok: false, error }`. A server-cached `knownJwk` takes precedence over
 * the embedded `pubJwk` (and both must agree when present); the envelope
 * `keyId` must equal the verification key's RFC 7638 thumbprint.
 */
export async function verifyReport(
  report: SignedReport,
  knownJwk?: JsonWebKey
): Promise<VerifyResult> {
  try {
    if (report === null || typeof report !== "object") {
      return { ok: false, error: "report must be an object" };
    }
    if (report.alg !== "ES256") {
      return { ok: false, error: `alg must be exactly "ES256", got "${String(report.alg)}"` };
    }
    const resolved = await resolveVerificationJwk(report.keyId, report.pubJwk, knownJwk);
    if ("error" in resolved) {
      return { ok: false, error: resolved.error };
    }
    const bytes = boundedCanonicalBytes(report.claim, "claim");
    validateReportClaim(report.claim);
    const signature = decodeRawSignature(report.signature);
    const publicKey = await importVerifyKey(resolved.jwk);
    const ok = await globalThis.crypto.subtle.verify(
      ECDSA_SIGN_PARAMS,
      publicKey,
      signature,
      bytes
    );
    return ok
      ? { ok: true, keyId: report.keyId }
      : { ok: false, keyId: report.keyId, error: "signature verification failed" };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * The canonical URI naming a signed report — the subject a sub-claim
 * references. The signature is base64url, so the URN needs no escaping.
 *
 * @throws TypeError when the report carries no base64url signature.
 */
export function maresiUri(report: SignedReport): string {
  if (typeof report.signature !== "string" || !/^[A-Za-z0-9_-]+$/.test(report.signature)) {
    throw new TypeError("maresiUri requires a report with a base64url signature");
  }
  return `urn:openconditions:report:${report.signature}`;
}
