import { describe, expect, it } from "vitest";
import { UNVERIFIED_ATTESTATION, type AttestationVerifier } from "../attester/verifier.js";

const KINDS = ["android-keystore", "app-attest", "play-integrity"] as const;

describe("UNVERIFIED_ATTESTATION default verifier", () => {
  it("returns verified:false for every attestation kind (forgery hole closed)", async () => {
    for (const kind of KINDS) {
      const result = await UNVERIFIED_ATTESTATION.verify(
        { kind, blob: "anything-a-sybil-sends" },
        { keyId: "key-1" }
      );
      expect(result.verified).toBe(false);
      expect(result.reason).toBe("no-platform-verifier-configured");
    }
  });

  it("satisfies the AttestationVerifier contract", () => {
    const verifier: AttestationVerifier = UNVERIFIED_ATTESTATION;
    expect(typeof verifier.verify).toBe("function");
  });
});
