import { describe, expect, it } from "vitest";
import { BudgetLedger, releaseWithDp, ReleaseStore, type SpeedTuple } from "../index.js";
import { allSumValues, standardManifest, standardMechanism, standardParams } from "./dpFixtures.js";

describe("invariant 1: clamp + contribution-bound before the mechanism is called", () => {
  it("reduces a unit's many tuples in a cell to one, and clamps every speed into [0,200]", () => {
    const manifest = standardManifest();
    const params = standardParams();
    const mechanism = standardMechanism();
    const ledger = new BudgetLedger(params.budget);
    const store = new ReleaseStore();

    // U_multi floods seg-a/w1 with 3 in-range tuples (one-per-unit reduces to 1).
    // U_hi's only speed is out-of-range 999 (its representative exercises the
    // ceiling clamp). U_lo's only speed is out-of-range -5 (floor clamp).
    const dataset: SpeedTuple[] = [
      { privacyUnitId: "U_multi", segmentId: "seg-a", timestampMs: 1_000, speed: 130 },
      { privacyUnitId: "U_multi", segmentId: "seg-a", timestampMs: 1_500, speed: 150 },
      { privacyUnitId: "U_multi", segmentId: "seg-a", timestampMs: 2_000, speed: 170 },
      { privacyUnitId: "U_hi", segmentId: "seg-a", timestampMs: 2_500, speed: 999 },
      { privacyUnitId: "U_lo", segmentId: "seg-a", timestampMs: 3_000, speed: -5 },
    ];

    releaseWithDp(dataset, manifest, params, mechanism, ledger, store);

    // seg-a/w1 is the first partition; its boundedSum is the first sum call.
    const firstSum = mechanism.calls.find((c) => c.method === "boundedSum");
    expect(firstSum?.method).toBe("boundedSum");
    if (firstSum?.method !== "boundedSum") throw new Error("no boundedSum call");

    // One value per unit: U_multi's three tuples collapse to one, plus U_hi + U_lo.
    expect(firstSum.values).toHaveLength(3);
    // U_hi's 999 clamped to the ceiling 200; nothing exceeds the public bound.
    expect(firstSum.values).toContain(200);
    expect(firstSum.values.every((v) => v <= 200)).toBe(true);
    // U_lo's -5 clamped to the floor 0.
    expect(firstSum.values).toContain(0);
    expect(firstSum.values.every((v) => v >= 0)).toBe(true);
    // The raw out-of-range values never reach the mechanism.
    expect(firstSum.values).not.toContain(999);
    expect(firstSum.values).not.toContain(-5);
    // The mechanism receives clamp bounds, never the raw values.
    expect(firstSum.lower).toBe(0);
    expect(firstSum.upper).toBe(200);
  });

  it("clamps a NaN speed to the floor before it reaches the mechanism", () => {
    const manifest = standardManifest();
    const params = standardParams();
    const mechanism = standardMechanism();
    const ledger = new BudgetLedger(params.budget);
    const store = new ReleaseStore();

    const dataset: SpeedTuple[] = [
      { privacyUnitId: "U1", segmentId: "seg-b", timestampMs: 1_000, speed: Number.NaN },
      { privacyUnitId: "U2", segmentId: "seg-b", timestampMs: 1_000, speed: 300 },
    ];

    releaseWithDp(dataset, manifest, params, mechanism, ledger, store);

    const values = allSumValues(mechanism);
    // No NaN and nothing out of range ever reaches the mechanism.
    expect(values.every((v) => Number.isFinite(v))).toBe(true);
    expect(values.every((v) => v >= 0 && v <= 200)).toBe(true);
    expect(values).toContain(0); // NaN -> floor
    expect(values).toContain(200); // 300 -> ceiling
  });
});
