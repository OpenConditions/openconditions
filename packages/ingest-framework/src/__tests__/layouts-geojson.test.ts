import { describe, expect, test } from "vitest";
import { decodeLayout } from "../layouts/decode.js";

const fc = (features: unknown[], extra: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ type: "FeatureCollection", features, ...extra }));

describe("decodeLayout geojson", () => {
  test("geojson rows carry the properties and a point, also from a polygon", () => {
    const rows = decodeLayout(
      "geojson",
      fc([
        { geometry: { type: "Point", coordinates: [8.5, 47.3] }, properties: { id: "a" } },
        {
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [2, 0],
                [2, 2],
                [0, 2],
              ],
            ],
          },
          properties: { id: "b" },
        },
        {
          geometry: {
            type: "GeometryCollection",
            geometries: [
              {
                type: "LineString",
                coordinates: [
                  [0, 0],
                  [1, 1],
                ],
              },
              { type: "Point", coordinates: [3, 4] },
            ],
          },
          properties: { id: "c" },
        },
        { geometry: null, properties: { id: "d" } },
      ]),
      {},
    );
    expect(rows.map((r) => r.fields.id)).toEqual(["a", "b", "c", "d"]);
    expect(rows[0]!.point).toEqual([8.5, 47.3]);
    expect(rows[1]!.point).toEqual([1, 1]);
    expect(rows[2]!.point).toEqual([3, 4]);
    expect(rows[3]!.point).toBeUndefined();
  });

  test("geojson in a declared CRS is reprojected to WGS84", () => {
    const rows = decodeLayout(
      "geojson",
      fc([{ geometry: { type: "Point", coordinates: [1113194.9, 6446275.8] }, properties: {} }], {
        crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::3857" } },
      }),
      {},
    );
    expect(rows[0]!.point![0]).toBeCloseTo(10, 3);
    expect(rows[0]!.point![1]).toBeCloseTo(50, 2);
  });

  test("an explicit crs in the block reprojects when the document declares none", () => {
    const rows = decodeLayout(
      "geojson",
      fc([{ geometry: { type: "Point", coordinates: [1113194.9, 6446275.8] }, properties: {} }]),
      { crs: "EPSG:3857" },
    );
    expect(rows[0]!.point![0]).toBeCloseTo(10, 3);
  });

  test("lon and lat property paths override the geometry", () => {
    const rows = decodeLayout(
      "geojson",
      fc([{ geometry: null, properties: { pos: { x: "7,5", y: 46 } } }]),
      { lon: "pos.x", lat: "pos.y", decimalComma: true },
    );
    expect(rows[0]!.point).toEqual([7.5, 46]);
  });

  test("a body that is not JSON yields no rows", () => {
    expect(decodeLayout("geojson", Buffer.from("nope"), {})).toEqual([]);
  });
});
