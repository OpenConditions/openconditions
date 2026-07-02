import { describe, expect, it } from "vitest";
import { parseNycDotFlow } from "../flow-nycdot.js";
import type { SourceDescriptor } from "../types.js";

const src = {
  id: "nyc-dot-speed-us",
  attribution: "NYC DOT",
  country: "US",
  license: "NYC-Open-Data",
} as SourceDescriptor;

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

describe("parseNycDotFlow", () => {
  it("emits a LineString flow with lon,lat order and mph→kph", () => {
    const { flows, events } = parseNycDotFlow(payload, src);
    expect(flows).toHaveLength(1);
    expect(flows[0]!.id).toBe("nyc-dot-speed-us:4616240");
    expect(flows[0]!.source).toBe("nyc-dot-speed-us");
    expect(flows[0]!.sourceFormat).toBe("nyc-dot-speed-json");
    expect(flows[0]!.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [-74.0, 40.7],
        [-74.01, 40.71],
        [-74.02, 40.72],
      ],
    });
    expect(flows[0]!.speedKph).toBeCloseTo(31.06 * 1.609344, 2);
    expect(flows[0]!.los).toBe("unknown");
    expect(flows[0]!.dataUpdatedAt).toBe("2026-03-04T14:30:00");
    expect(events).toEqual([]);
  });

  it("skips links with fewer than 2 points and malformed input", () => {
    expect(parseNycDotFlow("x", src)).toEqual({ flows: [], events: [] });
  });

  it("skips records with empty or missing speed", () => {
    const withEmptySpeed = JSON.stringify([
      {
        link_id: "111",
        speed: "",
        link_points: "40.7,-74.0 40.71,-74.01",
      },
      {
        link_id: "222",
        link_points: "40.7,-74.0 40.71,-74.01",
      },
    ]);
    expect(parseNycDotFlow(withEmptySpeed, src).flows).toHaveLength(0);
  });

  it("skips records with an empty or unparseable polyline", () => {
    const withBadPolyline = JSON.stringify([
      { link_id: "111", speed: "25", link_points: "" },
      { link_id: "222", speed: "25", link_points: "not-a-polyline" },
      { link_id: "333", speed: "25" },
    ]);
    expect(parseNycDotFlow(withBadPolyline, src).flows).toHaveLength(0);
  });

  it("returns empty flows when the payload is not an array", () => {
    expect(parseNycDotFlow(JSON.stringify({ foo: "bar" }), src)).toEqual({
      flows: [],
      events: [],
    });
  });
});
