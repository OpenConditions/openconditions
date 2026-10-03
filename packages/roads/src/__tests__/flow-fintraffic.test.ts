import { describe, expect, it } from "vitest";
import type { FlowSites } from "../flow-output.js";
import { flowFeed, flows, readings, site, siteIds, value } from "./flow-fixtures.js";

const FEED = "fi-fintraffic";
const feed = flowFeed(FEED);
const sites: FlowSites = new Map([
  ["23001", { geometry: { type: "Point", coordinates: [24.9, 60.2] } }],
]);

const sensor = (stationId: number, name: string, value: number) => ({
  stationId,
  name,
  measuredTime: "2026-03-04T14:30:00Z",
  value,
});
const payload = JSON.stringify({
  dataUpdatedTime: "2026-03-04T14:30:00Z",
  stations: [
    {
      id: 23001,
      dataUpdatedTime: "2026-03-04T14:30:00Z",
      sensorValues: [
        sensor(23001, "KESKINOPEUS_5MIN_LIUKUVA_SUUNTA1", 95),
        sensor(23001, "KESKINOPEUS_5MIN_LIUKUVA_SUUNTA2", 42),
        sensor(23001, "OHITUKSET_60MIN_KIINTEA_SUUNTA1", 700),
      ],
    },
    {
      id: 999999,
      dataUpdatedTime: "2026-03-04T14:30:00Z",
      sensorValues: [sensor(999999, "KESKINOPEUS_5MIN_LIUKUVA_SUUNTA1", 80)],
    },
  ],
});

describe("Fintraffic TMS flow", () => {
  it("drafts a site per station direction with its five-minute average speed", () => {
    const out = flows(feed, payload, sites);
    expect(siteIds(out, FEED)).toEqual(["23001-1", "23001-2"]);
    expect(value(out, FEED, "23001-1", "traffic.speed")).toBe(95);
    expect(value(out, FEED, "23001-2", "traffic.speed")).toBe(42);
    expect((site(out, FEED, "23001-1")!["location"] as { geometry: unknown }).geometry).toEqual({
      type: "Point",
      coordinates: [24.9, 60.2],
    });
    // The level of service is left to enrichment.
    expect(readings(out, FEED, "23001-1", "traffic.los")).toEqual([]);
    expect(out.situations).toEqual([]);
  });

  it("ignores the fixed sixty-minute passings: a different period from the speed", () => {
    expect(readings(flows(feed, payload, sites), FEED, "23001-1", "traffic.volume")).toEqual([]);
  });

  it("skips stations with no geometry in the registry", () => {
    expect(siteIds(flows(feed, payload, sites), FEED).some((id) => id.startsWith("999999"))).toBe(
      false,
    );
  });

  it("drafts nothing for malformed input, absent sensor values or stations", () => {
    const empty = { features: [], observations: [], situations: [] };
    expect(flows(feed, "not json", sites)).toEqual(empty);
    expect(flows(feed, JSON.stringify({ stations: [{ id: 23001 }] }), sites)).toEqual(empty);
    expect(flows(feed, JSON.stringify({ dataUpdatedTime: "now" }), sites)).toEqual(empty);
  });
});
