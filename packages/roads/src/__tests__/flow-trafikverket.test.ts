import { describe, expect, it } from "vitest";
import { flowFeed, flows, readings, site, siteIds, value } from "./flow-fixtures.js";

const FEED = "se-trafikverket-flow";
const feed = flowFeed(FEED);

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

describe("Trafikverket TrafficFlow", () => {
  it("places the site at the inline WGS84 point with its km/h speed and flow rate", () => {
    const out = flows(feed, payload);
    expect((site(out, FEED, "TMS-1")!["location"] as { geometry: unknown }).geometry).toEqual({
      type: "Point",
      coordinates: [18.06, 59.33],
    });
    expect(value(out, FEED, "TMS-1", "traffic.speed")).toBe(92);
    expect(value(out, FEED, "TMS-1", "traffic.volume")).toBe(800);
    expect(readings(out, FEED, "TMS-1", "traffic.los")).toEqual([]);
    expect(out.situations).toEqual([]);
  });

  it("skips records with neither a usable speed nor a flow rate, or without geometry", () => {
    expect(siteIds(flows(feed, payload), FEED)).toEqual(["TMS-1", "TMS-3"]);
  });

  it("drafts nothing for malformed input", () => {
    expect(flows(feed, "x")).toEqual({ features: [], observations: [], situations: [] });
  });
});
