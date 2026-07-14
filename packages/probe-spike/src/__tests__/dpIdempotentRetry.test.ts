import { describe, expect, it } from "vitest";
import { BudgetLedger, releaseWithDp, ReleaseStore, type SpeedTuple } from "../index.js";
import { standardManifest, standardMechanism, standardParams } from "./dpFixtures.js";

describe("invariant 4: idempotent randomness / retry", () => {
  const manifest = standardManifest();
  const params = standardParams();
  const dataset: SpeedTuple[] = [
    { privacyUnitId: "U1", segmentId: "seg-a", timestampMs: 1_000, speed: 100 },
    { privacyUnitId: "U2", segmentId: "seg-a", timestampMs: 1_000, speed: 120 },
  ];

  it("returns the committed result and spends the mechanism + budget exactly once on retry", () => {
    const mechanism = standardMechanism(2);
    const ledger = new BudgetLedger(params.budget);
    const store = new ReleaseStore();

    const first = releaseWithDp(dataset, manifest, params, mechanism, ledger, store);
    const boundedSumsAfterFirst = mechanism.boundedSumCount;
    const spendAfterFirst = ledger.snapshot();

    const second = releaseWithDp(dataset, manifest, params, mechanism, ledger, store);

    expect(first.retried).toBe(false);
    expect(second.retried).toBe(true);
    // Byte-identical released values — no fresh noise draw.
    expect(second.rows).toEqual(first.rows);
    expect(second.suppressed).toEqual(first.suppressed);
    // The mechanism's noisy call is NOT re-invoked on retry.
    expect(mechanism.boundedSumCount).toBe(boundedSumsAfterFirst);
    // Budget is spent once, not twice.
    expect(ledger.snapshot()).toEqual(spendAfterFirst);
    expect(ledger.spent("U1").epsilon).toBeCloseTo(0.6);
    expect(ledger.spent("U2").epsilon).toBeCloseTo(0.6);
  });
});
