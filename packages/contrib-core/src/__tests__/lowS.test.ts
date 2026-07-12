import { describe, expect, it } from "vitest";
import { P256_HALF_ORDER, P256_ORDER, normalizeLowS } from "../lowS.js";
import {
  generateReporterKey,
  signReport,
  verifyReport,
  type ReportClaim,
  type SignedReport,
} from "../index.js";

const toBig = (bytes: Uint8Array): bigint =>
  bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);

const to32 = (value: bigint): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(32);
  let rest = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
};

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const fromB64u = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64url"));

function rawSignature(r: bigint, s: bigint): Uint8Array<ArrayBuffer> {
  const raw = new Uint8Array(64);
  raw.set(to32(r), 0);
  raw.set(to32(s), 32);
  return raw;
}

function makeClaim(): ReportClaim {
  return {
    domain: "roads",
    type: "hazard",
    geometry: { type: "Point", coordinates: [6.0839, 50.7753] },
    fuzziness: "exact",
    reportedAt: "2026-07-11T12:00:00Z",
    nonce: "abcdefgh12345678",
  };
}

describe("normalizeLowS", () => {
  it("returns a low-S signature unchanged", () => {
    const low = rawSignature(1n, P256_HALF_ORDER);
    expect(normalizeLowS(low)).toStrictEqual(low);
  });

  it("replaces a high s with n - s, leaving r untouched", () => {
    const high = rawSignature(1n, P256_ORDER - 1n);
    const normalized = normalizeLowS(high);
    expect(toBig(normalized.subarray(0, 32))).toBe(1n);
    expect(toBig(normalized.subarray(32))).toBe(1n);
  });

  it("normalizes n/2 + 1 to n/2 exactly at the boundary", () => {
    const justHigh = rawSignature(7n, P256_HALF_ORDER + 1n);
    expect(toBig(normalizeLowS(justHigh).subarray(32))).toBe(P256_ORDER - (P256_HALF_ORDER + 1n));
  });

  it("throws TypeError on a non-64-byte input", () => {
    expect(() => normalizeLowS(new Uint8Array(63))).toThrow(TypeError);
  });
});

describe("canonical signature enforcement at verification", () => {
  async function verifyWithRaw(raw: Uint8Array) {
    const key = await generateReporterKey();
    const report = await signReport(makeClaim(), key);
    return verifyReport({ ...report, signature: b64u(raw) });
  }

  it("rejects s = 0", async () => {
    const result = await verifyWithRaw(rawSignature(1n, 0n));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/non-canonical signature/);
  });

  it("rejects s > n/2 (high-S form)", async () => {
    const result = await verifyWithRaw(rawSignature(1n, P256_HALF_ORDER + 1n));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/non-canonical signature/);
  });

  it("rejects r = 0", async () => {
    const result = await verifyWithRaw(rawSignature(0n, 1n));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/non-canonical signature/);
  });

  it("rejects r >= n", async () => {
    const result = await verifyWithRaw(rawSignature(P256_ORDER, 1n));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/non-canonical signature/);
  });
});

describe("pinned high-S / low-S twin vectors", () => {
  // Generated once with plain WebCrypto over the fixed claim below and
  // hard-coded: sigLow is the canonical (low-S) form, sigHigh its (r, n - s)
  // twin. Plain ECDSA verification accepts BOTH — that is the malleability
  // this package must close, so sigHigh must fail with the named error.
  const PINNED_PUBLIC_JWK: JsonWebKey = {
    crv: "P-256",
    kty: "EC",
    x: "zNhOoCnEJUba4aBIatkTpi4glqMSdtNwz4Ugn6s2Y88",
    y: "f8s1E0iv4oiY5qa3Oje1meTdX5enVoWPPZYAN76UNxM",
  };
  const PINNED_KEY_ID = "bmsiC7YBD_Ut6VeqvXlGodHyOPwV1lzhjy3bdmuG9wM";
  const PINNED_CLAIM: ReportClaim = {
    domain: "roads",
    type: "hazard",
    geometry: { type: "Point", coordinates: [6.0839, 50.7753] },
    fuzziness: "exact",
    reportedAt: "2026-07-11T12:00:00Z",
    nonce: "pinnedvector0123",
  };
  const SIG_LOW =
    "DcRhhwHC2NeSU6IhprXPcZQzG9RD0DKeqhL8sC_AWvkkKtiu1L_H7puU893dFUYdNTjAENL5Jz-6cCvU9Wyb-Q";
  const SIG_HIGH =
    "DcRhhwHC2NeSU6IhprXPcZQzG9RD0DKeqhL8sC_AWvnb1SdQK0A4EmRrDCIi6rnih646nNQed0U5SZ7uBvaJWA";

  function pinnedReport(signature: string): SignedReport {
    return {
      alg: "ES256",
      keyId: PINNED_KEY_ID,
      pubJwk: PINNED_PUBLIC_JWK,
      claim: PINNED_CLAIM,
      signature,
    };
  }

  it("the twins really are (r, s) and (r, n - s)", () => {
    const low = fromB64u(SIG_LOW);
    const high = fromB64u(SIG_HIGH);
    expect(toBig(low.subarray(0, 32))).toBe(toBig(high.subarray(0, 32)));
    expect(toBig(low.subarray(32)) + toBig(high.subarray(32))).toBe(P256_ORDER);
    expect(toBig(low.subarray(32))).toBeLessThanOrEqual(P256_HALF_ORDER);
  });

  it("accepts the canonical low-S signature", async () => {
    await expect(verifyReport(pinnedReport(SIG_LOW))).resolves.toStrictEqual({
      ok: true,
      keyId: PINNED_KEY_ID,
    });
  });

  it("rejects the high-S twin with the named error", async () => {
    const result = await verifyReport(pinnedReport(SIG_HIGH));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/non-canonical signature/);
  });
});
