import { describe, expect, it } from "vitest";
import { parseLtaSpeedBands } from "../flow-lta-speedbands.js";
import type { SourceDescriptor } from "../types.js";

const src = {
  id: "lta-speedbands-sg",
  attribution: "Land Transport Authority (Singapore)",
  country: "SG",
  license: "Singapore-ODL-1.0",
} as SourceDescriptor;

// Shape mirrors the DataMall Traffic Speed Bands `value` array.
const payload = JSON.stringify({
  value: [
    {
      LinkID: "103000000",
      RoadName: "KENT ROAD",
      SpeedBand: 3,
      MinimumSpeed: "21",
      MaximumSpeed: "29",
      StartLon: "103.8515",
      StartLat: "1.3220",
      EndLon: "103.8530",
      EndLat: "1.3225",
    },
    { LinkID: "no-geometry", SpeedBand: 5, MinimumSpeed: "40", MaximumSpeed: "49" },
  ],
});

describe("parseLtaSpeedBands", () => {
  it("builds a Start→End LineString and the band-midpoint speed", () => {
    const { flows } = parseLtaSpeedBands(payload, src);
    expect(flows).toHaveLength(1);
    expect(flows[0]!.id).toBe("lta-speedbands-sg:103000000");
    expect(flows[0]!.sourceFormat).toBe("lta-speedbands-json");
    expect(flows[0]!.speedKph).toBe(25); // (21 + 29) / 2
    expect(flows[0]!.los).toBe("unknown");
    expect(flows[0]!.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [103.8515, 1.322],
        [103.853, 1.3225],
      ],
    });
  });

  it("flags a hard parse failure", () => {
    expect(parseLtaSpeedBands("nope", src).failed).toBe(true);
    expect(parseLtaSpeedBands(JSON.stringify({}), src).failed).toBe(true);
  });
});
