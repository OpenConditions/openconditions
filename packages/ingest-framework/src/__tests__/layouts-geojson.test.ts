import { describe, expect, test } from "vitest";
import { decodeLayout } from "../layouts/decode.js";
import { reprojectGeometry } from "../layouts/geojson.js";

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
    // Only the polygon's point is computed; a point, also one out of a collection, is published.
    expect(rows.map((r) => r.pointDerived)).toEqual([undefined, true, undefined, undefined]);
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

  test("a feature without a point says whether it names a position", () => {
    const rows = decodeLayout(
      "geojson",
      fc([
        { geometry: null, properties: {} },
        { geometry: { type: "Point", coordinates: [500, 47] }, properties: {} },
      ]),
      {},
    );
    expect(rows.map((r) => r.unplaced)).toEqual(["no_geometry", "malformed"]);
  });

  test("a body that is not JSON yields no rows", () => {
    expect(decodeLayout("geojson", Buffer.from("nope"), {})).toEqual([]);
  });
});

describe("reprojectGeometry", () => {
  test("drops a WGS84 geometry's own crs member and keeps its coordinates", () => {
    const crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::4326" } };
    expect(
      reprojectGeometry({
        type: "LineString",
        coordinates: [
          [13.7, 51.05],
          [13.71, 51.05],
        ],
        crs,
      } as never),
    ).toEqual({
      type: "LineString",
      coordinates: [
        [13.7, 51.05],
        [13.71, 51.05],
      ],
    });
    expect(
      reprojectGeometry({
        type: "GeometryCollection",
        geometries: [{ type: "Point", coordinates: [13.7, 51.05], crs } as never],
      }),
    ).toEqual({
      type: "GeometryCollection",
      geometries: [{ type: "Point", coordinates: [13.7, 51.05] }],
    });
  });
});
