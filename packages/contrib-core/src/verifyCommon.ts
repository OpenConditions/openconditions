import { fromBase64Url } from "./base64url.js";
import { assertCanonicalSignature } from "./lowS.js";
import { keyIdFromJwk } from "./thumbprint.js";

/**
 * Shared verification plumbing for reports and sub-claims: envelope checks,
 * verification-key resolution (knownJwk precedence, RFC 7638 keyId binding)
 * and raw-signature decoding. All crypto goes through platform WebCrypto.
 */

export const ECDSA_SIGN_PARAMS = { name: "ECDSA", hash: "SHA-256" } as const;

const ECDSA_IMPORT_PARAMS = { name: "ECDSA", namedCurve: "P-256" } as const;

/**
 * Assert that a JWK is a plausible P-256 public verification key. `key_ops`,
 * `ext`, `use` and `alg` are deliberately ignored — only the curve point
 * matters — but any private-key material is rejected outright.
 *
 * @throws TypeError naming the violated rule.
 */
export function assertPublicP256Jwk(jwk: JsonWebKey, label: string): void {
  if (jwk === null || typeof jwk !== "object") {
    throw new TypeError(`${label} must be a JWK object`);
  }
  if ((jwk as { d?: unknown }).d !== undefined) {
    throw new TypeError(`${label} contains private key material ("d"); supply only the public key`);
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") {
    throw new TypeError(`${label} must be an EC P-256 public JWK`);
  }
  if (typeof jwk.x !== "string" || !jwk.x || typeof jwk.y !== "string" || !jwk.y) {
    throw new TypeError(`${label} is missing the "x"/"y" coordinates`);
  }
}

/**
 * Resolve which JWK verifies a signature. A server-cached `knownJwk` always
 * takes precedence over the embedded `pubJwk`; when both are present they
 * must be the same key (same RFC 7638 thumbprint). The envelope `keyId` must
 * equal the resolved key's thumbprint, binding the unsigned envelope to the
 * signed bytes.
 */
export async function resolveVerificationJwk(
  keyId: string,
  pubJwk: JsonWebKey | undefined,
  knownJwk: JsonWebKey | undefined
): Promise<{ jwk: JsonWebKey } | { error: string }> {
  if (pubJwk !== undefined) assertPublicP256Jwk(pubJwk, "pubJwk");
  if (knownJwk !== undefined) assertPublicP256Jwk(knownJwk, "knownJwk");
  const jwk = knownJwk ?? pubJwk;
  if (jwk === undefined) {
    return { error: "no public key: the envelope carries no pubJwk and no known key was supplied" };
  }
  if (knownJwk !== undefined && pubJwk !== undefined) {
    const [knownThumbprint, embeddedThumbprint] = await Promise.all([
      keyIdFromJwk(knownJwk),
      keyIdFromJwk(pubJwk),
    ]);
    if (knownThumbprint !== embeddedThumbprint) {
      return { error: "embedded pubJwk does not match the known key for this reporter" };
    }
  }
  const thumbprint = await keyIdFromJwk(jwk);
  if (thumbprint !== keyId) {
    return {
      error: `keyId does not match the RFC 7638 thumbprint of the verification key ("${thumbprint}")`,
    };
  }
  return { jwk };
}

/** Import a validated public JWK as a WebCrypto verification key. */
export async function importVerifyKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "jwk",
    { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y },
    ECDSA_IMPORT_PARAMS,
    false,
    ["verify"]
  );
}

/**
 * Decode a base64url ES256 signature to its raw 64-byte r||s form and
 * enforce signature canonicality (low-S).
 *
 * @throws TypeError on malformed base64url, on a DER-encoded signature
 *   (WebCrypto's ECDSA format is raw r||s, never ASN.1), on any other length
 *   mismatch, and on a non-canonical (r, s) pair — r/s out of [1, n-1] or a
 *   high-S twin (see `assertCanonicalSignature`).
 */
export function decodeRawSignature(signature: string): Uint8Array<ArrayBuffer> {
  const bytes = fromBase64Url(signature);
  if (bytes.length !== 64) {
    if (bytes[0] === 0x30) {
      throw new TypeError(
        "signature appears DER-encoded; ES256 signatures must be the raw 64-byte r||s concatenation"
      );
    }
    throw new TypeError(
      `signature must decode to exactly 64 bytes (raw r||s), got ${bytes.length}`
    );
  }
  assertCanonicalSignature(bytes);
  return bytes;
}

/** Normalize a thrown validation/crypto error into a verify-result message. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
