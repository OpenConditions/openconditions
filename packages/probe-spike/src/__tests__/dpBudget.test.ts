import { describe, expect, it } from "vitest";
import {
  BudgetLedger,
  RecordingDpMechanism,
  releaseWithDp,
  ReleaseStore,
  type SpeedTuple,
} from "../index.js";
import { allSumValues, standardManifest, standardParams } from "./dpFixtures.js";

// A release-threshold of 1 so a single admitted unit is enough to release,
// isolating the budget decision from the private-selection decision.
function thresholdOneMechanism(): RecordingDpMechanism {
  return new RecordingDpMechanism({
    sumStandIn: 42,
    selectThreshold: 1,
    epsilonSpentPerSum: 0.5,
    epsilonSpentPerSelect: 0.1,
    deltaSpentPerSelect: 1e-6,
  });
}

describe("invariant 5: user-level budget, fail-closed", () => {
  const manifest = standardManifest();
  // Per-cell cost = epsilonSum + epsilonSelect = 0.6; budget = 1.0 fits one cell.
  const params = standardParams({ budget: { epsilon: 1.0, delta: 1e-3 } });

  it("suppresses an over-budget unit but lets a within-budget unit's release proceed", () => {
    const mechanism = thresholdOneMechanism();
    const ledger = new BudgetLedger(params.budget);
    ledger.charge("U_exhausted", { epsilon: 0.8, delta: 0 }); // remaining 0.2 < 0.6
    const store = new ReleaseStore();

    const dataset: SpeedTuple[] = [
      { privacyUnitId: "U_exhausted", segmentId: "seg-a", timestampMs: 1_000, speed: 100 },
      { privacyUnitId: "U_ok", segmentId: "seg-a", timestampMs: 1_000, speed: 120 },
    ];

    const result = releaseWithDp(dataset, manifest, params, mechanism, ledger, store);

    const values = allSumValues(mechanism);
    expect(values).not.toContain(100); // exhausted unit never reaches the mechanism
    expect(values).toContain(120); // within-budget unit proceeds
    expect(result.rows.map((r) => `${r.segmentId}/${r.windowId}`)).toContain("seg-a/w1");
    // The exhausted unit's spend is unchanged; the admitted unit is charged once.
    expect(ledger.spent("U_exhausted").epsilon).toBeCloseTo(0.8);
    expect(ledger.spent("U_ok").epsilon).toBeCloseTo(0.6);
  });

  it("produces NO release when the only contributor is out of budget", () => {
    const mechanism = thresholdOneMechanism();
    const ledger = new BudgetLedger(params.budget);
    ledger.charge("U_exhausted", { epsilon: 0.9, delta: 0 });
    const store = new ReleaseStore();

    const dataset: SpeedTuple[] = [
      { privacyUnitId: "U_exhausted", segmentId: "seg-b", timestampMs: 1_000, speed: 100 },
    ];

    const result = releaseWithDp(dataset, manifest, params, mechanism, ledger, store);
    expect(result.rows.map((r) => `${r.segmentId}/${r.windowId}`)).not.toContain("seg-b/w1");
    expect(result.suppressed.map((s) => `${s.segmentId}/${s.windowId}`)).toContain("seg-b/w1");
  });

  it("tracks cumulative spend across every cell a unit can affect, not per segment", () => {
    const mechanism = thresholdOneMechanism();
    const ledger = new BudgetLedger(params.budget); // budget 1.0
    const store = new ReleaseStore();

    // U_multi is in TWO cells: cost 2 x 0.6 = 1.2 > 1.0 -> dropped from BOTH.
    const dataset: SpeedTuple[] = [
      { privacyUnitId: "U_multi", segmentId: "seg-a", timestampMs: 1_000, speed: 173 },
      { privacyUnitId: "U_multi", segmentId: "seg-a", timestampMs: 3_600_001, speed: 173 },
    ];

    releaseWithDp(dataset, manifest, params, mechanism, ledger, store);

    // A per-segment budget would have admitted each 0.6 cell; the per-unit
    // cumulative floor refuses both.
    expect(allSumValues(mechanism)).not.toContain(173);
    expect(ledger.spent("U_multi").epsilon).toBe(0);
  });
});
