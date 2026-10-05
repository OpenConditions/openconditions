import { describe, expect, test } from "vitest";
import { decodeLayout } from "../layouts/decode.js";
import { getPath } from "../layouts/row.js";

const body = (doc: unknown) => Buffer.from(JSON.stringify(doc));

describe("decodeLayout json", () => {
  test("json rows read a nested [lat, lon] geometry", () => {
    const rows = decodeLayout(
      "json",
      body([{ addresses: [{ g: { type: "Point", coordinates: [41.4, 2.17] } }] }]),
      {
        geometryPath: "addresses.0.g",
        point: { field: "addresses.0.g.coordinates", order: "latlon" },
      },
    );
    expect(rows[0]!.point).toEqual([2.17, 41.4]);
  });

  test("json reads records at a path and lon/lat fields", () => {
    const rows = decodeLayout(
      "json",
      body({ data: { items: [{ id: 1, x: 8, y: 47 }, { id: 2 }] } }),
      {
        records: "data.items",
        lon: "x",
        lat: "y",
      },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ point: [8, 47], fields: { id: 1, x: 8, y: 47 } });
    expect(rows[1]!.point).toBeUndefined();
  });

  test("json reads a combined lat,lon string", () => {
    const rows = decodeLayout("json", body([{ pos: "47.5, 8.25" }]), {
      point: { field: "pos", order: "latlon" },
    });
    expect(rows[0]!.point).toEqual([8.25, 47.5]);
  });

  test("json takes a GeoJSON geometry at geometryPath", () => {
    const rows = decodeLayout(
      "json",
      body([
        {
          g: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [2, 4],
            ],
          },
        },
      ]),
      { geometryPath: "g" },
    );
    expect(rows[0]!.point).toEqual([1, 2]);
  });

  test("an out-of-range point is not placeable", () => {
    const rows = decodeLayout("json", body([{ x: 500, y: 47 }]), { lon: "x", lat: "y" });
    expect(rows[0]!.point).toBeUndefined();
  });

  test("getPath reads dotted paths with array indexes", () => {
    const doc = { a: { b: [{ c: 5 }, { c: 6 }] }, "x.y": 1 };
    expect(getPath(doc, "a.b.1.c")).toBe(6);
    expect(getPath(doc, "a.b.9.c")).toBeUndefined();
    expect(getPath(doc, "x.y")).toBe(1);
    expect(getPath(doc, "a.q.c")).toBeUndefined();
  });
});
