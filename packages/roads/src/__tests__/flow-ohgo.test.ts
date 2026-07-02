import { describe, expect, it } from "vitest";
import { parseOhgoFlow } from "../flow-ohgo.js";
import type { SourceDescriptor } from "../types.js";

const src = {
  id: "ohgo-oh-us",
  attribution: "Ohio DOT",
  country: "US",
  license: "US-Gov-Public-Domain",
} as SourceDescriptor;

const payload = JSON.stringify({
  Results: [
    {
      Id: "d1",
      Latitude: 40.0,
      Longitude: -82.9,
      CurrentAvgSpeed: 20,
      NormalAvgSpeed: 65,
      Direction: "EB",
      LastUpdated: "2026-03-04T14:30:00Z",
    },
    {
      Id: "d2",
      Latitude: 40.1,
      Longitude: -83.0,
      CurrentAvgSpeed: 62,
      NormalAvgSpeed: 65,
      Direction: "WB",
      LastUpdated: "2026-03-04T14:30:00Z",
    },
  ],
});

describe("parseOhgoFlow", () => {
  it("uses inline NormalAvgSpeed as the native freeFlowKph and classifies via reclassifyFlow", () => {
    const { flows, events } = parseOhgoFlow(payload, src);
    const slow = flows.find((f) => f.id === "ohgo-oh-us:d1")!;
    expect(slow.speedKph).toBeCloseTo(20 * 1.609344, 2);
    expect(slow.freeFlowKph).toBeCloseTo(65 * 1.609344, 2);
    expect(slow.freeFlowSource).toBe("native");
    expect(slow.direction).toBe("EB");
    expect(slow.los).toBe("queuing"); // ratio 20/65 ≈ 0.31
    expect(events.some((e) => e.id === "ohgo-oh-us:d1:congestion" && e.direction === "EB")).toBe(
      true
    );
    const ok = flows.find((f) => f.id === "ohgo-oh-us:d2")!;
    expect(ok.los).toBe("free_flow"); // 62/65 ≈ 0.95
  });

  it("returns empty on malformed input", () => {
    expect(parseOhgoFlow("x", src)).toEqual({ flows: [], events: [] });
  });
});
