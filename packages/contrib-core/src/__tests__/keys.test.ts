import { describe, expect, it } from "vitest";
import { generateReporterKey, keyIdFromJwk } from "../index.js";

describe("generateReporterKey", () => {
  it("creates a P-256 ECDSA signing key, non-extractable by default", async () => {
    const key = await generateReporterKey();
    expect(key.privateKey.type).toBe("private");
    expect(key.privateKey.extractable).toBe(false);
    expect(key.privateKey.algorithm).toMatchObject({ name: "ECDSA", namedCurve: "P-256" });
    expect(key.privateKey.usages).toContain("sign");
  });

  it("honours the explicit extractable opt-in (encrypted-backup seam)", async () => {
    const key = await generateReporterKey({ extractable: true });
    expect(key.privateKey.extractable).toBe(true);
  });

  it("exposes a minimal public JWK carrying only the thumbprint members", async () => {
    const key = await generateReporterKey();
    expect(Object.keys(key.publicJwk).sort()).toStrictEqual(["crv", "kty", "x", "y"]);
    expect(key.publicJwk.kty).toBe("EC");
    expect(key.publicJwk.crv).toBe("P-256");
  });

  it("derives keyId as the RFC 7638 thumbprint of the public JWK", async () => {
    const key = await generateReporterKey();
    await expect(keyIdFromJwk(key.publicJwk)).resolves.toBe(key.keyId);
    // SHA-256 → 32 bytes → 43 base64url chars, no padding.
    expect(key.keyId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("generates a distinct key (and keyId) per call", async () => {
    const [a, b] = await Promise.all([generateReporterKey(), generateReporterKey()]);
    expect(a.keyId).not.toBe(b.keyId);
  });
});
