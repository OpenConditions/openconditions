import { describe, expect, it } from "vitest";
import { parseOsmiumGeojsonSeq } from "../pbf-geojson.js";

const RS = "\x1e";
const feat = (obj: unknown) => RS + JSON.stringify(obj);

describe("parseOsmiumGeojsonSeq", () => {
  it("parses a way LineString (RS-prefixed) with tags, coords in [lon,lat]", () => {
    const body = feat({
      type: "Feature",
      id: "w100",
      geometry: {
        type: "LineString",
        coordinates: [
          [4.9, 52.36],
          [4.92, 52.37],
        ],
      },
      properties: { highway: "motorway", ref: "A1", name: "A1", maxspeed: "100" },
    });
    expect(parseOsmiumGeojsonSeq(body)).toEqual([
      {
        wayId: 100,
        coords: [
          [4.9, 52.36],
          [4.92, 52.37],
        ],
        highway: "motorway",
        oneway: false,
        ref: "A1",
        name: "A1",
        maxspeedKph: 100,
      },
    ]);
  });

  it("marks oneway=-1 as reversed and yes/true as oneway", () => {
    const body = [
      feat({
        type: "Feature",
        id: "w1",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
        properties: { highway: "trunk", oneway: "-1" },
      }),
      feat({
        type: "Feature",
        id: "w2",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
        properties: { highway: "primary", oneway: "yes" },
      }),
    ].join("\n");
    const ways = parseOsmiumGeojsonSeq(body);
    expect(ways[0]).toMatchObject({ wayId: 1, oneway: true, onewayReversed: true });
    expect(ways[1]).toMatchObject({ wayId: 2, oneway: true });
    expect(ways[1]).not.toHaveProperty("onewayReversed");
  });

  it("skips non-way ids, non-Feature, and unparseable lines without throwing", () => {
    const body = [
      feat({ type: "Feature", id: "n5", geometry: { type: "Point", coordinates: [0, 0] } }),
      feat({ type: "FeatureCollection", features: [] }),
      RS + "not json",
      "", // blank
      feat({
        type: "Feature",
        id: "w9",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
        properties: { highway: "primary" },
      }),
    ].join("\n");
    expect(parseOsmiumGeojsonSeq(body)).toEqual([
      {
        wayId: 9,
        coords: [
          [0, 0],
          [1, 1],
        ],
        highway: "primary",
        oneway: false,
      },
    ]);
  });

  it("drops null/non-finite coords and skips a way left with < 2 valid points", () => {
    const body = [
      feat({
        type: "Feature",
        id: "w10",
        geometry: { type: "LineString", coordinates: [[0, 0], null, [2, 2]] },
        properties: { highway: "motorway" },
      }),
      feat({
        type: "Feature",
        id: "w11",
        geometry: { type: "LineString", coordinates: [null, [3, 3]] },
        properties: { highway: "primary" },
      }),
    ].join("\n");
    expect(parseOsmiumGeojsonSeq(body)).toEqual([
      {
        wayId: 10,
        coords: [
          [0, 0],
          [2, 2],
        ],
        highway: "motorway",
        oneway: false,
      },
    ]);
  });

  it("tolerates lines without the RS byte", () => {
    const body = JSON.stringify({
      type: "Feature",
      id: "w7",
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
      properties: { highway: "trunk" },
    });
    expect(parseOsmiumGeojsonSeq(body)).toEqual([
      {
        wayId: 7,
        coords: [
          [0, 0],
          [1, 1],
        ],
        highway: "trunk",
        oneway: false,
      },
    ]);
  });
});
