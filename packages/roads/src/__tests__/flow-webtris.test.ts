import { describe, expect, it } from "vitest";
import { parseWebtrisFlow } from "../flow-webtris.js";
import { parseWebtrisSites } from "../stations-webtris.js";
import type { SourceDescriptor } from "../types.js";
import type { SiteGeometry } from "../siteTable.js";

const src = {
  id: "gb-webtris",
  attribution: "National Highways",
  country: "GB",
  license: "OGL-UK-3.0",
} as SourceDescriptor;

describe("parseWebtrisSites", () => {
  it("maps Id → Point from Longitude/Latitude", () => {
    const map = parseWebtrisSites(
      JSON.stringify({
        sites: [
          { Id: 5607, Name: "MIDAS 5607", Longitude: -1.5, Latitude: 52.4, Status: "Active" },
        ],
      })
    );
    expect(map.get("5607")).toEqual({ type: "Point", coordinates: [-1.5, 52.4] });
  });

  it("skips sites with missing id or non-numeric coordinates", () => {
    const map = parseWebtrisSites(
      JSON.stringify({
        sites: [
          { Longitude: -1.5, Latitude: 52.4 },
          { Id: 42, Longitude: "not-a-number", Latitude: 52.4 },
        ],
      })
    );
    expect(map.size).toBe(0);
  });

  it("returns an empty map on malformed input", () => {
    expect(parseWebtrisSites("not json").size).toBe(0);
  });
});

describe("parseWebtrisFlow", () => {
  const siteMap = new Map<string, SiteGeometry>([
    ["5607", { type: "Point", coordinates: [-1.5, 52.4] }],
  ]);
  const report = JSON.stringify({
    Rows: [
      {
        "Site Name": "5607",
        "Report Date": "2026-03-04T00:00:00",
        "Time Period Ending": "23:45:00",
        "Avg mph": "60",
        "Total Volume": "1200",
      },
      {
        "Site Name": "5607",
        "Report Date": "2026-03-04T00:00:00",
        "Time Period Ending": "23:59:00",
        "Avg mph": "30",
        "Total Volume": "1500",
      },
    ],
  });

  it("emits one flow per site from the latest row, mph to kph", () => {
    const { flows, events } = parseWebtrisFlow(report, src, siteMap);
    expect(flows).toHaveLength(1);
    expect(flows[0]!.id).toBe("gb-webtris:5607");
    expect(flows[0]!.speedKph).toBeCloseTo(30 * 1.609344, 3);
    expect(flows[0]!.los).toBe("unknown");
    expect(flows[0]!.geometry).toEqual({ type: "Point", coordinates: [-1.5, 52.4] });
    expect(flows[0]!.sourceFormat).toBe("webtris");
    expect(events).toEqual([]);
  });

  it("skips sites absent from the registry and malformed input", () => {
    expect(parseWebtrisFlow(report, src, new Map()).flows).toHaveLength(0);
    expect(parseWebtrisFlow("x", src, siteMap)).toEqual({ flows: [], events: [] });
  });

  it("returns empty flows when Rows is missing entirely", () => {
    expect(parseWebtrisFlow(JSON.stringify({ Header: [] }), src, siteMap)).toEqual({
      flows: [],
      events: [],
    });
  });

  it("skips rows with an empty or missing Avg mph value", () => {
    const withEmpty = JSON.stringify({
      Rows: [
        {
          "Site Name": "5607",
          "Report Date": "2026-03-04T00:00:00",
          "Time Period Ending": "23:45:00",
          "Avg mph": "",
          "Total Volume": "",
        },
        {
          "Site Name": "5607",
          "Report Date": "2026-03-04T00:00:00",
          "Time Period Ending": "23:59:00",
        },
      ],
    });
    expect(parseWebtrisFlow(withEmpty, src, siteMap).flows).toHaveLength(0);
  });
});
