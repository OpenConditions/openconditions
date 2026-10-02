import type { GeoJsonGeometry } from "@openconditions/core";
import { describe, expect, it } from "vitest";
import { checkGeometryPlausibility } from "../plausibility.js";

const reasonsOf = (geometry: unknown) => checkGeometryPlausibility(geometry as GeoJsonGeometry);

describe("checkGeometryPlausibility over a report's geometry", () => {
  it("rejects a longitude or latitude out of WGS84 range", () => {
    expect(reasonsOf({ type: "Point", coordinates: [181, 52] })).toContain("geometry_out_of_range");
    expect(reasonsOf({ type: "Point", coordinates: [4, 91] })).toContain("geometry_out_of_range");
  });

  it("validates coordinates inside a nested geometry (LineString)", () => {
    expect(
      reasonsOf({
        type: "LineString",
        coordinates: [
          [4, 52],
          [4.1, 52.1],
        ],
      }),
    ).toEqual([]);
    expect(
      reasonsOf({
        type: "LineString",
        coordinates: [
          [4, 52],
          [200, 52.1],
        ],
      }),
    ).toContain("geometry_out_of_range");
  });

  it("rejects a LineString with a single position", () => {
    expect(reasonsOf({ type: "LineString", coordinates: [[4, 52]] })).toContain(
      "geometry_malformed",
    );
  });

  it("rejects an unclosed Polygon ring and one with fewer than 4 positions", () => {
    expect(
      reasonsOf({
        type: "Polygon",
        coordinates: [
          [
            [4, 52],
            [4.1, 52],
            [4.1, 52.1],
            [4, 52.1],
          ],
        ],
      }),
    ).toContain("geometry_malformed");
    expect(
      reasonsOf({
        type: "Polygon",
        coordinates: [
          [
            [4, 52],
            [4.1, 52],
            [4, 52],
          ],
        ],
      }),
    ).toContain("geometry_malformed");
  });

  it("rejects a GeometryCollection with a malformed member", () => {
    expect(
      reasonsOf({
        type: "GeometryCollection",
        geometries: [
          { type: "Point", coordinates: [4, 52] },
          { type: "LineString", coordinates: [[4, 52]] },
        ],
      }),
    ).toContain("geometry_malformed");
  });

  it("accepts a valid geometry of each type", () => {
    const closedRing = [
      [4, 52],
      [4.1, 52],
      [4.1, 52.1],
      [4, 52],
    ];
    const geometries = [
      { type: "Point", coordinates: [4, 52] },
      {
        type: "MultiPoint",
        coordinates: [
          [4, 52],
          [4.1, 52.1],
        ],
      },
      {
        type: "LineString",
        coordinates: [
          [4, 52],
          [4.1, 52.1],
        ],
      },
      {
        type: "MultiLineString",
        coordinates: [
          [
            [4, 52],
            [4.1, 52.1],
          ],
        ],
      },
      { type: "Polygon", coordinates: [closedRing] },
      { type: "MultiPolygon", coordinates: [[closedRing]] },
      { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [4, 52] }] },
    ];
    for (const geometry of geometries) {
      expect(reasonsOf(geometry), `expected ${geometry.type} to pass`).toEqual([]);
    }
  });
});

describe("checkGeometryPlausibility", () => {
  it("accepts a valid point inside nested geometry collections", () => {
    expect(
      checkGeometryPlausibility({
        type: "GeometryCollection",
        geometries: [
          { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [5, 52] }] },
        ],
      }),
    ).toEqual([]);
  });

  it("checks nested collection coordinates even when another member is valid", () => {
    expect(
      checkGeometryPlausibility({
        type: "GeometryCollection",
        geometries: [
          { type: "Point", coordinates: [5, 52] },
          { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [200, 52] }] },
        ],
      }),
    ).toContain("geometry_out_of_range");
  });

  it("returns no reasons for a valid Point", () => {
    expect(checkGeometryPlausibility({ type: "Point", coordinates: [4.9, 52.37] })).toEqual([]);
  });

  it("returns no reasons for a valid LineString without requireType", () => {
    expect(
      checkGeometryPlausibility({
        type: "LineString",
        coordinates: [
          [4, 52],
          [4.1, 52.1],
        ],
      }),
    ).toEqual([]);
  });

  it("flags an out-of-range coordinate", () => {
    expect(checkGeometryPlausibility({ type: "Point", coordinates: [181, 52] })).toContain(
      "geometry_out_of_range",
    );
  });

  it("flags a non-finite coordinate", () => {
    expect(checkGeometryPlausibility({ type: "Point", coordinates: [Number.NaN, 52] })).toContain(
      "geometry_not_finite",
    );
  });

  it("flags a malformed (nested) Point", () => {
    expect(
      checkGeometryPlausibility({ type: "Point", coordinates: [[4.9, 52.37]] } as never),
    ).toContain("geometry_malformed");
  });

  it("flags a 3-ordinate Point as malformed (v1 is 2D)", () => {
    expect(
      checkGeometryPlausibility({ type: "Point", coordinates: [4.9, 52.37, 12] } as never),
    ).toContain("geometry_malformed");
  });

  it("flags an empty geometry", () => {
    expect(checkGeometryPlausibility({ type: "LineString", coordinates: [] })).toContain(
      "geometry_empty",
    );
  });

  it("rejects a non-Point with geometry_not_point when requireType is Point", () => {
    expect(
      checkGeometryPlausibility(
        {
          type: "LineString",
          coordinates: [
            [4.9, 52.37],
            [4.91, 52.38],
          ],
        },
        { requireType: "Point" },
      ),
    ).toEqual(["geometry_not_point"]);
  });

  it("does not run the value scan when requireType rejects the type", () => {
    expect(
      checkGeometryPlausibility({ type: "LineString", coordinates: [] }, { requireType: "Point" }),
    ).toEqual(["geometry_not_point"]);
  });

  it("accepts a valid Point when requireType is Point", () => {
    expect(
      checkGeometryPlausibility(
        { type: "Point", coordinates: [4.9, 52.37] },
        { requireType: "Point" },
      ),
    ).toEqual([]);
  });

  it("still flags a malformed Point when requireType is Point", () => {
    expect(
      checkGeometryPlausibility(
        { type: "Point", coordinates: [999, 999] },
        { requireType: "Point" },
      ),
    ).toContain("geometry_out_of_range");
  });
});
