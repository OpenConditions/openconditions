import { describe, expect, it } from "vitest";
import { flowFeed, flows, readings, site, siteIds, value } from "./flow-fixtures.js";

const FEED = "sg-lta-speedbands";
const feed = flowFeed(FEED);

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

describe("LTA traffic speed bands", () => {
  it("draws the link Start→End and keeps the band-midpoint speed", () => {
    const out = flows(feed, payload);
    expect(siteIds(out, FEED)).toEqual(["103000000"]);
    expect(value(out, FEED, "103000000", "traffic.speed")).toBe(25); // (21 + 29) / 2
    expect(readings(out, FEED, "103000000", "traffic.los")).toEqual([]);
    expect((site(out, FEED, "103000000")!["location"] as { geometry: unknown }).geometry).toEqual({
      type: "LineString",
      coordinates: [
        [103.8515, 1.322],
        [103.853, 1.3225],
      ],
    });
  });

  it("refuses an unreadable body or one without a value array", () => {
    expect(() => flows(feed, "nope")).toThrow("hard parse failure");
    expect(() => flows(feed, JSON.stringify({}))).toThrow("hard parse failure");
  });
});
