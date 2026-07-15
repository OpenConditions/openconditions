import { describe, expect, it } from "vitest";
import { evaluateEvidence, type EvidencePolicy } from "@openconditions/core";
import { decayMaxLifetimeSec, decayTtlSec } from "../decay.js";

describe("decay table feeding core's evidence policy", () => {
  it("derives a single crowd report's expiresAt from decayTtlSec/decayMaxLifetimeSec", () => {
    const policy: EvidencePolicy = {
      policyVersion: "test-1",
      corroborationMinDistinctKeys: 2,
      peerNegationMinKeys: 2,
      ttlSec: decayTtlSec("hazard", "crowd"),
      maxLifetimeSec: decayMaxLifetimeSec("hazard"),
      scoreByState: {
        self_reported: 0.4,
        corroborated: 0.6,
        externally_resolved: 0.9,
        negated: 0.1,
        expired: 0,
      },
      reliabilityWeight: 0.1,
      peerConfidenceCap: 0.75,
      confirmDecay: 0.5,
      negateAsymmetry: 2,
      negateShrinkFactor: 0.5,
    };
    const result = evaluateEvidence(
      {
        entries: [
          { id: "r1", at: "2026-07-11T12:00:00.000Z", kind: "report", reporterKey: "key-a" },
        ],
        now: "2026-07-11T12:01:00.000Z",
      },
      policy
    );
    // hazard crowd TTL is 900 s and the 7200 s max-lifetime ceiling does not
    // bind a single report, so expiry is exactly report time + TTL.
    expect(policy.ttlSec).toBe(900);
    expect(policy.maxLifetimeSec).toBe(7200);
    expect(result.state).toBe("self_reported");
    expect(result.expiresAt).toBe("2026-07-11T12:15:00.000Z");
    expect(result.routingEligible).toBe(false);
  });
});
