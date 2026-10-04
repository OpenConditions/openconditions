import { describe, expect, it } from "vitest";
import { centroid, coarseCell, coarseCellCentre, gridCell, isoUtcEpochMs } from "../canonical.js";

describe("centroid", () => {
  it("averages all vertices of a MultiLineString", () => {
    expect(
      centroid({
        type: "MultiLineString",
        coordinates: [
          [
            [0, 0],
            [2, 0],
          ],
          [
            [4, 4],
            [6, 4],
          ],
        ],
      }),
    ).toEqual([3, 2]);
  });

  it("averages across a GeometryCollection", () => {
    expect(
      centroid({
        type: "GeometryCollection",
        geometries: [
          { type: "Point", coordinates: [0, 0] },
          {
            type: "LineString",
            coordinates: [
              [2, 2],
              [4, 4],
            ],
          },
        ],
      }),
    ).toEqual([2, 2]);
  });

  it("handles Polygon and MultiPolygon rings", () => {
    expect(
      centroid({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [2, 0],
            [2, 2],
            [0, 2],
          ],
        ],
      }),
    ).toEqual([1, 1]);
  });

  it("throws a TypeError on a geometry with no positions", () => {
    expect(() => centroid({ type: "GeometryCollection", geometries: [] })).toThrow(TypeError);
  });
});

describe("gridCell", () => {
  it("snaps to the equatorial-scaled grid", () => {
    expect(gridCell([6.5, 52.0], 100)).toBe("7235:57886");
  });

  it("throws a TypeError on non-finite coordinates", () => {
    expect(() => gridCell([Number.NaN, 52.0], 100)).toThrow(TypeError);
    expect(() => gridCell([6.5, Number.POSITIVE_INFINITY], 100)).toThrow(TypeError);
  });
});

describe("coarseCell", () => {
  it("is deterministic for the same coordinates", () => {
    expect(coarseCell(4.4961, 52.0)).toBe(coarseCell(4.4961, 52.0));
  });

  it("buckets two points ~100m apart into the same ~1km cell", () => {
    expect(coarseCell(4.4961, 52.0)).toBe(coarseCell(4.497, 52.0));
  });

  it("separates two points ~5km apart into different cells", () => {
    expect(coarseCell(4.4961, 52.0)).not.toBe(coarseCell(4.5411, 52.0));
    expect(coarseCell(4.4961, 52.0)).not.toBe(coarseCell(4.4961, 52.045));
  });

  it("defaults to the 1km grid and agrees with gridCell's quantization", () => {
    expect(coarseCell(6.5, 52.0)).toBe(coarseCell(6.5, 52.0, 1000));
    expect(coarseCell(6.5, 52.0, 100)).toBe(gridCell([6.5, 52.0], 100));
  });

  it("throws a TypeError on non-finite coordinates", () => {
    expect(() => coarseCell(Number.NaN, 52.0)).toThrow(TypeError);
    expect(() => coarseCell(6.5, Number.NEGATIVE_INFINITY)).toThrow(TypeError);
  });
});

describe("coarseCellCentre", () => {
  it("gives every point of a cell the same centre, inside that cell", () => {
    const centre = coarseCellCentre(4.4961, 52.0);
    expect(coarseCellCentre(4.497, 52.0)).toEqual(centre);
    expect(coarseCell(...centre)).toBe(coarseCell(4.4961, 52.0));
    expect(centre).not.toEqual([4.4961, 52.0]);
  });

  it("follows the cell size it is given", () => {
    const step = 100 / 111_320;
    const [lon, lat] = coarseCellCentre(6.5, 52.0, 100);
    expect(lon).toBeCloseTo((Math.floor(6.5 / step) + 0.5) * step, 12);
    expect(lat).toBeCloseTo((Math.floor(52.0 / step) + 0.5) * step, 12);
  });
});

describe("isoUtcEpochMs", () => {
  it("parses a zoned ISO timestamp", () => {
    expect(isoUtcEpochMs("2026-07-10T12:00:00Z")).toBe(Date.UTC(2026, 6, 10, 12));
  });

  it("parses offset-less timestamps as UTC regardless of host timezone", () => {
    // Force a non-UTC zone so this stays diagnostic on a UTC CI runner: Node
    // applies process.env.TZ to Date.parse immediately, so a regression that let
    // the legacy parser interpret the offset-less string in local time would make
    // the two values diverge here.
    const prevTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      expect(isoUtcEpochMs("2026-07-10T12:00:00")).toBe(isoUtcEpochMs("2026-07-10T12:00:00Z"));
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  });

  it("accepts a date-only ISO string (UTC midnight)", () => {
    expect(isoUtcEpochMs("2026-07-10")).toBe(isoUtcEpochMs("2026-07-10T00:00:00Z"));
  });

  it("rejects non-ISO-shaped date strings instead of falling through to the legacy parser", () => {
    expect(isoUtcEpochMs("07/10/2026")).toBeNaN();
    expect(isoUtcEpochMs("Fri Jul 10 2026")).toBeNaN();
    expect(isoUtcEpochMs("July 10, 2026")).toBeNaN();
  });

  it("respects explicit UTC offsets", () => {
    expect(isoUtcEpochMs("2026-07-10T14:00:00+02:00")).toBe(isoUtcEpochMs("2026-07-10T12:00:00Z"));
    expect(isoUtcEpochMs("2026-07-10T14:00:00+0200")).toBe(isoUtcEpochMs("2026-07-10T12:00:00Z"));
  });

  it("returns NaN for unparseable input", () => {
    expect(isoUtcEpochMs("not-a-date")).toBeNaN();
    expect(isoUtcEpochMs("2026-13-45T99:00:00Z")).toBeNaN();
  });
});
