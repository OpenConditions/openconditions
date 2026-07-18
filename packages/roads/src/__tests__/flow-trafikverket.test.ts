import { describe, expect, it } from "vitest";
import { parseTrafikverketFlow } from "../flow-trafikverket.js";
import type { SourceDescriptor } from "../types.js";

const src = {
  id: "se-trafikverket-flow",
  attribution: "Trafikverket",
  country: "SE",
  license: "CC0-1.0",
} as SourceDescriptor;

const payload = JSON.stringify({
  RESPONSE: {
    RESULT: [
      {
        TrafficFlow: [
          {
            SiteId: "TMS-1",
            AverageVehicleSpeed: 92,
            VehicleFlowRate: 800,
            MeasurementTime: "2026-03-04T14:30:00Z",
            Geometry: { WGS84: "POINT (18.06 59.33)" },
          },
          {
            SiteId: "TMS-2",
            AverageVehicleSpeed: -1,
            Geometry: { WGS84: "POINT (17.0 58.0)" },
          },
          {
            SiteId: "TMS-3",
            VehicleFlowRate: 100,
            Geometry: { WGS84: "POINT (16.0 57.0)" },
          },
          {
            SiteId: "TMS-4",
            AverageVehicleSpeed: 80,
          },
        ],
      },
    ],
  },
});

describe("parseTrafikverketFlow", () => {
  it("emits a Point flow with km/h speed from the inline WGS84 geometry", () => {
    const { flows, events } = parseTrafikverketFlow(payload, src);
    expect(flows.map((f) => f.id)).toEqual(["se-trafikverket-flow:TMS-1"]);
    expect(flows[0]!.geometry).toEqual({ type: "Point", coordinates: [18.06, 59.33] });
    expect(flows[0]!.speedKph).toBe(92);
    expect(flows[0]!.los).toBe("unknown");
    expect(events).toEqual([]);
  });

  it("skips records missing speed or geometry", () => {
    const { flows } = parseTrafikverketFlow(payload, src);
    expect(flows.some((f) => f.id === "se-trafikverket-flow:TMS-2")).toBe(false);
    expect(flows.some((f) => f.id === "se-trafikverket-flow:TMS-3")).toBe(false);
    expect(flows.some((f) => f.id === "se-trafikverket-flow:TMS-4")).toBe(false);
  });

  it("returns empty on malformed input", () => {
    expect(parseTrafikverketFlow("x", src)).toEqual({ flows: [], events: [] });
  });
});
