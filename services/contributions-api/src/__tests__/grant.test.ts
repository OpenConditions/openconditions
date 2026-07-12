import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReportingGrant,
  resolveGrantSecret,
  verifyReportingGrant,
} from "../attester/grant.js";

const NOW = "2026-07-12T08:00:00.000Z";
const SECRET = new TextEncoder().encode("test-grant-secret");
const OTHER_SECRET = new TextEncoder().encode("a-different-secret");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reporting grant round-trip", () => {
  it("verifies a freshly minted grant for the same key", async () => {
    const grant = await createReportingGrant("key-a", NOW, SECRET);
    const result = await verifyReportingGrant(grant, SECRET, NOW, "key-a");
    expect(result).toMatchObject({ valid: true, keyId: "key-a" });
  });

  it("carries the keyId in the payload so the caller never trusts a client field", async () => {
    const grant = await createReportingGrant("key-b", NOW, SECRET);
    const result = await verifyReportingGrant(grant, SECRET, NOW);
    expect(result.valid).toBe(true);
    expect(result.keyId).toBe("key-b");
  });

  it("is two base64url segments joined by a dot", async () => {
    const grant = await createReportingGrant("key-a", NOW, SECRET);
    expect(grant).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});

describe("reporting grant refusals", () => {
  it("refuses an expired grant (exp = iat + 24h)", async () => {
    const grant = await createReportingGrant("key-a", NOW, SECRET);
    const past24h = "2026-07-13T08:00:00.001Z";
    const result = await verifyReportingGrant(grant, SECRET, past24h, "key-a");
    expect(result).toMatchObject({ valid: false, reason: "expired" });
  });

  it("still verifies just inside the 24h window", async () => {
    const grant = await createReportingGrant("key-a", NOW, SECRET);
    const almost = "2026-07-13T07:59:59.999Z";
    const result = await verifyReportingGrant(grant, SECRET, almost, "key-a");
    expect(result.valid).toBe(true);
  });

  it("refuses a grant presented for a different key", async () => {
    const grant = await createReportingGrant("key-a", NOW, SECRET);
    const result = await verifyReportingGrant(grant, SECRET, NOW, "key-z");
    expect(result).toMatchObject({ valid: false, reason: "wrong-key" });
  });

  it("refuses a grant with a bit-flipped MAC", async () => {
    const grant = await createReportingGrant("key-a", NOW, SECRET);
    const [payload, mac] = grant.split(".") as [string, string];
    const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");
    const result = await verifyReportingGrant(`${payload}.${flipped}`, SECRET, NOW, "key-a");
    expect(result).toMatchObject({ valid: false, reason: "bad-mac" });
  });

  it("refuses a grant whose payload was tampered with", async () => {
    const grant = await createReportingGrant("key-a", NOW, SECRET);
    const [payload, mac] = grant.split(".") as [string, string];
    const flipped = payload.slice(0, -1) + (payload.endsWith("A") ? "B" : "A");
    const result = await verifyReportingGrant(`${flipped}.${mac}`, SECRET, NOW, "key-a");
    expect(result.valid).toBe(false);
  });

  it("refuses a grant minted under a different secret", async () => {
    const grant = await createReportingGrant("key-a", NOW, OTHER_SECRET);
    const result = await verifyReportingGrant(grant, SECRET, NOW, "key-a");
    expect(result).toMatchObject({ valid: false, reason: "bad-mac" });
  });

  it("refuses malformed input without throwing", async () => {
    for (const junk of ["", "no-dot", "a.b.c", "!!!.???"]) {
      const result = await verifyReportingGrant(junk, SECRET, NOW, "key-a");
      expect(result.valid).toBe(false);
    }
  });
});

describe("constant-time MAC comparison", () => {
  it("routes the MAC check through crypto.subtle.verify", async () => {
    const spy = vi.spyOn(globalThis.crypto.subtle, "verify");
    const grant = await createReportingGrant("key-a", NOW, SECRET);
    await verifyReportingGrant(grant, SECRET, NOW, "key-a");
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.some(([alg]) => String(alg) === "HMAC")).toBe(true);
  });
});

describe("resolveGrantSecret", () => {
  it("uses the configured secret when set", () => {
    const warn = vi.fn();
    const secret = resolveGrantSecret({ OPENCONDITIONS_GRANT_SECRET: "configured-secret" }, warn);
    expect(new TextDecoder().decode(secret)).toBe("configured-secret");
    expect(warn).not.toHaveBeenCalled();
  });

  it("generates an ephemeral secret and warns loudly when unset outside production", () => {
    const warn = vi.fn();
    const secret = resolveGrantSecret({ NODE_ENV: "development" }, warn);
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(warn).toHaveBeenCalled();
    const another = resolveGrantSecret({ NODE_ENV: "development" }, warn);
    expect(Buffer.from(secret).equals(Buffer.from(another))).toBe(false);
  });

  it("refuses to start in production without a secret (fail closed)", () => {
    expect(() => resolveGrantSecret({ NODE_ENV: "production" }, vi.fn())).toThrow(
      /OPENCONDITIONS_GRANT_SECRET/
    );
  });

  it("never includes the secret value in the warning", () => {
    const warn = vi.fn();
    resolveGrantSecret({ OPENCONDITIONS_GRANT_SECRET: "hunter2-secret-value" }, warn);
    const secret = resolveGrantSecret({}, warn);
    const warned = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).not.toContain("hunter2-secret-value");
    expect(warned).not.toContain(Buffer.from(secret).toString("base64url"));
  });
});
