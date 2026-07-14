import { describe, expect, it } from "vitest";
import {
  detectAnomaly,
  peerWindowStats,
  type PeerBaseline,
  type PeerWindowStats,
} from "../anomaly.js";

const BASELINE: PeerBaseline = {
  eventsPerMin: 10,
  typeEntropy: 1.8,
  meanConfidence: 0.6,
};

const NORMAL: PeerWindowStats = {
  eventsPerMin: 11,
  typeEntropy: 1.7,
  meanConfidence: 0.62,
};

describe("detectAnomaly", () => {
  it("flags a 10x event-rate spike as anomalous with the named signal", () => {
    const res = detectAnomaly(BASELINE, { ...NORMAL, eventsPerMin: 120 });
    expect(res.anomalous).toBe(true);
    expect(res.signals).toContain("event_rate_spike");
  });

  it("flags a collapsed type-entropy as anomalous with the named signal", () => {
    const res = detectAnomaly(BASELINE, { ...NORMAL, typeEntropy: 0.1 });
    expect(res.anomalous).toBe(true);
    expect(res.signals).toContain("type_entropy_collapse");
  });

  it("flags a large confidence-distribution shift", () => {
    const res = detectAnomaly(BASELINE, { ...NORMAL, meanConfidence: 0.05 });
    expect(res.anomalous).toBe(true);
    expect(res.signals).toContain("confidence_shift");
  });

  it("does not flag a window close to its baseline", () => {
    const res = detectAnomaly(BASELINE, NORMAL);
    expect(res.anomalous).toBe(false);
    expect(res.signals).toEqual([]);
  });
});

describe("peerWindowStats", () => {
  it("derives rate, entropy and mean confidence from a raw window", () => {
    const stats = peerWindowStats({
      windowSec: 60,
      typeCounts: { incident: 2, roadworks: 2 },
      confidences: [0.5, 0.7],
    });
    expect(stats.eventsPerMin).toBeCloseTo(4);
    // Two equally-likely types → 1 bit of entropy.
    expect(stats.typeEntropy).toBeCloseTo(1);
    expect(stats.meanConfidence).toBeCloseTo(0.6);
  });

  it("reports zero entropy for a single-type collapse", () => {
    const stats = peerWindowStats({
      windowSec: 60,
      typeCounts: { incident: 8 },
      confidences: [],
    });
    expect(stats.typeEntropy).toBe(0);
    expect(stats.eventsPerMin).toBeCloseTo(8);
  });
});
