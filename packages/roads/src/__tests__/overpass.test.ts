import { describe, expect, it } from "vitest";
import { parseOverpassWays } from "../overpass.js";

describe("parseOverpassWays", () => {
  it("parses a way's inline geometry, oneway and maxspeed", () => {
    const body = JSON.stringify({
      elements: [
        {
          type: "way",
          id: 5,
          tags: { highway: "motorway", oneway: "yes", ref: "A12", maxspeed: "100" },
          geometry: [
            { lat: 52.0, lon: 5.0 },
            { lat: 52.1, lon: 5.1 },
          ],
        },
      ],
    });
    const [w] = parseOverpassWays(body);
    expect(w).toMatchObject({
      wayId: 5,
      highway: "motorway",
      oneway: true,
      ref: "A12",
      maxspeedKph: 100,
    });
    expect(w.coords).toEqual([
      [5.0, 52.0],
      [5.1, 52.1],
    ]);
  });

  it("drops ways with <2 nodes and non-way elements", () => {
    expect(
      parseOverpassWays(
        JSON.stringify({
          elements: [
            { type: "node", id: 1 },
            { type: "way", id: 2, geometry: [{ lat: 1, lon: 1 }] },
          ],
        })
      )
    ).toEqual([]);
  });

  it("returns [] for unparseable input instead of throwing", () => {
    expect(parseOverpassWays("not json")).toEqual([]);
  });

  it("drops null/non-finite geometry nodes instead of crashing (large `out geom` quirk)", () => {
    const ways = parseOverpassWays(
      JSON.stringify({
        elements: [
          // A null node in the middle is dropped; two valid coords remain.
          {
            type: "way",
            id: 10,
            geometry: [{ lat: 1, lon: 1 }, null, { lat: 2, lon: 2 }],
            tags: { highway: "motorway" },
          },
          // Left with a single valid node → skipped like any short way.
          {
            type: "way",
            id: 11,
            geometry: [null, { lat: 3, lon: 3 }, { lat: null, lon: 4 }],
            tags: { highway: "primary" },
          },
        ],
      })
    );
    expect(ways).toEqual([
      {
        wayId: 10,
        coords: [
          [1, 1],
          [2, 2],
        ],
        highway: "motorway",
        oneway: false,
      },
    ]);
  });

  it("marks oneway=-1 as reversed", () => {
    const body = JSON.stringify({
      elements: [
        {
          type: "way",
          id: 9,
          tags: { highway: "primary", oneway: "-1" },
          geometry: [
            { lat: 1, lon: 1 },
            { lat: 2, lon: 2 },
          ],
        },
      ],
    });
    const [w] = parseOverpassWays(body);
    expect(w).toMatchObject({ wayId: 9, oneway: true, onewayReversed: true });
  });
});
