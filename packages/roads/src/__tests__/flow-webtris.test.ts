import { describe, expect, it } from "vitest";
import type { FlowSites } from "../flow-output.js";
import { parseWebtrisSites } from "../stations-webtris.js";
import { flowFeed, flows, readings, siteIds, value } from "./flow-fixtures.js";

const FEED = "gb-webtris";
const feed = flowFeed(FEED, "webtris");

describe("parseWebtrisSites", () => {
  it("places each site by its Longitude/Latitude, with its name", () => {
    const sites = parseWebtrisSites(
      JSON.stringify({
        sites: [
          { Id: 5607, Name: "MIDAS 5607", Longitude: -1.5, Latitude: 52.4, Status: "Active" },
        ],
      }),
    );
    expect(sites.get("5607")).toEqual({
      geometry: { type: "Point", coordinates: [-1.5, 52.4] },
      name: "MIDAS 5607",
    });
  });

  it("skips sites with missing id or non-numeric coordinates", () => {
    const sites = parseWebtrisSites(
      JSON.stringify({
        sites: [
          { Longitude: -1.5, Latitude: 52.4 },
          { Id: 42, Longitude: "not-a-number", Latitude: 52.4 },
        ],
      }),
    );
    expect(sites.size).toBe(0);
  });

  it("returns no sites on malformed input", () => {
    expect(parseWebtrisSites("not json").size).toBe(0);
  });
});

describe("WebTRIS daily report", () => {
  const sites: FlowSites = new Map([
    ["5607", { geometry: { type: "Point", coordinates: [-1.5, 52.4] } }],
  ]);
  const row = (ending: string, mph?: string, volume?: string) => ({
    "Site Name": "5607",
    "Report Date": "2026-03-04T00:00:00",
    "Time Period Ending": ending,
    ...(mph !== undefined ? { "Avg mph": mph } : {}),
    ...(volume !== undefined ? { "Total Volume": volume } : {}),
  });
  const report = JSON.stringify({
    Rows: [row("23:45:00", "60", "1200"), row("23:59:00", "30", "1500")],
  });
  const empty = { features: [], observations: [], situations: [] };

  it("drafts one site from the latest row, mph to km/h, the level left to enrichment", () => {
    const out = flows(feed, report, sites);
    expect(siteIds(out, FEED)).toEqual(["5607"]);
    expect(value(out, FEED, "5607", "traffic.speed")).toBeCloseTo(30 * 1.609344, 3);
    expect(readings(out, FEED, "5607", "traffic.los")).toEqual([]);
    expect(out.situations).toEqual([]);
  });

  it("drafts nothing for sites absent from the registry, malformed input or no rows", () => {
    expect(flows(feed, report, new Map())).toEqual(empty);
    expect(flows(feed, "x", sites)).toEqual(empty);
    expect(flows(feed, JSON.stringify({ Header: [] }), sites)).toEqual(empty);
  });

  it("skips rows with neither a speed nor a volume", () => {
    const blank = JSON.stringify({ Rows: [row("23:45:00", "", ""), row("23:59:00")] });
    expect(flows(feed, blank, sites)).toEqual(empty);
  });
});
