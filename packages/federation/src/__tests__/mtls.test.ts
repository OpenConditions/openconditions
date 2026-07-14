import { describe, expect, it } from "vitest";
import { checkMtls, type MtlsContext } from "../index.js";

const AUTHORIZED: MtlsContext = { authorized: true, fingerprint: "AA:BB:CC" };

describe("checkMtls", () => {
  it("passes any peer that does not require mTLS (Tier-0 / non-mTLS unaffected)", () => {
    expect(checkMtls({}, undefined)).toEqual({ ok: true });
    expect(checkMtls({ mtlsRequired: false }, undefined)).toEqual({ ok: true });
    // A non-mtls peer is unaffected even when a cert IS presented.
    expect(checkMtls({}, AUTHORIZED)).toEqual({ ok: true });
  });

  it("rejects a mtlsRequired peer with no client cert (mtls-required)", () => {
    expect(checkMtls({ mtlsRequired: true }, undefined)).toEqual({
      ok: false,
      reason: "mtls-required",
    });
  });

  it("rejects a mtlsRequired peer whose presented cert the TLS layer did not authorize", () => {
    expect(
      checkMtls({ mtlsRequired: true }, { authorized: false, fingerprint: "AA:BB:CC" })
    ).toEqual({ ok: false, reason: "mtls-required" });
  });

  it("accepts a mtlsRequired peer with an authorized cert and no pinned fingerprints (CA-trust only)", () => {
    expect(checkMtls({ mtlsRequired: true }, AUTHORIZED)).toEqual({ ok: true });
    // An explicitly empty pin set is CA-trust only, not a reject-everything set.
    expect(checkMtls({ mtlsRequired: true, mtlsFingerprints: [] }, AUTHORIZED)).toEqual({
      ok: true,
    });
  });

  it("accepts a mtlsRequired peer whose authorized cert matches a pinned fingerprint", () => {
    expect(
      checkMtls({ mtlsRequired: true, mtlsFingerprints: ["11:22", "AA:BB:CC"] }, AUTHORIZED)
    ).toEqual({ ok: true });
  });

  it("rejects a mtlsRequired peer whose authorized cert is not in the pin set (mtls-fingerprint-mismatch)", () => {
    expect(
      checkMtls({ mtlsRequired: true, mtlsFingerprints: ["11:22", "33:44"] }, AUTHORIZED)
    ).toEqual({ ok: false, reason: "mtls-fingerprint-mismatch" });
    // Pinned but the authorized cert carried no fingerprint at all → mismatch.
    expect(
      checkMtls({ mtlsRequired: true, mtlsFingerprints: ["11:22"] }, { authorized: true })
    ).toEqual({ ok: false, reason: "mtls-fingerprint-mismatch" });
  });
});
