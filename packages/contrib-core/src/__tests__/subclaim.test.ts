import { describe, expect, it } from "vitest";
import {
  canonicalClaimBytes,
  generateReporterKey,
  type SignedSubClaim,
  type SubClaimBody,
  signSubClaim,
  verifySubClaim,
} from "../index.js";
import { P256_ORDER } from "../lowS.js";

function makeBody(overrides: Record<string, unknown> = {}): SubClaimBody {
  return {
    subject: { class: "situation", id: "oc:situation:example:a46" },
    claimType: "confirm",
    reportedAt: "2026-07-11T12:05:00Z",
    nonce: "0123456789abcdef",
    ...overrides,
  } as SubClaimBody;
}

describe("signSubClaim / verifySubClaim", () => {
  it("round-trips: a signed sub-claim verifies with its embedded pubJwk", async () => {
    const key = await generateReporterKey();
    const sub = await signSubClaim(makeBody(), key);
    expect(sub.alg).toBe("ES256");
    expect(sub.keyId).toBe(key.keyId);
    await expect(verifySubClaim(sub)).resolves.toStrictEqual({ ok: true, keyId: key.keyId });
  });

  it("verifies with a knownJwk when pubJwk is absent", async () => {
    const key = await generateReporterKey();
    const sub = await signSubClaim(makeBody({ claimType: "negate" }), key);
    const { pubJwk: _dropped, ...withoutJwk } = sub;
    const result = await verifySubClaim(withoutJwk as SignedSubClaim, key.publicJwk);
    expect(result).toStrictEqual({ ok: true, keyId: key.keyId });
  });

  it("signs ONLY the body: the raw signature verifies over canonical body bytes", async () => {
    const key = await generateReporterKey();
    const body = makeBody({ claimType: "flag", reason: "duplicate of another report" });
    const sub = await signSubClaim(body, key);
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      key.publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      Buffer.from(sub.signature, "base64url"),
      canonicalClaimBytes(body),
    );
    // The envelope fields (alg/keyId/pubJwk/signature) are NOT in the signed
    // bytes: the body alone reproduces the signature input.
    expect(ok).toBe(true);
  });

  it("still rejects a mutated keyId via the thumbprint check (outside the signed bytes)", async () => {
    const [key, other] = await Promise.all([generateReporterKey(), generateReporterKey()]);
    const sub = await signSubClaim(makeBody(), key);
    const result = await verifySubClaim({ ...sub, keyId: other.keyId });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/thumbprint/i);
  });

  it("still rejects a mutated alg (outside the signed bytes)", async () => {
    const key = await generateReporterKey();
    const sub = await signSubClaim(makeBody(), key);
    const result = await verifySubClaim({ ...sub, alg: "ES512" as "ES256" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ES256/);
  });

  it("rejects the (r, n - s) malleated twin of a valid sub-claim signature", async () => {
    const key = await generateReporterKey();
    const sub = await signSubClaim(makeBody(), key);
    await expect(verifySubClaim(sub)).resolves.toMatchObject({ ok: true });
    const raw = new Uint8Array(Buffer.from(sub.signature, "base64url"));
    const s = raw.subarray(32).reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
    for (let i = 63, rest = P256_ORDER - s; i >= 32; i--) {
      raw[i] = Number(rest & 0xffn);
      rest >>= 8n;
    }
    const result = await verifySubClaim({
      ...sub,
      signature: Buffer.from(raw).toString("base64url"),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/non-canonical signature/);
  });

  it("fails on a tampered body field", async () => {
    const key = await generateReporterKey();
    const sub = await signSubClaim(makeBody(), key);
    const result = await verifySubClaim({ ...sub, claimType: "negate" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/signature/i);
  });

  it("rejects an invalid claimType", async () => {
    const key = await generateReporterKey();
    await expect(signSubClaim(makeBody({ claimType: "deny" }), key)).rejects.toThrow(/claimType/);
  });

  it("names its subject as a record: a class, an id, and a component only of a feature", async () => {
    const key = await generateReporterKey();
    await expect(signSubClaim(makeBody({ subject: "oc:situation:x:1" }), key)).rejects.toThrow(
      /subject/,
    );
    await expect(
      signSubClaim(makeBody({ subject: { class: "situation", id: "" } }), key),
    ).rejects.toThrow(/subject/);
    await expect(
      signSubClaim(
        makeBody({ subject: { class: "situation", id: "oc:situation:x:1", componentKey: "evse" } }),
        key,
      ),
    ).rejects.toThrow(/componentKey/);
    const component = await signSubClaim(
      makeBody({ subject: { class: "feature", id: "oc:feature:x:1", componentKey: "evse-1" } }),
      key,
    );
    await expect(verifySubClaim(component)).resolves.toMatchObject({ ok: true });
  });

  it("caps reason at 2000 characters", async () => {
    const key = await generateReporterKey();
    await expect(
      signSubClaim(makeBody({ claimType: "flag", reason: "r".repeat(2001) }), key),
    ).rejects.toThrow(/reason/);
    const atLimit = await signSubClaim(
      makeBody({ claimType: "flag", reason: "r".repeat(2000) }),
      key,
    );
    await expect(verifySubClaim(atLimit)).resolves.toMatchObject({ ok: true });
  });

  it("applies the shared nonce and reportedAt rules", async () => {
    const key = await generateReporterKey();
    await expect(signSubClaim(makeBody({ nonce: "short" }), key)).rejects.toThrow(/nonce/);
    await expect(
      signSubClaim(makeBody({ reportedAt: "2026-07-11T12:05:00" }), key),
    ).rejects.toThrow(/reportedAt/);
  });

  it("rejects a body that smuggles envelope fields", async () => {
    const key = await generateReporterKey();
    const smuggled = { ...makeBody(), signature: "fake" } as unknown as SubClaimBody;
    await expect(signSubClaim(smuggled, key)).rejects.toThrow(/envelope/);
  });

  it("accepts an optional geometry and covers it with the signature", async () => {
    const key = await generateReporterKey();
    const body = makeBody({ geometry: { type: "Point", coordinates: [6.08, 50.77] } });
    const sub = await signSubClaim(body, key);
    await expect(verifySubClaim(sub)).resolves.toMatchObject({ ok: true });
    const moved = {
      ...sub,
      geometry: { type: "Point", coordinates: [7.0, 51.0] },
    } as SignedSubClaim;
    const result = await verifySubClaim(moved);
    expect(result.ok).toBe(false);
  });
});
