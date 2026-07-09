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
