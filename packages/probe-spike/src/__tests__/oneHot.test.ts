import { describe, expect, it } from "vitest";
import {
  aggregateBatch,
  cellCount,
  encodePrivateSegment,
  freshVerifyKey,
  histogramForRegion,
  measurementCell,
  prepareReport,
  reportByteSize,
  shardStructured,
  speedToBucket,
  type RegionSpec,
} from "../index.js";

const REGION: RegionSpec = {
  regionId: "region-nl-utrecht-coarse",
  window: "2026-07-14T08:00Z/1h",
  segmentCount: 16,
  speedBucketCount: 8,
};

describe("invariant 1: one-hot segment enforcement", () => {
  it("produces exactly two input shares (Leader + Helper), never a single aggregator", async () => {
    const report = await encodePrivateSegment(REGION, { segmentIndex: 3, clampedSpeed: 90 });
    expect(report.inputShares).toHaveLength(2);
    expect(reportByteSize(report)).toBeGreaterThan(0);
  });

  it("a valid single (segment, speed) cell encodes and aggregates to one count in one cell", async () => {
    const vdaf = histogramForRegion(REGION);
    const cell = measurementCell(REGION, { segmentIndex: 3, clampedSpeed: 90 });
    const verifyKey = freshVerifyKey(vdaf);
    const report = await shardStructured(vdaf, cell);
    const prepared = await prepareReport(vdaf, verifyKey, report);
    const aggregate = aggregateBatch(vdaf, [prepared]);

    expect(aggregate).toHaveLength(cellCount(REGION));
    expect(aggregate[cell]).toBe(1);
    expect(aggregate.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("REJECTS a multi-hot report at the aggregators (a second segment's cell set)", async () => {
    const vdaf = histogramForRegion(REGION);
    const cell = measurementCell(REGION, { segmentIndex: 3, clampedSpeed: 90 });
    const otherCell = measurementCell(REGION, { segmentIndex: 9, clampedSpeed: 40 });
    const verifyKey = freshVerifyKey(vdaf);
    const report = await shardStructured(vdaf, cell);

    await expect(
      prepareReport(vdaf, verifyKey, report, (shares) => {
        // Malicious client sets a SECOND segment's cell in the Leader share.
        shares[0]!.measurementShare[otherCell] =
          (shares[0]!.measurementShare[otherCell] ?? 0n) + 1n;
      })
    ).rejects.toThrow("Verify error");
  });

  it("REJECTS a value-inflated report at the aggregators (one cell forced above one)", async () => {
    const vdaf = histogramForRegion(REGION);
    const cell = measurementCell(REGION, { segmentIndex: 3, clampedSpeed: 90 });
    const verifyKey = freshVerifyKey(vdaf);
    const report = await shardStructured(vdaf, cell);

    await expect(
      prepareReport(vdaf, verifyKey, report, (shares) => {
        shares[0]!.measurementShare[cell] = (shares[0]!.measurementShare[cell] ?? 0n) + 1n;
      })
    ).rejects.toThrow("Verify error");
  });

  it("REJECTS a one-hot shifted to another cell without a fresh proof", async () => {
    // A true out-of-range index is structurally inexpressible: the histogram has
    // exactly cellCount(REGION) slots, so a malicious client can only move the
    // one-hot WITHIN range. Moving it without re-proving still fails the FLP,
    // which is what binds the proof + joint randomness to the encoded cell.
    const vdaf = histogramForRegion(REGION);
    const cell = measurementCell(REGION, { segmentIndex: 0, clampedSpeed: 10 });
    const verifyKey = freshVerifyKey(vdaf);
    const report = await shardStructured(vdaf, cell);
    const beyond = cellCount(REGION) - 1;

    await expect(
      prepareReport(vdaf, verifyKey, report, (shares) => {
        shares[0]!.measurementShare[cell] = (shares[0]!.measurementShare[cell] ?? 0n) - 1n;
        shares[0]!.measurementShare[beyond] = (shares[0]!.measurementShare[beyond] ?? 0n) + 1n;
      })
    ).rejects.toThrow("Verify error");
  });

  it("client-side: rejects a segment index outside the region before encoding", async () => {
    await expect(
      encodePrivateSegment(REGION, { segmentIndex: REGION.segmentCount, clampedSpeed: 50 })
    ).rejects.toThrow(/segmentIndex/);
  });

  it("client-side: rejects a speed outside the fixed-point bound [0, 200]", async () => {
    await expect(
      encodePrivateSegment(REGION, { segmentIndex: 1, clampedSpeed: 201 })
    ).rejects.toThrow(/\[0, 200\]/);
    expect(() => speedToBucket(-1, REGION.speedBucketCount)).toThrow();
    // The boundary value 200 is IN range and lands in the top bucket.
    expect(speedToBucket(200, REGION.speedBucketCount)).toBe(REGION.speedBucketCount - 1);
  });
});
