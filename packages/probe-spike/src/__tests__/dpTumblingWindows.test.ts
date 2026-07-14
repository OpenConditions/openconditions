import { describe, expect, it } from "vitest";
import {
  buildReleaseManifest,
  BudgetLedger,
  OverlappingWindowError,
  plannedPartitions,
  releaseWithDp,
  ReleaseStore,
  windowForTimestamp,
  type SpeedTuple,
} from "../index.js";
import { HOUR_MS, standardManifest, standardMechanism, standardParams } from "./dpFixtures.js";

describe("invariant 3: tumbling windows fixed in a versioned manifest before data", () => {
  it("rejects overlapping / sliding windows by construction", () => {
    expect(() =>
      buildReleaseManifest({
        version: "bad",
        segmentIds: ["seg-a"],
        windows: [
          { windowId: "w1", startMs: 0, endMs: HOUR_MS },
          { windowId: "w2", startMs: HOUR_MS / 2, endMs: HOUR_MS + HOUR_MS / 2 }, // slides
        ],
      })
    ).toThrow(OverlappingWindowError);

    expect(() =>
      buildReleaseManifest({
        version: "bad",
        segmentIds: ["seg-a"],
        windows: [{ windowId: "w1", startMs: HOUR_MS, endMs: 0 }], // inverted
      })
    ).toThrow(OverlappingWindowError);
  });

  it("places any contribution in at most one window (end-exclusive)", () => {
    const manifest = standardManifest();
    // A timestamp on the boundary belongs to exactly one window.
    expect(windowForTimestamp(manifest, HOUR_MS)?.windowId).toBe("w2");
    expect(windowForTimestamp(manifest, HOUR_MS - 1)?.windowId).toBe("w1");
    expect(windowForTimestamp(manifest, 2 * HOUR_MS)).toBeUndefined();
  });

  it("chooses the manifest, partition list, and query count independent of the data", () => {
    const manifest = standardManifest();
    const params = standardParams();

    const datasetA: SpeedTuple[] = [
      { privacyUnitId: "U1", segmentId: "seg-a", timestampMs: 1_000, speed: 100 },
    ];
    const datasetB: SpeedTuple[] = [
      { privacyUnitId: "U9", segmentId: "seg-b", timestampMs: HOUR_MS + 1, speed: 40 },
      { privacyUnitId: "U8", segmentId: "seg-a", timestampMs: 2_000, speed: 55 },
      { privacyUnitId: "U7", segmentId: "seg-b", timestampMs: 500, speed: 88 },
    ];

    const mechA = standardMechanism();
    const mechB = standardMechanism();
    releaseWithDp(
      datasetA,
      manifest,
      params,
      mechA,
      new BudgetLedger(params.budget),
      new ReleaseStore()
    );
    releaseWithDp(
      datasetB,
      manifest,
      params,
      mechB,
      new BudgetLedger(params.budget),
      new ReleaseStore()
    );

    // The planned partition list is exactly the fixed 4-cell grid, regardless of
    // which dataset is fed.
    expect(plannedPartitions(manifest)).toEqual([
      { segmentId: "seg-a", windowId: "w1" },
      { segmentId: "seg-a", windowId: "w2" },
      { segmentId: "seg-b", windowId: "w1" },
      { segmentId: "seg-b", windowId: "w2" },
    ]);
    // Identical query count across two different datasets.
    expect(mechA.selectPartitionCount).toBe(mechB.selectPartitionCount);
    expect(mechA.boundedSumCount).toBe(mechB.boundedSumCount);
    expect(mechA.selectPartitionCount).toBe(4);
  });
});
