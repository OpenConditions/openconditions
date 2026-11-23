import { describe, expect, it } from "vitest";
import { parseOverpassWays } from "../overpass.js";
import { parseOsmiumGeojsonSeq } from "../pbf-geojson.js";
import { segmentsForWay } from "../segment.js";

const coords = [
  [5, 52],
  [5.01, 52],
];
const parsers = [
  {
    name: "Overpass",
    parse: (tag: string | undefined) =>
      parseOverpassWays(
        JSON.stringify({
          elements: [
            {
              type: "way",
              id: 9,
              tags: { highway: "primary", oneway: tag },
              geometry: coords.map(([lon, lat]) => ({ lon, lat })),
            },
          ],
        }),
      ),
  },
  {
    name: "osmium GeoJSON",
    parse: (tag: string | undefined) =>
      parseOsmiumGeojsonSeq(
        JSON.stringify({
          type: "Feature",
          id: "w9",
          properties: { highway: "primary", oneway: tag },
          geometry: { type: "LineString", coordinates: coords },
        }),
      ),
  },
];

describe.each(parsers)("$name explicit one-way direction", ({ parse }) => {
  it.each([
    ["yes", ["f"]],
    ["true", ["f"]],
    ["1", ["f"]],
    ["-1", ["b"]],
    ["no", ["f", "b"]],
    ["false", ["f", "b"]],
    ["0", ["f", "b"]],
    [undefined, ["f", "b"]],
    ["reversible", ["f", "b"]],
  ] as const)("preserves source node order and handles oneway=%s", (tag, directions) => {
    const [way] = parse(tag as string | undefined);
    expect(way).toBeDefined();
    expect(way!.coords).toEqual(coords);
    expect(segmentsForWay(way!)).toEqual(directions);
    expect(way!.oneway).toBe(directions.length === 1);
    if (tag === "-1") expect(way!.onewayReversed).toBe(true);
    else expect(way).not.toHaveProperty("onewayReversed");
  });
});
