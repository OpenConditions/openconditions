import { describe, expect, it } from "vitest";
import { runEncodeBenchmark, type RegionSpec } from "../index.js";

const REGION: RegionSpec = {
  regionId: "region-nl-utrecht-coarse",
  window: "2026-07-14T08:00Z/1h",
  segmentCount: 16,
  speedBucketCount: 8,
};

describe("invariant 5: encode benchmark (A) private one-hot vs (B) coarse partition", () => {
  it("produces report byte size + encode CPU time for both approaches within sane bounds", async () => {
    const results = await runEncodeBenchmark(REGION, 90, 3, 40);
    expect(results).toHaveLength(2);

    const [a, b] = results;
    expect(a!.approach).toBe("A-private-one-hot");
    expect(b!.approach).toBe("B-coarse-partition");

    for (const r of results) {
      expect(r.reportBytes).toBeGreaterThan(0);
      expect(r.meanEncodeMs).toBeGreaterThanOrEqual(0);
      // Generous CI upper bound — this is a sanity gate, not a perf SLA.
      expect(r.meanEncodeMs).toBeLessThan(500);
    }

    // Hiding the segment (approach A) costs more wire bytes than disclosing it (B).
    expect(a!.reportBytes).toBeGreaterThan(b!.reportBytes);

    // Surface the numbers for the report artifact.
    console.log("probe-spike encode benchmark:", JSON.stringify(results, null, 2));
  });
});
