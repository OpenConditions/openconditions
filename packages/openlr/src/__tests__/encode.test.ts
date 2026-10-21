import { describe, expect, it } from "vitest";
import { decodeOpenLrBinary } from "../decode.js";
import { encodeOpenlrLine } from "../encode.js";

// A short motorway stretch through central Amsterdam, three vertices.
const MOTORWAY_LINE: [number, number][] = [
  [4.895, 52.37],
  [4.9, 52.371],
  [4.905, 52.372],
];

describe("encodeOpenlrLine", () => {
  it("round-trips coordinates within a few metres through the existing decoder", () => {
    const base64 = encodeOpenlrLine({ coords: MOTORWAY_LINE, frc: 0, fow: 1 });
    const decoded = decodeOpenLrBinary(base64);

    expect(decoded.type).toBe("line");
    expect(decoded.points).toHaveLength(2);

    // ~1e-5 deg longitude/latitude is well under a metre at this latitude.
    expect(decoded.points[0]!.longitude).toBeCloseTo(MOTORWAY_LINE[0]![0], 4);
    expect(decoded.points[0]!.latitude).toBeCloseTo(MOTORWAY_LINE[0]![1], 4);
    expect(decoded.points[1]!.longitude).toBeCloseTo(MOTORWAY_LINE[2]![0], 4);
    expect(decoded.points[1]!.latitude).toBeCloseTo(MOTORWAY_LINE[2]![1], 4);
  });

  it("preserves FRC and FOW through the round trip", () => {
    const base64 = encodeOpenlrLine({ coords: MOTORWAY_LINE, frc: 0, fow: 1 });
    const decoded = decodeOpenLrBinary(base64);

    for (const point of decoded.points) {
      expect(point.frc).toBe(0);
      expect(point.fow).toBe(1);
    }
  });

  // Whitepaper v1.5 rev 2, 5.2.4 and 5.4.2: an LRP's bearing points BEARDIST
  // (20 m) along the line its attributes describe. The last LRP describes the
  // line arriving at it, so its bearing points back the way the line came,
  // as TomTom's reference encoder computes it (AGAINST_DIRECTION).
  it("points the first LRP's bearing along the line and the last LRP's back along it", () => {
    // Due east, then due south into the end.
    const corner: [number, number][] = [
      [4.9, 52.37],
      [4.902, 52.37],
      [4.902, 52.368],
    ];
    const [first, last] = decodeOpenLrBinary(
      encodeOpenlrLine({ coords: corner, frc: 3, fow: 3 }),
    ).points;
    // Sectors of 11.25°, read back as their midpoints.
    expect(first!.bearing).toBe(84.375);
    expect(last!.bearing).toBe(5.625);
  });

  it("marks the last decoded LRP as last, first as not", () => {
    const base64 = encodeOpenlrLine({ coords: MOTORWAY_LINE, frc: 2, fow: 3 });
    const decoded = decodeOpenLrBinary(base64);

    expect(decoded.points[0]!.isLast).toBe(false);
    expect(decoded.points[1]!.isLast).toBe(true);
  });

  it("inserts an intermediate LRP when distance-to-next would exceed the 15 km cap", () => {
    // ~0.3 deg longitude at this latitude is roughly 20 km — over the cap.
    const longLine: [number, number][] = [
      [4.0, 52.0],
      [4.3, 52.0],
    ];
    const base64 = encodeOpenlrLine({ coords: longLine, frc: 0, fow: 1 });
    const decoded = decodeOpenLrBinary(base64);

    expect(decoded.points.length).toBeGreaterThan(2);
    for (const point of decoded.points) {
      if (!point.isLast) {
        expect(point.distanceToNext).toBeLessThanOrEqual(15_000);
      }
    }
  });

  it("throws on fewer than two coordinates", () => {
    expect(() => encodeOpenlrLine({ coords: [[4.9, 52.37]], frc: 0, fow: 1 })).toThrow();
  });
});
