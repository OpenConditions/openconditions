import { describe, expect, it } from "vitest";
import { flowFeed, flows, readings, site, value } from "./flow-fixtures.js";

const FEED = "de-nw-bonn";
const feed = flowFeed(FEED);

// Shapes mirror the live feed at stadtplan.bonn.de/geojson?Thema=19584.
const section = (id: number, speed: number, status: string, coordinates: number[][]) => ({
  type: "Feature",
  geometry: { type: "MultiLineString", coordinates: [coordinates] },
  properties: {
    strecke_id: id,
    auswertezeit: "2026-07-10T17:10:00Z",
    geschwindigkeit: speed,
    verkehrsstatus: status,
  },
});
const payload = JSON.stringify({
  type: "FeatureCollection",
  features: [
    section(144, 12, "stockender Verkehr", [
      [7.1832, 50.6686],
      [7.1829, 50.6688],
      [7.1825, 50.6692],
    ]),
    section(143, 45, "normales Verkehrsaufkommen", [
      [7.177, 50.6727],
      [7.1773, 50.6725],
    ]),
  ],
});

describe("Bonn traffic flow", () => {
  it("keeps the speed and the stated level of service of each section, on its line", () => {
    const out = flows(feed, payload);
    expect(value(out, FEED, "144", "traffic.speed")).toBe(12);
    expect(value(out, FEED, "144", "traffic.los")).toBe("queuing");
    expect(readings(out, FEED, "144", "traffic.speed")[0]!["phenomenonTime"]).toEqual({
      instant: "2026-07-10T17:10:00.000Z",
    });
    expect(
      (site(out, FEED, "144")!["location"] as { geometry: { type: string } }).geometry.type,
    ).toBe("LineString");
    expect(value(out, FEED, "143", "traffic.los")).toBe("free_flow");
    expect(value(out, FEED, "143", "traffic.speed")).toBe(45);
    // Only the queuing section derives a congestion situation.
    expect(out.situations.map((s) => s["id"])).toEqual([`oc:situation:${FEED}:144:congestion`]);
  });

  it("joins the member lines of a MultiLineString into one site, with a situation per line", () => {
    const multi = JSON.stringify({
      features: [
        {
          geometry: {
            type: "MultiLineString",
            coordinates: [
              [
                [7.1, 50.6],
                [7.2, 50.7],
              ],
              [
                [7.3, 50.8],
                [7.4, 50.9],
              ],
            ],
          },
          properties: { strecke_id: 9, geschwindigkeit: 5, verkehrsstatus: "Stau" },
        },
      ],
    });
    const out = flows(feed, multi);
    expect(out.features).toHaveLength(1);
    expect(
      (site(out, FEED, "9")!["location"] as { geometry: { type: string } }).geometry.type,
    ).toBe("MultiLineString");
    expect(out.situations.map((s) => s["id"])).toEqual([
      `oc:situation:${FEED}:9:0:congestion`,
      `oc:situation:${FEED}:9:1:congestion`,
    ]);
  });

  it("refuses an unreadable body or a non-collection as a hard parse failure", () => {
    expect(() => flows(feed, "not json")).toThrow("hard parse failure");
    expect(() => flows(feed, JSON.stringify({ type: "X" }))).toThrow("hard parse failure");
  });

  it("skips sections with neither a speed nor a resolvable status", () => {
    const noSignal = JSON.stringify({
      features: [
        {
          geometry: {
            type: "LineString",
            coordinates: [
              [7.1, 50.6],
              [7.2, 50.7],
            ],
          },
          properties: { strecke_id: 1, verkehrsstatus: "unbekannt" },
        },
      ],
    });
    expect(flows(feed, noSignal).features).toEqual([]);
  });
});
