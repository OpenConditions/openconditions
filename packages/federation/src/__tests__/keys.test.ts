import { describe, expect, it } from "vitest";
import { generateInstanceKey, rawEd25519FromMultibase } from "../index.js";

const NOW = "2026-01-01T00:00:00.000Z";

describe("generateInstanceKey", () => {
  it("creates an Ed25519 keypair whose keyId is the publicKeyMultibase", async () => {
    const key = await generateInstanceKey(NOW);
    expect(key.keyId).toBe(key.publicKeyMultibase);
    expect(key.publicKeyMultibase).toMatch(/^z6Mk/);
    expect(key.publicKeyRaw).toHaveLength(32);
    expect(Array.from(rawEd25519FromMultibase(key.publicKeyMultibase))).toEqual(
      Array.from(key.publicKeyRaw)
    );
    expect(key.privateKey.algorithm.name).toBe("Ed25519");
    expect(key.privateKey.usages).toContain("sign");
    expect(key.publicKey.usages).toContain("verify");
  });

  it("signs and verifies with WebCrypto Ed25519, and rejects a tampered message", async () => {
    const key = await generateInstanceKey(NOW);
    const message = new TextEncoder().encode("federated event payload");
    const signature = await globalThis.crypto.subtle.sign(
      { name: "Ed25519" },
      key.privateKey,
      message
    );
    await expect(
      globalThis.crypto.subtle.verify({ name: "Ed25519" }, key.publicKey, signature, message)
    ).resolves.toBe(true);
    const tampered = new TextEncoder().encode("federated event payload!");
    await expect(
      globalThis.crypto.subtle.verify({ name: "Ed25519" }, key.publicKey, signature, tampered)
    ).resolves.toBe(false);
  });

  it("verifies against a public key re-imported from the raw bytes", async () => {
    const key = await generateInstanceKey(NOW);
    const message = new TextEncoder().encode("cross-instance verification");
    const signature = await globalThis.crypto.subtle.sign(
      { name: "Ed25519" },
      key.privateKey,
      message
    );
    const reimported = await globalThis.crypto.subtle.importKey(
      "raw",
      key.publicKeyRaw as BufferSource,
      { name: "Ed25519" },
      true,
      ["verify"]
    );
    await expect(
      globalThis.crypto.subtle.verify({ name: "Ed25519" }, reimported, signature, message)
    ).resolves.toBe(true);
  });

  it("defaults validity to six months from now", async () => {
    const key = await generateInstanceKey(NOW);
    expect(key.notBefore.toISOString()).toBe(NOW);
    expect(key.notAfter.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("honours a validityMonths override", async () => {
    const key = await generateInstanceKey(NOW, 12);
    expect(key.notAfter.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("generates a distinct key (and keyId) per call", async () => {
    const [a, b] = await Promise.all([generateInstanceKey(NOW), generateInstanceKey(NOW)]);
    expect(a.keyId).not.toBe(b.keyId);
  });

  it("rejects an invalid timestamp and a non-positive validity (never-valid key footgun)", async () => {
    await expect(generateInstanceKey("not-a-timestamp")).rejects.toThrow(TypeError);
    await expect(generateInstanceKey(NOW, 0)).rejects.toThrow(TypeError);
    await expect(generateInstanceKey(NOW, -6)).rejects.toThrow(TypeError);
    await expect(generateInstanceKey(NOW, Number.NaN)).rejects.toThrow(TypeError);
  });
});
