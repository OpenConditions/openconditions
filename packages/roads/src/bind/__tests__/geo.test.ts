import { describe, expect, it } from "vitest";
import {
  bboxOf,
  bearingDeg,
  bearingDelta,
  densify,
  expandBbox,
  polylineLengthM,
  projectOntoPolyline,
} from "../geo.js";

describe("geo", () => {
  it("bearing east is 90, north is 0", () => {
    expect(bearingDeg([6.8, 51.2], [6.81, 51.2])).toBeCloseTo(90, 0);
    expect(bearingDeg([6.8, 51.2], [6.8, 51.21])).toBeCloseTo(0, 0);
  });
  it("bearingDelta wraps around 360", () => {
    expect(bearingDelta(350, 10)).toBe(20);
    expect(bearingDelta(90, 270)).toBe(180);
  });
  it("densify keeps endpoints and respects spacing", () => {
    const out = densify(
      [
        [6.8, 51.2],
        [6.82, 51.2],
      ],
      100
    ); // ~1.4 km
    expect(out[0]).toEqual([6.8, 51.2]);
    expect(out.at(-1)).toEqual([6.82, 51.2]);
    expect(out.length).toBeGreaterThan(12);
    expect(polylineLengthM(out)).toBeCloseTo(
      polylineLengthM([
        [6.8, 51.2],
        [6.82, 51.2],
      ]),
      -1
    );
  });
  it("projects a point onto the nearest sub-segment with fraction and offset", () => {
    const line: [number, number][] = [
      [6.8, 51.2],
      [6.81, 51.2],
      [6.82, 51.2],
    ];
    const pr = projectOntoPolyline([6.815, 51.2005], line);
    expect(pr.segmentIndex).toBe(1);
    expect(pr.fraction).toBeCloseTo(0.75, 2);
    expect(pr.offsetM).toBeCloseTo(55.6, 0);
    expect(pr.bearing).toBeCloseTo(90, 0);
  });
  it("expandBbox grows by metres, latitude-aware", () => {
    const b = expandBbox([6.8, 51.2, 6.81, 51.21], 1000);
    expect(b[1]).toBeCloseTo(51.2 - 0.009, 3);
    expect(b[0]).toBeLessThan(6.8 - 0.013);
  });

  it("bboxOf spans every vertex", () => {
    expect(
      bboxOf([
        [6.81, 51.2],
        [6.79, 51.23],
        [6.83, 51.19],
      ])
    ).toEqual([6.79, 51.19, 6.83, 51.23]);
  });

  it("projects onto a single-vertex polyline", () => {
    const pr = projectOntoPolyline([6.8, 51.2005], [[6.8, 51.2]]);
    expect(pr.point).toEqual([6.8, 51.2]);
    expect(pr.offsetM).toBeCloseTo(55.6, 0);
    expect(pr.fraction).toBe(0);
    expect(pr.segmentIndex).toBe(0);
  });

  it("rejects an empty polyline instead of returning a non-projection", () => {
    expect(() => projectOntoPolyline([6.8, 51.2], [])).toThrow(RangeError);
    expect(() => projectOntoPolyline([6.8, 51.2], [])).toThrow(
      "polyline must have at least one vertex"
    );
  });

  it("rejects a non-positive or NaN densify spacing", () => {
    const line: [number, number][] = [
      [6.8, 51.2],
      [6.82, 51.2],
    ];
    for (const spacing of [0, -25, Number.NaN]) {
      expect(() => densify(line, spacing)).toThrow(RangeError);
      expect(() => densify(line, spacing)).toThrow("maxSpacingM must be a positive number");
    }
  });

  it("clamps the projection to the polyline ends", () => {
    const line: [number, number][] = [
      [6.8, 51.2],
      [6.81, 51.2],
    ];
    const before = projectOntoPolyline([6.79, 51.2], line);
    expect(before.point).toEqual([6.8, 51.2]);
    expect(before.fraction).toBe(0);
    const after = projectOntoPolyline([6.82, 51.2], line);
    expect(after.point[0]).toBeCloseTo(6.81, 9);
    expect(after.fraction).toBeCloseTo(1, 9);
  });

  it("finds the true perpendicular foot on a diagonal segment", () => {
    // Longitude degrees are shorter than latitude degrees at this latitude, so
    // an unscaled planar projection lands at a visibly different fraction.
    const line: [number, number][] = [
      [6.8, 51.2],
      [6.81, 51.21],
    ];
    const pr = projectOntoPolyline([6.8125, 51.2025], line);
    expect(pr.fraction).toBeGreaterThan(0);
    expect(pr.fraction).toBeLessThan(1);
    expect(bearingDelta(bearingDeg(pr.point, [6.8125, 51.2025]), pr.bearing)).toBeCloseTo(90, 1);
  });
});
