import canonicalize from "canonicalize";

/**
 * Upper bound on the canonical (JCS) byte length of a claim or sub-claim body.
 * Anything larger is rejected before signing or verification.
 */
export const MAX_CANONICAL_BYTES = 64 * 1024;

const encoder = new TextEncoder();

/**
 * RFC 8785 (JCS) canonical UTF-8 bytes of a claim tree — the exact bytes the
 * ES256 signatures cover. Exported so tests and downstream services can pin
 * signature inputs byte-for-byte. Canonicalization is delegated entirely to
 * the pinned `canonicalize` package (the JCS reference implementation);
 * nothing here is hand-rolled.
 *
 * @throws TypeError when the value contains a non-finite number, is nested
 *   too deeply to canonicalize, or is not JSON-serializable at all
 *   (undefined, function, symbol); Error on a circular reference
 *   (propagated from `canonicalize`).
 */
export function canonicalClaimBytes(claim: unknown): Uint8Array<ArrayBuffer> {
  let text: string | undefined;
  try {
    text = canonicalize(claim);
  } catch (err) {
    // The sign/verify paths run this before the depth-capped I-JSON walk, so
    // a pathologically deep tree must surface as a TypeError here rather
    // than as canonicalize's own recursion blowing the stack (RangeError).
    if (err instanceof RangeError) {
      throw new TypeError("canonicalClaimBytes: value is nested too deeply to canonicalize");
    }
    // Align canonicalize's NaN/Infinity errors with the I-JSON walk's
    // wording so callers see one stable message whichever layer fires first.
    if (err instanceof Error && /NaN|Infinity/.test(err.message)) {
      throw new TypeError("canonicalClaimBytes: non-finite number in value");
    }
    throw err;
  }
  if (text === undefined) {
    throw new TypeError("canonicalClaimBytes: value is not JSON-serializable");
  }
  return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

/**
 * Canonical bytes with the {@link MAX_CANONICAL_BYTES} wire cap applied.
 *
 * @throws TypeError when the canonical form exceeds the cap.
 */
export function boundedCanonicalBytes(value: unknown, label: string): Uint8Array<ArrayBuffer> {
  const bytes = canonicalClaimBytes(value);
  if (bytes.byteLength > MAX_CANONICAL_BYTES) {
    throw new TypeError(
      `${label} exceeds the 64 KiB canonical size limit: ${bytes.byteLength} bytes`
    );
  }
  return bytes;
}
