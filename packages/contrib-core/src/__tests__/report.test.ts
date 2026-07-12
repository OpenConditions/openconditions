import { describe, expect, it } from "vitest";
import {
  canonicalClaimBytes,
  generateReporterKey,
  maresiUri,
  signReport,
  verifyReport,
  type ReportClaim,
  type SignedReport,
} from "../index.js";
import { P256_HALF_ORDER, P256_ORDER } from "../lowS.js";

function makeClaim(overrides: Partial<ReportClaim> = {}): ReportClaim {
  return {
    domain: "roads",
    type: "hazard",
    geometry: { type: "Point", coordinates: [6.0839, 50.7753] },
    fuzziness: "exact",
    reportedAt: "2026-07-11T12:00:00Z",
    nonce: "abcdefgh12345678",
    ...overrides,
  };
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromB64url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

/** Test-only: wrap a raw r||s signature in ASN.1 DER (negative vector). */
function derFromRaw(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    let body = Array.from(bytes.slice(start));
    if ((body[0] & 0x80) !== 0) body = [0, ...body];
    return [0x02, body.length, ...body];
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

const bytesToBig = (bytes: Uint8Array): bigint =>
  bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);

/** Test-only: the reviewer's malleation probe — flip s to its (n - s) twin. */
function malleate(signature: string): string {
  const raw = fromB64url(signature);
  const twinS = P256_ORDER - bytesToBig(raw.subarray(32));
  const twin = new Uint8Array(raw);
  for (let i = 63, rest = twinS; i >= 32; i--) {
    twin[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return b64url(twin);
}

describe("signReport / verifyReport", () => {
  it("round-trips: a signed report verifies with its embedded pubJwk", async () => {
    const key = await generateReporterKey();
    const report = await signReport(makeClaim(), key);
    expect(report.alg).toBe("ES256");
    expect(report.keyId).toBe(key.keyId);
    expect(report.pubJwk).toStrictEqual(key.publicJwk);
    await expect(verifyReport(report)).resolves.toStrictEqual({ ok: true, keyId: key.keyId });
  });

  it("verifies with a server-cached knownJwk when pubJwk is absent", async () => {
    const key = await generateReporterKey();
    const report = await signReport(makeClaim(), key);
    const { pubJwk: _dropped, ...withoutJwk } = report;
    const result = await verifyReport(withoutJwk as SignedReport, key.publicJwk);
    expect(result).toStrictEqual({ ok: true, keyId: key.keyId });
  });

  it("fails without any key: no pubJwk and no knownJwk", async () => {
    const key = await generateReporterKey();
    const report = await signReport(makeClaim(), key);
    const { pubJwk: _dropped, ...withoutJwk } = report;
    const result = await verifyReport(withoutJwk as SignedReport);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no public key/i);
  });

  it("fails on a tampered claim", async () => {
    const key = await generateReporterKey();
    const report = await signReport(makeClaim(), key);
    const tampered: SignedReport = {
      ...report,
      claim: { ...report.claim, type: "road_closure" },
    };
    const result = await verifyReport(tampered);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/signature/i);
  });

  it("fails on a tampered signature", async () => {
    const key = await generateReporterKey();
    const report = await signReport(makeClaim(), key);
    const bytes = fromB64url(report.signature);
    bytes[10] ^= 0xff;
    const result = await verifyReport({ ...report, signature: b64url(bytes) });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/signature/i);
  });

  it("rejects a DER-encoded signature with a helpful error", async () => {
    const key = await generateReporterKey();
    const report = await signReport(makeClaim(), key);
    const der = derFromRaw(fromB64url(report.signature));
    const result = await verifyReport({ ...report, signature: b64url(der) });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/DER/);
    expect(result.error).toMatch(/64/);
  });

  it("rejects a signature that is not 64 bytes", async () => {
    const key = await generateReporterKey();
    const report = await signReport(makeClaim(), key);
    const short = fromB64url(report.signature).slice(0, 63);
    const result = await verifyReport({ ...report, signature: b64url(short) });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/64/);
  });

  it("rejects the (r, n - s) malleated twin of a valid signature", async () => {
    const key = await generateReporterKey();
    const report = await signReport(makeClaim(), key);
    // Sanity: the original verifies before the probe.
    await expect(verifyReport(report)).resolves.toMatchObject({ ok: true });
    const result = await verifyReport({ ...report, signature: malleate(report.signature) });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/non-canonical signature/);
  });

  it("always emits low-S signatures (property over 25 signatures)", async () => {
    const key = await generateReporterKey();
    for (let i = 0; i < 25; i++) {
      const report = await signReport(
        makeClaim({ nonce: `propertyrun${String(i).padStart(5, "0")}` }),
        key
      );
      const s = bytesToBig(fromB64url(report.signature).subarray(32));
      expect(s > 0n && s <= P256_HALF_ORDER).toBe(true);
      await expect(verifyReport(report)).resolves.toMatchObject({ ok: true });
    }
  });

  it("rejects an alg other than exactly ES256", async () => {
    const key = await generateReporterKey();
    const report = await signReport(makeClaim(), key);
    const result = await verifyReport({ ...report, alg: "ES384" as "ES256" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ES256/);
  });

  it("rejects a keyId that does not match the verification key's thumbprint", async () => {
    const [key, other] = await Promise.all([generateReporterKey(), generateReporterKey()]);
    const report = await signReport(makeClaim(), key);
    const result = await verifyReport({ ...report, keyId: other.keyId });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/thumbprint/i);
  });

  it("prefers knownJwk and fails when the embedded pubJwk disagrees with it", async () => {
    const [key, other] = await Promise.all([generateReporterKey(), generateReporterKey()]);
    const report = await signReport(makeClaim(), key);
    const result = await verifyReport(report, other.publicJwk);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/known key/i);
  });

  it("rejects a pubJwk carrying private key material", async () => {
    const key = await generateReporterKey({ extractable: true });
    const report = await signReport(makeClaim(), key);
    const privateJwk = await crypto.subtle.exportKey("jwk", key.privateKey);
    const result = await verifyReport({ ...report, pubJwk: privateJwk });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/private/i);
  });

  it("ignores key_ops/ext/use/alg decorations on the pubJwk", async () => {
    const key = await generateReporterKey();
    const report = await signReport(makeClaim(), key);
    const decorated: JsonWebKey = {
      ...key.publicJwk,
      alg: "ES256",
      ext: true,
      key_ops: ["verify"],
      use: "sig",
    };
    const result = await verifyReport({ ...report, pubJwk: decorated });
    expect(result).toStrictEqual({ ok: true, keyId: key.keyId });
  });

  it("rejects a non-EC or non-P-256 pubJwk", async () => {
    const key = await generateReporterKey();
    const report = await signReport(makeClaim(), key);
    const result = await verifyReport({
      ...report,
      pubJwk: { ...key.publicJwk, crv: "P-384" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/P-256/);
  });

  it("accepts identical claims regardless of literal key order", async () => {
    const key = await generateReporterKey();
    const report = await signReport(makeClaim(), key);
    // The same claim content spelled in a different member order must produce
    // the same canonical bytes, so the original signature still verifies.
    const reordered = JSON.parse(JSON.stringify(report.claim)) as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(reordered).reverse()) as unknown;
    expect(canonicalClaimBytes(reversed)).toStrictEqual(canonicalClaimBytes(report.claim));
    const result = await verifyReport({ ...report, claim: reversed as ReportClaim });
    expect(result.ok).toBe(true);
  });

  describe("claim validation (I-JSON hard rules)", () => {
    async function expectInvalid(claim: ReportClaim, pattern: RegExp): Promise<void> {
      const key = await generateReporterKey();
      await expect(signReport(claim, key)).rejects.toThrow(pattern);
      // The same claim smuggled into a signed envelope must fail verification.
      const valid = await signReport(makeClaim(), key);
      const result = await verifyReport({ ...valid, claim });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(pattern);
    }

    it("rejects non-finite numbers anywhere in the claim tree", async () => {
      await expectInvalid(
        makeClaim({ attributes: { nested: [{ speed: Number.POSITIVE_INFINITY }] } }),
        /non-finite/
      );
      await expectInvalid(makeClaim({ attributes: { speed: Number.NaN } }), /non-finite/);
    });

    it("rejects strings with lone surrogates", async () => {
      await expectInvalid(makeClaim({ attributes: { note: "broken \ud800 text" } }), /surrogate/);
    });

    it("rejects a nonce outside 16..64 [A-Za-z0-9_-]", async () => {
      await expectInvalid(makeClaim({ nonce: "short" }), /nonce/);
      await expectInvalid(makeClaim({ nonce: "x".repeat(65) }), /nonce/);
      await expectInvalid(makeClaim({ nonce: "has spaces not ok!" }), /nonce/);
    });

    it("rejects a reportedAt without a zone designator", async () => {
      await expectInvalid(makeClaim({ reportedAt: "2026-07-11T12:00:00" }), /zone designator/);
      await expectInvalid(makeClaim({ reportedAt: "2026-07-11" }), /zone designator/);
      await expectInvalid(makeClaim({ reportedAt: "Fri Jul 11 2026" }), /zone designator/);
    });

    it("rejects a claim whose canonical form exceeds 64 KiB", async () => {
      await expectInvalid(makeClaim({ attributes: { blob: "x".repeat(66000) } }), /64 KiB/);
    });

    it("rejects rolled/impossible calendar dates in reportedAt", async () => {
      await expectInvalid(makeClaim({ reportedAt: "2026-02-30T12:00:00Z" }), /calendar date/);
      await expectInvalid(makeClaim({ reportedAt: "2026-04-31T00:00:00Z" }), /calendar date/);
      // 2026 is not a leap year; 2028 is.
      await expectInvalid(makeClaim({ reportedAt: "2026-02-29T10:00:00Z" }), /calendar date/);
      const key = await generateReporterKey();
      const leap = await signReport(makeClaim({ reportedAt: "2028-02-29T10:00:00Z" }), key);
      await expect(verifyReport(leap)).resolves.toMatchObject({ ok: true });
    });

    it("rejects a claim tree nested deeper than 64 levels with a TypeError", async () => {
      let nested: Record<string, unknown> = { leaf: 1 };
      for (let i = 0; i < 100; i++) nested = { child: nested };
      await expectInvalid(makeClaim({ attributes: nested }), /nesting depth/);
    });

    it("rejects pathological nesting with a TypeError, never a RangeError", async () => {
      let deep: unknown = 1;
      for (let i = 0; i < 200000; i++) deep = [deep];
      const key = await generateReporterKey();
      // RangeError is not a TypeError, so this also pins "no stack overflow
      // escapes": either the size cap or the depth/conversion guard fires.
      await expect(signReport(makeClaim({ attributes: { deep } }), key)).rejects.toThrow(TypeError);
    });

    it("rejects an unknown domain and an empty type", async () => {
      await expectInvalid(makeClaim({ domain: "weather" as ReportClaim["domain"] }), /domain/);
      await expectInvalid(makeClaim({ type: "" }), /type/);
    });

    it("rejects a severityLevel outside 1..5", async () => {
      await expectInvalid(
        makeClaim({ severityLevel: 6 as ReportClaim["severityLevel"] }),
        /severityLevel/
      );
      await expectInvalid(
        makeClaim({ severityLevel: 2.5 as unknown as ReportClaim["severityLevel"] }),
        /severityLevel/
      );
    });

    it("rejects an invalid fuzziness and a malformed geometry", async () => {
      await expectInvalid(
        makeClaim({ fuzziness: "fuzzy" as ReportClaim["fuzziness"] }),
        /fuzziness/
      );
      await expectInvalid(
        makeClaim({ geometry: { type: "Circle" } as unknown as ReportClaim["geometry"] }),
        /geometry/
      );
    });

    it("accepts a valid claim with all optional fields", async () => {
      const key = await generateReporterKey();
      const claim = makeClaim({
        subject: [{ type: "segment", id: "seg:123" }],
        severityLevel: 3,
        attributes: { lanesBlocked: 1, note: "shoulder blocked" },
      });
      const report = await signReport(claim, key);
      await expect(verifyReport(report)).resolves.toStrictEqual({ ok: true, keyId: key.keyId });
    });
  });
});

describe("maresiUri", () => {
  it("builds the canonical report URN from the signature", async () => {
    const key = await generateReporterKey();
    const report = await signReport(makeClaim(), key);
    const uri = maresiUri(report);
    expect(uri).toBe(`urn:openconditions:report:${report.signature}`);
    expect(uri.slice("urn:openconditions:report:".length)).toBe(report.signature);
  });

  it("throws on a report without a base64url signature", () => {
    expect(() => maresiUri({ signature: "not/base64url+chars" } as SignedReport)).toThrow(
      TypeError
    );
  });
});
