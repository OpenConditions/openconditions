import { describe, expect, it } from "vitest";
import { flowFeed, flows, readings, site, siteIds, value } from "./flow-fixtures.js";

const FEED = "us-nyc-dot";
const feed = flowFeed(FEED);
const empty = { features: [], observations: [], situations: [] };

const payload = JSON.stringify([
  {
    link_id: "4616240",
    speed: "31.06",
    travel_time: "120",
    data_as_of: "2026-03-04T14:30:00",
    link_points: "40.7,-74.0 40.71,-74.01 40.72,-74.02",
  },
  { link_id: "bad", speed: "20", link_points: "40.7,-74.0" },
]);

describe("NYC DOT traffic speeds", () => {
  it("draws the link in lon,lat order and converts mph to km/h", () => {
    const out = flows(feed, payload);
    expect(siteIds(out, FEED)).toEqual(["4616240"]);
    expect((site(out, FEED, "4616240")!["location"] as { geometry: unknown }).geometry).toEqual({
      type: "LineString",
      coordinates: [
        [-74.0, 40.7],
        [-74.01, 40.71],
        [-74.02, 40.72],
      ],
    });
    expect(value(out, FEED, "4616240", "traffic.speed")).toBeCloseTo(31.06 * 1.609344, 2);
    expect(readings(out, FEED, "4616240", "traffic.los")).toEqual([]);
    // Socrata floating time is New York wall-clock time (EST).
    expect(readings(out, FEED, "4616240", "traffic.speed")[0]!["phenomenonTime"]).toEqual({
      instant: "2026-03-04T19:30:00.000Z",
    });
    expect(out.situations).toEqual([]);
  });

  it("drafts nothing for malformed input or a payload that is not an array", () => {
    expect(flows(feed, "x")).toEqual(empty);
    expect(flows(feed, JSON.stringify({ foo: "bar" }))).toEqual(empty);
  });

  it("skips records with empty or missing speed", () => {
    const withEmptySpeed = JSON.stringify([
      { link_id: "111", speed: "", link_points: "40.7,-74.0 40.71,-74.01" },
      { link_id: "222", link_points: "40.7,-74.0 40.71,-74.01" },
    ]);
    expect(flows(feed, withEmptySpeed)).toEqual(empty);
  });

  it("skips records with an empty or unparseable polyline", () => {
    const withBadPolyline = JSON.stringify([
      { link_id: "111", speed: "25", link_points: "" },
      { link_id: "222", speed: "25", link_points: "not-a-polyline" },
      { link_id: "333", speed: "25" },
    ]);
    expect(flows(feed, withBadPolyline)).toEqual(empty);
  });
});
