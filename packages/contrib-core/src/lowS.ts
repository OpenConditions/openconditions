/**
 * Low-S signature canonicalization for P-256 ECDSA (COSE / BIP-62 style).
 *
 * ECDSA is inherently malleable: for any valid signature (r, s) the pair
 * (r, n - s) verifies too, so a third party observing a signed report could
 * mint a SECOND, different-but-valid signature — and with it a second
 * `maresiUri` — for the same artifact. Enforcing the low-S form (s <= n/2)
 * on the signing side and rejecting everything else on the verifying side
 * leaves exactly one accepted encoding per signature.
 *
 * This module is canonical-form NORMALIZATION of WebCrypto's raw r||s
 * output, not new cryptography: signatures are still produced and verified
 * exclusively by `crypto.subtle`; the only arithmetic here is a big-integer
 * compare and one subtraction against the public curve constant n.
 */

/** P-256 (secp256r1) group order n, from SEC 2 / FIPS 186-4. */
export const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** floor(n / 2): the largest s allowed in canonical (low-S) form. */
export const P256_HALF_ORDER = P256_ORDER >> 1n;

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function writeBigIntTo32(value: bigint, target: Uint8Array, offset: number): void {
  let rest = value;
  for (let i = offset + 31; i >= offset; i--) {
    target[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
}

/**
 * Return the low-S form of a raw 64-byte r||s signature: if s > n/2, s is
 * replaced by n - s (an equally valid signature over the same bytes under
 * the same key); a signature already in low-S form is returned as-is.
 *
 * @throws TypeError when the input is not exactly 64 bytes.
 */
export function normalizeLowS(raw: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  if (raw.length !== 64) {
    throw new TypeError(`normalizeLowS requires a raw 64-byte r||s signature, got ${raw.length}`);
  }
  const s = bytesToBigInt(raw.subarray(32));
  if (s <= P256_HALF_ORDER) return raw;
  const normalized = new Uint8Array(raw) as Uint8Array<ArrayBuffer>;
  writeBigIntTo32(P256_ORDER - s, normalized, 32);
  return normalized;
}

/**
 * Reject any raw signature that is not in the single canonical form: r and s
 * must be in [1, n-1] and s must be low (s <= n/2). WebCrypto itself accepts
 * the high-S twin, so this check is what actually closes the malleability.
 *
 * @throws TypeError with a "non-canonical signature" message.
 */
export function assertCanonicalSignature(raw: Uint8Array): void {
  const r = bytesToBigInt(raw.subarray(0, 32));
  const s = bytesToBigInt(raw.subarray(32));
  if (r === 0n || r >= P256_ORDER) {
    throw new TypeError("non-canonical signature: r must be in [1, n-1]");
  }
  if (s === 0n) {
    throw new TypeError("non-canonical signature: s must be in [1, n/2]");
  }
  if (s > P256_HALF_ORDER) {
    throw new TypeError(
      "non-canonical signature: high-S form (s > n/2); only the low-S twin is accepted"
    );
  }
}
