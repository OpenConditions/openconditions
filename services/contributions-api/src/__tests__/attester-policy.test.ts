import { describe, expect, it } from "vitest";
import {
  ATTESTER_POLICY,
  assessEntitlement,
  type DeviceProof,
  type ReporterRow,
} from "../attester/policy.js";

const NOW = "2026-07-12T08:00:00.000Z";

function proofFor(overrides: Partial<DeviceProof> = {}): DeviceProof {
  return { keyId: "key-1", ...overrides };
}

/** A reporter row whose server-observed created_at is `days` before NOW. */
function seenDaysAgo(days: number): Date {
  return new Date(Date.parse(NOW) - days * 86_400_000);
}

function reporterFor(overrides: Partial<ReporterRow> = {}): ReporterRow {
  return {
    keyId: "key-1",
    status: "active",
    corroboratedCount: 0,
    createdAt: null,
    ...overrides,
  };
}

describe("assessEntitlement — trustSignal policy table", () => {
  it("bare new key: base trust only, full grant", () => {
    const ent = assessEntitlement(proofFor(), { now: NOW });
    expect(ent.trustSignal).toBeCloseTo(0.3, 10);
    expect(ent.grantTokens).toBe(ATTESTER_POLICY.grantTokensPerEpoch);
    expect(ent.grantTokens).toBe(20);
  });

  it("server tenure of 7 days adds one step", () => {
    const ent = assessEntitlement(proofFor(), {
      now: NOW,
      reporterRow: reporterFor({ createdAt: seenDaysAgo(7) }),
    });
    expect(ent.trustSignal).toBeCloseTo(0.5, 10);
  });

  it("server tenure of 30 days adds both age steps", () => {
    const ent = assessEntitlement(proofFor(), {
      now: NOW,
      reporterRow: reporterFor({ createdAt: seenDaysAgo(30) }),
    });
    expect(ent.trustSignal).toBeCloseTo(0.7, 10);
  });

  it("a client-declared accountAgeDays is IGNORED on a first enrollment (no prior row)", () => {
    // The self-declared value cannot buy tenure trust: with no reporter row the
    // server-observed tenure is 0, so trust stays at base regardless of the claim.
    const ent = assessEntitlement(proofFor({ accountAgeDays: 999 }), { now: NOW });
    expect(ent.trustSignal).toBeCloseTo(0.3, 10);
    expect(ent.grantTokens).toBe(20);
  });

  it("a client-declared accountAgeDays is IGNORED even against a fresh reporter row", () => {
    // Row exists but was created moments ago; the huge self-declared age is moot.
    const ent = assessEntitlement(proofFor({ accountAgeDays: 999 }), {
      now: NOW,
      reporterRow: reporterFor({ createdAt: seenDaysAgo(0) }),
    });
    expect(ent.trustSignal).toBeCloseTo(0.3, 10);
  });

  it("a brand-new reporter (no prior row) earns no tenure bump", () => {
    const ent = assessEntitlement(proofFor(), { now: NOW, reporterRow: null });
    expect(ent.trustSignal).toBeCloseTo(0.3, 10);
  });

  it("the reason string names the server-observed tenure so clients see the derivation", () => {
    const ent = assessEntitlement(proofFor(), {
      now: NOW,
      reporterRow: reporterFor({ createdAt: seenDaysAgo(30) }),
    });
    expect(ent.reason).toMatch(/tenure/i);
    expect(ent.reason).toMatch(/server-observed/i);
  });

  it("a VERIFIED attestation adds 0.1 (advisory only, never a gate)", () => {
    const withVerified = assessEntitlement(
      proofFor({ attestation: { kind: "play-integrity", blob: "opaque" } }),
      { now: NOW, attestationVerified: true }
    );
    const without = assessEntitlement(proofFor(), { now: NOW });
    expect(withVerified.trustSignal).toBeCloseTo(0.4, 10);
    expect(withVerified.grantTokens).toBe(without.grantTokens);
  });

  it("a present-but-UNVERIFIED attestation adds NOTHING (forgery hole closed)", () => {
    // A Sybil sending an arbitrary blob without a confirming verifier buys no
    // trust: the bump requires attestationVerified === true, not mere presence.
    const unverified = assessEntitlement(
      proofFor({ attestation: { kind: "play-integrity", blob: "forged" } }),
      { now: NOW, attestationVerified: false }
    );
    const baseline = assessEntitlement(proofFor(), { now: NOW });
    expect(unverified.trustSignal).toBeCloseTo(0.3, 10);
    expect(unverified.trustSignal).toBeCloseTo(baseline.trustSignal, 10);
    // Still fully eligible — attestation is never a gate.
    expect(unverified.grantTokens).toBe(20);
  });

  it("attestation defaults to unverified when the flag is absent", () => {
    const ent = assessEntitlement(
      proofFor({ attestation: { kind: "app-attest", blob: "opaque" } }),
      { now: NOW }
    );
    expect(ent.trustSignal).toBeCloseTo(0.3, 10);
  });

  it("a VERIFIED osmAuth adds 0.1", () => {
    const ent = assessEntitlement(proofFor({ osmAuth: "osm-token" }), {
      now: NOW,
      osmAuthVerified: true,
    });
    expect(ent.trustSignal).toBeCloseTo(0.4, 10);
  });

  it("a present-but-UNVERIFIED osmAuth adds NOTHING (presence buys no trust)", () => {
    const unverified = assessEntitlement(proofFor({ osmAuth: "osm-token" }), {
      now: NOW,
      osmAuthVerified: false,
    });
    const baseline = assessEntitlement(proofFor(), { now: NOW });
    expect(unverified.trustSignal).toBeCloseTo(0.3, 10);
    expect(unverified.trustSignal).toBeCloseTo(baseline.trustSignal, 10);
    // Still fully eligible — osmAuth is advisory, never a gate.
    expect(unverified.grantTokens).toBe(20);
  });

  it("osmAuth defaults to unverified when the flag is absent", () => {
    const ent = assessEntitlement(proofFor({ osmAuth: "osm-token" }), { now: NOW });
    expect(ent.trustSignal).toBeCloseTo(0.3, 10);
  });

  it("active reporter with corroborated history adds 0.1", () => {
    const ent = assessEntitlement(proofFor(), {
      now: NOW,
      reporterRow: reporterFor({ corroboratedCount: 3 }),
    });
    expect(ent.trustSignal).toBeCloseTo(0.4, 10);
  });

  it("active reporter without corroborations adds nothing", () => {
    const ent = assessEntitlement(proofFor(), { now: NOW, reporterRow: reporterFor() });
    expect(ent.trustSignal).toBeCloseTo(0.3, 10);
  });

  it("all signals together reach (and never exceed) 1.0", () => {
    const ent = assessEntitlement(
      proofFor({
        attestation: { kind: "android-keystore", blob: "opaque" },
        osmAuth: "osm-token",
      }),
      {
        now: NOW,
        reporterRow: reporterFor({ corroboratedCount: 12, createdAt: seenDaysAgo(365) }),
        attestationVerified: true,
        osmAuthVerified: true,
      }
    );
    expect(ent.trustSignal).toBeCloseTo(1, 10);
    expect(ent.trustSignal).toBeLessThanOrEqual(1);
  });

  it("GrapheneOS profile (no attestation, 30-day tenure) stays fully eligible", () => {
    const ent = assessEntitlement(proofFor(), {
      now: NOW,
      reporterRow: reporterFor({ createdAt: seenDaysAgo(30) }),
    });
    expect(ent.grantTokens).toBe(20);
    expect(ent.trustSignal).toBeCloseTo(0.7, 10);
  });
});

describe("assessEntitlement — the only zero path is a blocked reporter", () => {
  it("blocked reporter gets zero tokens and a reason naming the block", () => {
    const ent = assessEntitlement(proofFor(), {
      now: NOW,
      reporterRow: reporterFor({ status: "blocked" }),
    });
    expect(ent.grantTokens).toBe(0);
    expect(ent.reason).toMatch(/blocked/i);
  });

  it("blocked wins even with every positive signal present", () => {
    const ent = assessEntitlement(
      proofFor({
        attestation: { kind: "app-attest", blob: "opaque" },
        osmAuth: "osm-token",
      }),
      {
        now: NOW,
        reporterRow: reporterFor({
          status: "blocked",
          corroboratedCount: 9,
          createdAt: seenDaysAgo(365),
        }),
        attestationVerified: true,
        osmAuthVerified: true,
      }
    );
    expect(ent.grantTokens).toBe(0);
  });

  it("a block-listed key that never enrolled (synthetic row, createdAt null) is zeroed without crashing", () => {
    // The block-before-enroll synthetic ReporterRow carries no real created_at;
    // tenure must resolve to 0 rather than throw, and the key stays blocked.
    const ent = assessEntitlement(proofFor({ osmAuth: "osm-token" }), {
      now: NOW,
      reporterRow: reporterFor({ status: "blocked", createdAt: null }),
      osmAuthVerified: true,
    });
    expect(ent.grantTokens).toBe(0);
    expect(ent.reason).toMatch(/blocked/i);
  });

  it("absence of every signal never zeroes the grant", () => {
    const ent = assessEntitlement(proofFor(), { now: NOW, reporterRow: null });
    expect(ent.grantTokens).toBe(20);
    expect(ent.trustSignal).toBeGreaterThan(0);
  });
});

describe("assessEntitlement — shape", () => {
  it("is pure policy: reportingGrant is left empty for the caller to mint", () => {
    const ent = assessEntitlement(proofFor(), { now: NOW });
    expect(ent.reportingGrant).toBe("");
    expect(typeof ent.reason).toBe("string");
    expect(ent.reason.length).toBeGreaterThan(0);
  });

  it("trustSignal is always within [0, 1]", () => {
    for (const age of [undefined, 0, 6, 7, 29, 30, 10_000]) {
      const ent = assessEntitlement(proofFor({ accountAgeDays: age }), { now: NOW });
      expect(ent.trustSignal).toBeGreaterThanOrEqual(0);
      expect(ent.trustSignal).toBeLessThanOrEqual(1);
    }
  });
});
