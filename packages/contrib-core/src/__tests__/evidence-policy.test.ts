import { evaluateEvidence } from "@openconditions/core";
import { crowdRulesFor } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import { describe, expect, it } from "vitest";
import { crowdEvidencePolicy, EVIDENCE_POLICY_DEFAULTS } from "../evidence-policy.js";

const registry = productionRegistry();
const rulesOf = (kind: string, type: string) =>
  crowdRulesFor(registry, { class: "situation", kind, type })!;

describe("crowdEvidencePolicy", () => {
  it("takes the lifetime, ceiling and quorums from the registry's crowd rules", () => {
    const rules = rulesOf("incident", "accident");
    const policy = crowdEvidencePolicy(rules);
    expect(policy).toMatchObject({
      ttlSec: rules.ttlSec,
      maxLifetimeSec: rules.maxLifetimeSec,
      corroborationMinDistinctKeys: rules.corroborationKeys,
      peerNegationMinKeys: rules.negationKeys,
    });
    expect(rulesOf("roadworks", "works").ttlSec).toBeGreaterThan(rules.ttlSec);
  });

  it("carries the evidence defaults, keeping peer confidence below an external resolution", () => {
    const policy = crowdEvidencePolicy(rulesOf("incident", "accident"));
    expect(policy).toMatchObject({
      policyVersion: EVIDENCE_POLICY_DEFAULTS.policyVersion,
      reliabilityWeight: 0.1,
      peerConfidenceCap: 0.75,
      confirmDecay: 0.5,
      negateAsymmetry: 2,
      negateShrinkFactor: 0.5,
    });
    expect(policy.peerConfidenceCap).toBeLessThan(policy.scoreByState.externally_resolved);
    expect(policy.scoreByState).not.toBe(EVIDENCE_POLICY_DEFAULTS.scoreByState);
  });

  it("expires a lone crowd report after its kind's lifetime", () => {
    const rules = rulesOf("incident", "accident");
    const result = evaluateEvidence(
      {
        entries: [{ id: "1", at: "2026-10-02T10:00:00.000Z", kind: "report", reporterKey: "a" }],
        now: "2026-10-02T10:00:00.000Z",
      },
      crowdEvidencePolicy(rules),
    );
    expect(result).toMatchObject({ state: "self_reported", routingEligible: false });
    expect(Date.parse(result.expiresAt) - Date.parse("2026-10-02T10:00:00.000Z")).toBe(
      rules.ttlSec * 1000,
    );
  });
});
