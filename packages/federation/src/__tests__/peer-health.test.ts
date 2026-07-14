import { describe, expect, it } from "vitest";
import { computePeerHealth } from "../peer-health.js";

const CLEAN = {
  availabilityOk: 100,
  availabilityFail: 0,
  signatureFailures: 0,
  replayFailures: 0,
  schemaFailures: 0,
  rateViolations: 0,
};

describe("computePeerHealth", () => {
  it("scores a fully-available, failure-free peer at 1 with no reasons", () => {
    const health = computePeerHealth(CLEAN);
    expect(health.score).toBe(1);
    expect(health.reasons).toEqual([]);
  });

  it("scores a peer with no recorded activity as a neutral 1", () => {
    const health = computePeerHealth({
      availabilityOk: 0,
      availabilityFail: 0,
      signatureFailures: 0,
      replayFailures: 0,
      schemaFailures: 0,
      rateViolations: 0,
    });
    expect(health.score).toBe(1);
    expect(health.reasons).toEqual([]);
  });

  it("names every degradation class and lowers the score", () => {
    const health = computePeerHealth({
      availabilityOk: 50,
      availabilityFail: 50,
      signatureFailures: 3,
      replayFailures: 2,
      schemaFailures: 1,
      rateViolations: 4,
    });
    expect(health.score).toBeLessThan(1);
    expect(health.reasons).toEqual(
      expect.arrayContaining([
        "low_availability",
        "signature_failures",
        "replay_failures",
        "schema_failures",
        "rate_violations",
      ])
    );
  });

  it("reflects poor availability in both the score and the reasons", () => {
    const health = computePeerHealth({ ...CLEAN, availabilityOk: 20, availabilityFail: 80 });
    expect(health.reasons).toContain("low_availability");
    expect(health.score).toBeLessThan(computePeerHealth(CLEAN).score);
  });

  it("clamps the score to the [0,1] range under heavy failure", () => {
    const health = computePeerHealth({
      availabilityOk: 0,
      availabilityFail: 100,
      signatureFailures: 1000,
      replayFailures: 1000,
      schemaFailures: 1000,
      rateViolations: 1000,
    });
    expect(health.score).toBeGreaterThanOrEqual(0);
    expect(health.score).toBeLessThanOrEqual(1);
  });
});
