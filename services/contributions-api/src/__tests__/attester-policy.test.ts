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

function reporterFor(overrides: Partial<ReporterRow> = {}): ReporterRow {
  return {
    keyId: "key-1",
    status: "active",
    corroboratedCount: 0,
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

  it("account age 7 days adds one step", () => {
    const ent = assessEntitlement(proofFor({ accountAgeDays: 7 }), { now: NOW });
    expect(ent.trustSignal).toBeCloseTo(0.5, 10);
  });

  it("account age 30 days adds both age steps", () => {
    const ent = assessEntitlement(proofFor({ accountAgeDays: 30 }), { now: NOW });
    expect(ent.trustSignal).toBeCloseTo(0.7, 10);
  });

  it("attestation presence adds 0.1 (advisory only, never a gate)", () => {
    const withAttestation = assessEntitlement(
      proofFor({ attestation: { kind: "play-integrity", blob: "opaque" } }),
      { now: NOW }
    );
    const without = assessEntitlement(proofFor(), { now: NOW });
    expect(withAttestation.trustSignal).toBeCloseTo(0.4, 10);
    expect(withAttestation.grantTokens).toBe(without.grantTokens);
  });

  it("osmAuth presence adds 0.1", () => {
    const ent = assessEntitlement(proofFor({ osmAuth: "osm-token" }), { now: NOW });
    expect(ent.trustSignal).toBeCloseTo(0.4, 10);
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
        accountAgeDays: 365,
        attestation: { kind: "android-keystore", blob: "opaque" },
        osmAuth: "osm-token",
      }),
      { now: NOW, reporterRow: reporterFor({ corroboratedCount: 12 }) }
    );
    expect(ent.trustSignal).toBeCloseTo(1, 10);
    expect(ent.trustSignal).toBeLessThanOrEqual(1);
  });

  it("GrapheneOS profile (no attestation, 30-day account) stays fully eligible", () => {
    const ent = assessEntitlement(proofFor({ accountAgeDays: 30 }), { now: NOW });
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
        accountAgeDays: 365,
        attestation: { kind: "app-attest", blob: "opaque" },
        osmAuth: "osm-token",
      }),
      { now: NOW, reporterRow: reporterFor({ status: "blocked", corroboratedCount: 9 }) }
    );
    expect(ent.grantTokens).toBe(0);
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
