import { describe, expect, it } from "vitest";
import {
  BudgetLedger,
  plannedPartitions,
  releaseWithDp,
  ReleaseStore,
  type ReleaseFaults,
  type SpeedTuple,
} from "../index.js";
import {
  allSumValues,
  HOUR_MS,
  partitionsContainingValue,
  standardManifest,
  standardMechanism,
  standardParams,
} from "./dpFixtures.js";

// A base dataset and its neighbor that differs by EXACTLY one device-key epoch's
// contribution (U_new). U_new lands in seg-a/w2, a cell that is EMPTY in BASE
// (rawCount 0) and holds one tuple in NEIGHBOR (rawCount 1). It is kept BELOW the
// selection threshold (2) in both datasets so the release decision does NOT flip
// — the audit tests data-independence of the glue's CONTROL FLOW, not the
// mechanism's legitimately data-dependent threshold. A support-blind neighbor
// (adding to an already-non-empty cell) would fail to expose the canonical
// "query only non-empty partitions" loop-count bug; adding to an empty cell does.
const BASE: SpeedTuple[] = [
  { privacyUnitId: "U1", segmentId: "seg-a", timestampMs: 1_000, speed: 100 },
  { privacyUnitId: "U2", segmentId: "seg-a", timestampMs: 1_500, speed: 120 },
  { privacyUnitId: "U3", segmentId: "seg-b", timestampMs: HOUR_MS + 1_000, speed: 60 },
  { privacyUnitId: "U4", segmentId: "seg-b", timestampMs: HOUR_MS + 1_500, speed: 70 },
  { privacyUnitId: "U5", segmentId: "seg-b", timestampMs: HOUR_MS + 2_000, speed: 80 },
];
const NEIGHBOR: SpeedTuple[] = [
  ...BASE,
  { privacyUnitId: "U_new", segmentId: "seg-a", timestampMs: HOUR_MS + 1_200, speed: 90 },
];

function run(dataset: SpeedTuple[], faults: ReleaseFaults = {}) {
  const manifest = standardManifest();
  const params = standardParams();
  const mechanism = standardMechanism(2);
  const ledger = new BudgetLedger(params.budget);
  const store = new ReleaseStore();
  const result = releaseWithDp(dataset, manifest, params, mechanism, ledger, store, faults);
  return { manifest, params, mechanism, ledger, store, result };
}

describe("invariant 6: grey-box add/remove-one-device-epoch audit", () => {
  it("drives byte-identical mechanism calls, parameters, and control-flow traces for neighboring datasets", () => {
    const a = run(BASE);
    const b = run(NEIGHBOR);

    // Data-independent mechanism control projection (method + ε/δ/lower/upper).
    expect(a.mechanism.controlTrace()).toEqual(b.mechanism.controlTrace());
    // Identical partition list and identical query count.
    expect(plannedPartitions(a.manifest)).toEqual(plannedPartitions(b.manifest));
    expect(a.mechanism.selectPartitionCount).toBe(b.mechanism.selectPartitionCount);
    expect(a.mechanism.boundedSumCount).toBe(b.mechanism.boundedSumCount);
    // Identical glue control-flow trace.
    expect(a.result.controlTrace).toEqual(b.result.controlTrace);
    // No release decision flips: same released rows and same suppressions.
    expect(a.result.rows).toEqual(b.result.rows);
    expect(a.result.suppressed).toEqual(b.result.suppressed);

    // The ONLY difference is the data-bearing payload of the affected cell
    // (seg-a/w2 — the second partition, and the second boundedSum call): empty in
    // BASE, one value in NEIGHBOR. Every other call is byte-identical.
    const aSums = a.mechanism.calls.filter((c) => c.method === "boundedSum");
    const bSums = b.mechanism.calls.filter((c) => c.method === "boundedSum");
    const aAffected = aSums[1];
    const bAffected = bSums[1];
    if (aAffected?.method !== "boundedSum" || bAffected?.method !== "boundedSum") {
      throw new Error("expected boundedSum calls");
    }
    expect(aAffected.values).toHaveLength(0);
    expect(bAffected.values).toEqual([90]);
    expect(bAffected.values.length).toBe(aAffected.values.length + 1);
  });

  describe("guard tests: each buggy variant MUST trip the audit", () => {
    it("catches an unclamped / NaN value reaching the mechanism", () => {
      const dirtyData: SpeedTuple[] = [
        { privacyUnitId: "U1", segmentId: "seg-a", timestampMs: 1_000, speed: 999 },
        { privacyUnitId: "U2", segmentId: "seg-a", timestampMs: 1_000, speed: Number.NaN },
      ];
      const clean = run(dirtyData);
      expect(
        allSumValues(clean.mechanism).every((v) => Number.isFinite(v) && v >= 0 && v <= 200)
      ).toBe(true);

      const buggy = run(dirtyData, { skipClamp: true });
      const values = allSumValues(buggy.mechanism);
      // The clamp guard would trip: an out-of-range value and a NaN reach the mechanism.
      expect(values.some((v) => v > 200)).toBe(true);
      expect(values.some((v) => Number.isNaN(v))).toBe(true);
    });

    it("catches a data-dependent noise scale (ε varying with the raw count)", () => {
      const a = run(BASE, { dataDependentEpsilon: true });
      const b = run(NEIGHBOR, { dataDependentEpsilon: true });
      // With a data-dependent ε the neighboring runs no longer match — audit trips.
      expect(a.mechanism.controlTrace()).not.toEqual(b.mechanism.controlTrace());
    });

    it("catches a data-dependent selection threshold (selection ε varying with the raw count)", () => {
      const a = run(BASE, { dataDependentThreshold: true });
      const b = run(NEIGHBOR, { dataDependentThreshold: true });
      // The affected empty→1 cell's selection ε diverges, surfacing in the
      // mechanism control projection — audit trips.
      expect(a.mechanism.controlTrace()).not.toEqual(b.mechanism.controlTrace());
      // The correct glue keeps the selection ε identical across neighbors.
      const clean = run(BASE);
      const cleanNeighbor = run(NEIGHBOR);
      expect(clean.mechanism.controlTrace()).toEqual(cleanNeighbor.mechanism.controlTrace());
    });

    it("catches a data-dependent loop count (querying only non-empty partitions)", () => {
      // Correct glue: both neighbors sweep the full 4-cell grid.
      const cleanA = run(BASE);
      const cleanB = run(NEIGHBOR);
      expect(cleanA.mechanism.selectPartitionCount).toBe(4);
      expect(cleanB.mechanism.selectPartitionCount).toBe(4);
      expect(cleanA.result.controlTrace).toEqual(cleanB.result.controlTrace);

      // Buggy glue: iterating only non-empty cells makes the query count and the
      // control-flow trace depend on which cells the data populated. BASE has 2
      // non-empty cells; NEIGHBOR fills seg-a/w2 to 3 — the audit trips.
      const buggyA = run(BASE, { skipEmptyPartitions: true });
      const buggyB = run(NEIGHBOR, { skipEmptyPartitions: true });
      expect(buggyA.mechanism.selectPartitionCount).toBe(2);
      expect(buggyB.mechanism.selectPartitionCount).toBe(3);
      expect(buggyA.mechanism.selectPartitionCount).not.toBe(buggyB.mechanism.selectPartitionCount);
      expect(buggyA.mechanism.controlTrace()).not.toEqual(buggyB.mechanism.controlTrace());
      expect(buggyA.result.controlTrace).not.toEqual(buggyB.result.controlTrace);
    });

    it("catches multi-partition influence from one unit beyond the bound", () => {
      const spread: SpeedTuple[] = [
        { privacyUnitId: "U_multi", segmentId: "seg-a", timestampMs: 1_000, speed: 173 },
        { privacyUnitId: "U_multi", segmentId: "seg-a", timestampMs: HOUR_MS + 1_000, speed: 173 },
        { privacyUnitId: "U_multi", segmentId: "seg-b", timestampMs: 1_000, speed: 173 },
      ];
      const clean = run(spread); // maxPartitionsPerUnit = 2
      expect(partitionsContainingValue(clean.mechanism, 173)).toBe(2);

      const buggy = run(spread, { skipPartitionBound: true });
      // The bound guard would trip: one unit now influences 3 partitions.
      expect(partitionsContainingValue(buggy.mechanism, 173)).toBe(3);
    });

    it("catches fresh-noise-on-retry (retry re-invoking the mechanism and re-spending)", () => {
      const dataset = BASE;
      const manifest = standardManifest();
      const params = standardParams();

      // Correct behavior: retry is served from the committed marker.
      {
        const mechanism = standardMechanism(2);
        const ledger = new BudgetLedger(params.budget);
        const store = new ReleaseStore();
        releaseWithDp(dataset, manifest, params, mechanism, ledger, store);
        const afterFirst = mechanism.boundedSumCount;
        const spentFirst = ledger.spent("U1").epsilon;
        releaseWithDp(dataset, manifest, params, mechanism, ledger, store);
        expect(mechanism.boundedSumCount).toBe(afterFirst);
        expect(ledger.spent("U1").epsilon).toBe(spentFirst);
      }

      // Buggy behavior: ignoring the marker re-draws noise and double-spends.
      {
        const mechanism = standardMechanism(2);
        const ledger = new BudgetLedger(params.budget);
        const store = new ReleaseStore();
        releaseWithDp(dataset, manifest, params, mechanism, ledger, store, {
          ignoreRetryMarker: true,
        });
        const afterFirst = mechanism.boundedSumCount;
        const spentFirst = ledger.spent("U1").epsilon;
        releaseWithDp(dataset, manifest, params, mechanism, ledger, store, {
          ignoreRetryMarker: true,
        });
        expect(mechanism.boundedSumCount).toBe(afterFirst * 2);
        expect(ledger.spent("U1").epsilon).toBeCloseTo(spentFirst * 2);
      }
    });
  });
});
