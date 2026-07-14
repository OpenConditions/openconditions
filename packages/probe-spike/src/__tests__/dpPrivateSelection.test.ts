import { describe, expect, it } from "vitest";
import { BudgetLedger, releaseWithDp, ReleaseStore, type SpeedTuple } from "../index.js";
import { standardManifest, standardMechanism, standardParams } from "./dpFixtures.js";

describe("invariant 2: private selection, no exact-k", () => {
  const manifest = standardManifest();
  const params = standardParams();

  const dataset: SpeedTuple[] = [
    // seg-a/w1: two distinct units -> at/above the mechanism threshold (2).
    { privacyUnitId: "U1", segmentId: "seg-a", timestampMs: 1_000, speed: 100 },
    { privacyUnitId: "U2", segmentId: "seg-a", timestampMs: 1_000, speed: 120 },
    // seg-b/w1: a single unit -> below threshold, must be suppressed.
    { privacyUnitId: "U3", segmentId: "seg-b", timestampMs: 1_000, speed: 90 },
  ];

  it("releases a cell only when selectPartition returns released, and suppresses the rest auditably", () => {
    const mechanism = standardMechanism(2);
    const ledger = new BudgetLedger(params.budget);
    const store = new ReleaseStore();

    const result = releaseWithDp(dataset, manifest, params, mechanism, ledger, store);

    // The above-threshold cell is released; the below-threshold cell is withheld.
    expect(result.rows.map((r) => `${r.segmentId}/${r.windowId}`)).toContain("seg-a/w1");
    expect(result.rows.map((r) => `${r.segmentId}/${r.windowId}`)).not.toContain("seg-b/w1");
    expect(result.suppressed.map((s) => `${s.segmentId}/${s.windowId}`)).toContain("seg-b/w1");

    // Every public partition was evaluated (query count is data-independent).
    expect(mechanism.selectPartitionCount).toBe(4);
  });

  it("never publishes the raw contributor count as k / sample_count or a divisor", () => {
    const mechanism = standardMechanism(2);
    const ledger = new BudgetLedger(params.budget);
    const store = new ReleaseStore();

    const result = releaseWithDp(dataset, manifest, params, mechanism, ledger, store);

    for (const row of result.rows) {
      expect(Object.keys(row).sort()).toEqual(["noisySum", "segmentId", "windowId"]);
      const asRecord = row as unknown as Record<string, unknown>;
      expect(asRecord.k).toBeUndefined();
      expect(asRecord.sample_count).toBeUndefined();
      expect(asRecord.rawCount).toBeUndefined();
    }

    // The raw count IS handed to the private-selection mechanism (which owns it),
    // proving it exists but is never surfaced in the released row.
    const selectCalls = mechanism.calls.filter((c) => c.method === "selectPartition");
    const segA = selectCalls.find((c) => c.method === "selectPartition" && c.rawCount === 2);
    expect(segA).toBeDefined();
  });
});
