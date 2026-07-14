import { describe, expect, it } from "vitest";
import {
  aggregateBatch,
  cellCount,
  freshVerifyKey,
  histogramForRegion,
  measurementCell,
  prepareReport,
  PUBLIC_METADATA_DISCLOSURE,
  shardStructured,
  type RegionSpec,
} from "../index.js";

const REGION: RegionSpec = {
  regionId: "region-nl-utrecht-coarse",
  window: "2026-07-14T08:00Z/1h",
  segmentCount: 16,
  speedBucketCount: 8,
};

describe("invariant 4: share confidentiality", () => {
  it("neither the Leader nor the Helper input or output share alone equals the measurement", async () => {
    const vdaf = histogramForRegion(REGION);
    const cell = measurementCell(REGION, { segmentIndex: 7, clampedSpeed: 130 });
    const verifyKey = freshVerifyKey(vdaf);
    const report = await shardStructured(vdaf, cell);

    const plaintextOneHot = Array.from({ length: cellCount(REGION) }, (_, i) =>
      i === cell ? 1n : 0n
    );

    // The two structured INPUT shares (what actually travels over the wire, one
    // per aggregator) each carry a masked measurement vector: neither equals the
    // plaintext one-hot, and each spreads mass across cells rather than spiking
    // at the true cell.
    const [leaderInput, helperInput] = report.inputShares;
    expect(leaderInput!.measurementShare).not.toEqual(plaintextOneHot);
    expect(helperInput!.measurementShare).not.toEqual(plaintextOneHot);
    expect(leaderInput!.measurementShare.filter((v) => v !== 0n).length).toBeGreaterThan(1);
    expect(helperInput!.measurementShare.filter((v) => v !== 0n).length).toBeGreaterThan(1);

    const prepared = await prepareReport(vdaf, verifyKey, report);

    expect(prepared.outputShares).toHaveLength(2);
    const [leader, helper] = prepared.outputShares;

    // Each additive output share is masked: it is NOT the plaintext one-hot,
    // and the two shares are not equal to each other.
    expect(leader).not.toEqual(plaintextOneHot);
    expect(helper).not.toEqual(plaintextOneHot);
    expect(leader).not.toEqual(helper);

    // A single share carries mass spread across many cells, not a clean spike at
    // the true cell — it does not decode to the segment.
    const leaderNonZero = leader!.filter((v) => v !== 0n).length;
    expect(leaderNonZero).toBeGreaterThan(1);

    // Only the COMBINED aggregation over the batch yields the true one-hot.
    const aggregate = aggregateBatch(vdaf, [prepared]);
    expect(aggregate[cell]).toBe(1);
    expect(aggregate.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("enumerates exactly what public metadata each aggregator sees", () => {
    const seen = PUBLIC_METADATA_DISCLOSURE.aggregatorSees;
    expect(seen).toContain("task id (the DAP task identifier)");
    expect(seen).toContain("report id / 16-byte VDAF nonce");
    expect(seen).toContain(
      "this aggregator's own input share (an additive share that reveals nothing alone)"
    );

    // The private fields must never appear in what an aggregator sees.
    const seenText = seen.join(" | ");
    expect(seenText).not.toMatch(/clamped speed value/);
    expect(seenText).not.toMatch(/private segment index/);

    const never = PUBLIC_METADATA_DISCLOSURE.neverVisibleToOneAggregator;
    expect(never).toContain("the private segment index (approach A)");
    expect(never).toContain("the clamped speed value");
    expect(never).toContain("the reporter identity or admission key id");
    expect(never).toContain("the other aggregator's input share");
  });
});
