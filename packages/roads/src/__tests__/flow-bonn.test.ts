import { describe, expect, it } from "vitest";
import { parseBonnFlow } from "../flow-bonn.js";
import type { SourceDescriptor } from "../types.js";

const src = {
  id: "de-bonn",
  attribution: "Bundesstadt Bonn",
  country: "DE",
  license: "dl-de/zero-2-0",
} as SourceDescriptor;

// Shapes mirror the live feed at stadtplan.bonn.de/geojson?Thema=19584.
const payload = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [7.1832, 50.6686],
            [7.1829, 50.6688],
            [7.1825, 50.6692],
          ],
        ],
      },
      properties: {
        strecke_id: 144,
        auswertezeit: "2026-07-10T17:10:00Z",
        geschwindigkeit: 12,
        verkehrsstatus: "stockender Verkehr",
      },
    },
    {
      type: "Feature",
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [7.177, 50.6727],
            [7.1773, 50.6725],
          ],
        ],
      },
      properties: {
        strecke_id: 143,
        auswertezeit: "2026-07-10T17:10:00Z",
        geschwindigkeit: 45,
        verkehrsstatus: "normales Verkehrsaufkommen",
      },
    },
  ],
});

describe("parseBonnFlow", () => {
  it("maps geschwindigkeit→speedKph and verkehrsstatus→los with lon,lat geometry", () => {
    const { flows, events } = parseBonnFlow(payload, src);
    expect(flows).toHaveLength(2);

    const congested = flows.find((f) => f.id === "de-bonn:144")!;
    expect(congested.sourceFormat).toBe("bonn");
    expect(congested.speedKph).toBe(12);
    expect(congested.los).toBe("queuing");
    expect(congested.geometry.type).toBe("LineString");
    expect(congested.dataUpdatedAt).toBe("2026-07-10T17:10:00Z");

    const free = flows.find((f) => f.id === "de-bonn:143")!;
    expect(free.los).toBe("free_flow");
    expect(free.speedKph).toBe(45);

    // Only the queuing section emits a derived congestion event.
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("de-bonn:144:congestion");
    expect(events[0]!.type).toBe("congestion");
  });

  it("splits a MultiLineString into one flow per member line", () => {
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
          properties: { strecke_id: 9, geschwindigkeit: 50, verkehrsstatus: "frei" },
        },
      ],
    });
    const { flows } = parseBonnFlow(multi, src);
    expect(flows.map((f) => f.id)).toEqual(["de-bonn:9:0", "de-bonn:9:1"]);
  });

  it("flags a hard parse failure (not a legitimately empty cycle)", () => {
    expect(parseBonnFlow("not json", src).failed).toBe(true);
    expect(parseBonnFlow(JSON.stringify({ type: "X" }), src).failed).toBe(true);
  });

  it("skips features with neither a speed nor a resolvable status", () => {
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
    expect(parseBonnFlow(noSignal, src).flows).toHaveLength(0);
  });
});
