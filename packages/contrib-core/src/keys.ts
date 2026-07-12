import { keyIdFromJwk } from "./thumbprint.js";

/** A reporter's pseudonymous signing identity. */
export interface ReporterKey {
  /** base64url RFC 7638 thumbprint of {@link publicJwk} — the wire `keyId`. */
  keyId: string;
  /** Minimal public JWK carrying only the thumbprint members {crv, kty, x, y}. */
  publicJwk: JsonWebKey;
  /**
   * ECDSA P-256 signing key. Non-extractable unless generated with
   * `extractable: true`, so a default key can never leave the device.
   */
  privateKey: CryptoKey;
}

export interface GenerateReporterKeyOptions {
  /**
   * Opt-in seam for the future encrypted-backup/export path. Defaults to
   * false: default reporter keys are unrecoverable by design (see README).
   */
  extractable?: boolean;
}

/**
 * Generate a fresh P-256 reporter identity with platform WebCrypto. The
 * private key is created non-extractable by default; the public key is
 * always exportable (WebCrypto forces public keys extractable).
 */
export async function generateReporterKey(
  options: GenerateReporterKeyOptions = {}
): Promise<ReporterKey> {
  const pair = (await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    options.extractable ?? false,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const exported = await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk: JsonWebKey = {
    crv: "P-256",
    kty: "EC",
    x: exported.x,
    y: exported.y,
  };
  return {
    keyId: await keyIdFromJwk(publicJwk),
    publicJwk,
    privateKey: pair.privateKey,
  };
}
