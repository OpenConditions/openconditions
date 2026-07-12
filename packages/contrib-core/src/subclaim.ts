import { toBase64Url } from "./base64url.js";
import { boundedCanonicalBytes } from "./jcs.js";
import type { ReporterKey } from "./keys.js";
import { normalizeLowS } from "./lowS.js";
import type { SignedSubClaim, SubClaimBody, VerifyResult } from "./types.js";
import { ENVELOPE_FIELDS, validateSubClaimBody } from "./validate.js";
import {
  ECDSA_SIGN_PARAMS,
  decodeRawSignature,
  errorMessage,
  importVerifyKey,
  resolveVerificationJwk,
} from "./verifyCommon.js";

/**
 * Extract the signable body from a signed sub-claim: every own field except
 * the envelope (alg/keyId/pubJwk/signature). Sign and verify must agree on
 * this projection byte-for-byte, which is why bodies carrying envelope-named
 * fields are rejected at signing time.
 */
function subClaimBodyOf(sub: SignedSubClaim): SubClaimBody {
  const body: Record<string, unknown> = {};
  const envelope = new Set<string>(ENVELOPE_FIELDS);
  for (const [key, value] of Object.entries(sub)) {
    if (!envelope.has(key)) body[key] = value;
  }
  return body as unknown as SubClaimBody;
}

/**
 * Sign a sub-claim body: ES256 over the body's RFC 8785 canonical bytes —
 * the body WITHOUT alg/keyId/pubJwk/signature — normalized to the canonical
 * low-S form (see `normalizeLowS`). The size cap runs before the recursive
 * body validation so an oversized payload is rejected without walking its
 * whole tree.
 *
 * @throws TypeError when the body violates the wire contract (see
 *   `validateSubClaimBody`) or exceeds the 64 KiB canonical size cap.
 */
export async function signSubClaim(body: SubClaimBody, key: ReporterKey): Promise<SignedSubClaim> {
  const bytes = boundedCanonicalBytes(body, "subClaim body");
  validateSubClaimBody(body);
  const raw = await globalThis.crypto.subtle.sign(ECDSA_SIGN_PARAMS, key.privateKey, bytes);
  return {
    ...body,
    alg: "ES256",
    keyId: key.keyId,
    pubJwk: key.publicJwk,
    signature: toBase64Url(normalizeLowS(new Uint8Array(raw) as Uint8Array<ArrayBuffer>)),
  };
}

/**
 * Verify a signed sub-claim. Never throws: every failed check is surfaced as
 * `{ ok: false, error }`. The signature covers only the body, but the
 * unsigned envelope is still bound: `alg` must be exactly "ES256" and
 * `keyId` must equal the verification key's RFC 7638 thumbprint.
 */
export async function verifySubClaim(
  sub: SignedSubClaim,
  knownJwk?: JsonWebKey
): Promise<VerifyResult> {
  try {
    if (sub === null || typeof sub !== "object") {
      return { ok: false, error: "sub-claim must be an object" };
    }
    if (sub.alg !== "ES256") {
      return { ok: false, error: `alg must be exactly "ES256", got "${String(sub.alg)}"` };
    }
    const resolved = await resolveVerificationJwk(sub.keyId, sub.pubJwk, knownJwk);
    if ("error" in resolved) {
      return { ok: false, error: resolved.error };
    }
    const body = subClaimBodyOf(sub);
    const bytes = boundedCanonicalBytes(body, "subClaim body");
    validateSubClaimBody(body);
    const signature = decodeRawSignature(sub.signature);
    const publicKey = await importVerifyKey(resolved.jwk);
    const ok = await globalThis.crypto.subtle.verify(
      ECDSA_SIGN_PARAMS,
      publicKey,
      signature,
      bytes
    );
    return ok
      ? { ok: true, keyId: sub.keyId }
      : { ok: false, keyId: sub.keyId, error: "signature verification failed" };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
