/**
 * Minimal base58btc + Multikey (did:key style) codec for Ed25519 public keys.
 *
 * publicKeyMultibase = 'z' (multibase base58btc) over the multicodec
 * ed25519-pub varint prefix (0xed 0x01) followed by the raw 32-byte public
 * key — every valid value therefore starts with "z6Mk". Hand-rolled on
 * purpose (the brief forbids pulling a multiformats dependency for a fixed
 * 2-byte prefix) and pinned against did:key / RFC 8032 reference vectors in
 * the tests.
 */

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const BASE58_INDEX = new Map<string, number>(
  Array.from(BASE58_ALPHABET, (char, index) => [char, index])
);

/** Multicodec varint prefix for ed25519-pub. */
const ED25519_PUB_PREFIX: readonly [number, number] = [0xed, 0x01];

/** Raw Ed25519 public keys are always exactly 32 bytes. */
export const ED25519_PUBLIC_KEY_BYTES = 32;

/**
 * A valid Ed25519 Multikey multibase is exactly 48 characters ('z' + base58btc
 * of the 34-byte prefixed key). base58btcDecode is O(n^2) in the input length
 * (BigInt long division), and a later task decodes multibases from FETCHED
 * remote actor documents, so cap the length well above the real maximum and
 * reject anything longer before entering the BigInt loop — a hostile multi-KB
 * string fails fast instead of pinning a CPU.
 */
const MAX_MULTIBASE_LENGTH = 64;

/** Encodes bytes as base58btc (Bitcoin alphabet, leading zeros as '1'). */
export function base58btcEncode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  return "1".repeat(zeros) + encoded;
}

/** Decodes base58btc; throws TypeError on any character outside the alphabet. */
export function base58btcDecode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;

  let value = 0n;
  for (const char of text) {
    const digit = BASE58_INDEX.get(char);
    if (digit === undefined) {
      throw new TypeError(`invalid base58btc character ${JSON.stringify(char)}`);
    }
    value = value * 58n + BigInt(digit);
  }

  const digits: number[] = [];
  while (value > 0n) {
    digits.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...digits]);
}

/**
 * Encodes a raw 32-byte Ed25519 public key as its publicKeyMultibase
 * ("z6Mk…") Multikey form. This string doubles as the key's stable id and as
 * the fingerprint operators exchange out-of-band for bilateral pinning: it is
 * self-describing (multibase + multicodec), so no separate hash form is used.
 */
export function multibaseFromRawEd25519(publicKey: Uint8Array): string {
  if (publicKey.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new TypeError(
      `expected a raw ${ED25519_PUBLIC_KEY_BYTES}-byte Ed25519 public key, got ${publicKey.length} bytes`
    );
  }
  const prefixed = new Uint8Array(ED25519_PUB_PREFIX.length + publicKey.length);
  prefixed.set(ED25519_PUB_PREFIX, 0);
  prefixed.set(publicKey, ED25519_PUB_PREFIX.length);
  return "z" + base58btcEncode(prefixed);
}

/**
 * Decodes a publicKeyMultibase back to the raw 32-byte Ed25519 public key.
 * Throws TypeError when the multibase prefix is not 'z' (base58btc), the
 * multicodec prefix is not ed25519-pub, the payload is not 32 bytes, or the
 * base58 body is corrupted.
 */
export function rawEd25519FromMultibase(multibase: string): Uint8Array {
  if (multibase.length > MAX_MULTIBASE_LENGTH) {
    throw new TypeError(
      `publicKeyMultibase too long (${multibase.length} chars; max ${MAX_MULTIBASE_LENGTH})`
    );
  }
  if (!multibase.startsWith("z")) {
    throw new TypeError("publicKeyMultibase must be base58btc (leading 'z')");
  }
  const decoded = base58btcDecode(multibase.slice(1));
  if (decoded[0] !== ED25519_PUB_PREFIX[0] || decoded[1] !== ED25519_PUB_PREFIX[1]) {
    throw new TypeError("multicodec prefix is not ed25519-pub (0xed 0x01)");
  }
  const raw = decoded.slice(ED25519_PUB_PREFIX.length);
  if (raw.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new TypeError(
      `expected a ${ED25519_PUBLIC_KEY_BYTES}-byte Ed25519 public key payload, got ${raw.length} bytes`
    );
  }
  return raw;
}
