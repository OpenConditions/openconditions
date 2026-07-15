import { describe, expect, it } from "vitest";
import { EVIDENCE_POLICY_DEFAULTS, evidencePolicyFor } from "../evidence-policy.js";

describe("evidencePolicyFor", () => {
  it("composes the decay TTL and max-lifetime for hazard/crowd (900/7200)", () => {
    const policy = evidencePolicyFor("hazard", "crowd");
    expect(policy.ttlSec).toBe(900);
    expect(policy.maxLifetimeSec).toBe(7200);
  });

  it("uses the feed TTL for a feed origin (hazard feed = 1800)", () => {
    const policy = evidencePolicyFor("hazard", "feed");
    expect(policy.ttlSec).toBe(1800);
    expect(policy.maxLifetimeSec).toBe(7200);
  });

  it("falls back to the fallback decay entry for an unknown type", () => {
    const policy = evidencePolicyFor("totally-unknown", "crowd");
    expect(policy.ttlSec).toBe(900);
    expect(policy.maxLifetimeSec).toBe(7200);
  });

  it("carries the production defaults", () => {
    const policy = evidencePolicyFor("hazard", "crowd");
    expect(policy.policyVersion).toBe("v1");
    expect(policy.corroborationMinDistinctKeys).toBe(2);
    expect(policy.peerNegationMinKeys).toBe(2);
    expect(policy.reliabilityWeight).toBe(0.1);
    expect(policy.scoreByState).toEqual({
      self_reported: 0.3,
      corroborated: 0.6,
      externally_resolved: 0.9,
      negated: 0.1,
      expired: 0,
    });
  });

  it("honours a policyVersion override", () => {
    expect(evidencePolicyFor("hazard", "crowd", { policyVersion: "v2" }).policyVersion).toBe("v2");
  });

  it("applies a decay override to the TTL", () => {
    const policy = evidencePolicyFor("hazard", "crowd", {
      overrides: { hazard: { crowdTtlSec: 120 } },
    });
    expect(policy.ttlSec).toBe(120);
  });

  it("carries the asymmetric-trust defaults on the built policy", () => {
    const policy = evidencePolicyFor("hazard", "crowd");
    expect(policy.peerConfidenceCap).toBe(0.75);
    expect(policy.confirmDecay).toBe(0.5);
    expect(policy.negateAsymmetry).toBe(2);
    expect(policy.negateShrinkFactor).toBe(0.5);
  });

  it("keeps the peer confidence cap strictly below the externally_resolved score (ADR ceiling)", () => {
    const policy = evidencePolicyFor("hazard", "crowd");
    expect(policy.peerConfidenceCap).toBeLessThan(policy.scoreByState.externally_resolved);
  });

  it("exports the constants as EVIDENCE_POLICY_DEFAULTS", () => {
    expect(EVIDENCE_POLICY_DEFAULTS.policyVersion).toBe("v1");
    expect(EVIDENCE_POLICY_DEFAULTS.scoreByState.externally_resolved).toBe(0.9);
    expect(EVIDENCE_POLICY_DEFAULTS.peerConfidenceCap).toBe(0.75);
    expect(EVIDENCE_POLICY_DEFAULTS.confirmDecay).toBe(0.5);
    expect(EVIDENCE_POLICY_DEFAULTS.negateAsymmetry).toBe(2);
    expect(EVIDENCE_POLICY_DEFAULTS.negateShrinkFactor).toBe(0.5);
  });

  it("returns a fresh scoreByState object, not a shared reference", () => {
    const a = evidencePolicyFor("hazard", "crowd");
    const b = evidencePolicyFor("hazard", "crowd");
    expect(a.scoreByState).not.toBe(b.scoreByState);
  });
});
