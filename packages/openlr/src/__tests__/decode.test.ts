import { describe, expect, it } from "vitest";
import { decodeOpenLrBinary } from "../decode.js";

// Reference vector from the openlr-js README — Amsterdam canal ring (~Keizersgracht).
// Decoding is deterministic: same bytes always yield the same LRPs.
const AMSTERDAM_LINE = "CwNhbCU+jzPLAwD0/34zGw==";

describe("decodeOpenLrBinary", () => {
  it("returns a line location with two LRPs", () => {
    const loc = decodeOpenLrBinary(AMSTERDAM_LINE);
    expect(loc.type).toBe("line");
    expect(loc.points).toHaveLength(2);
  });

  it("first LRP has correct longitude and latitude", () => {
    const loc = decodeOpenLrBinary(AMSTERDAM_LINE);
    const [first] = loc.points;
    expect(first.longitude).toBeCloseTo(4.7539, 3);
    expect(first.latitude).toBeCloseTo(52.3749, 3);
  });

  it("first LRP has FRC 6 and FOW 3 (single carriageway)", () => {
    const loc = decodeOpenLrBinary(AMSTERDAM_LINE);
    const [first] = loc.points;
    expect(first.frc).toBe(6);
    expect(first.fow).toBe(3);
  });

  it("first LRP bearing is roughly south-east (~129°)", () => {
    const loc = decodeOpenLrBinary(AMSTERDAM_LINE);
    const [first] = loc.points;
    expect(first.bearing).toBeCloseTo(129.375, 2);
  });

  it("last LRP is marked isLast", () => {
    const loc = decodeOpenLrBinary(AMSTERDAM_LINE);
    const last = loc.points[loc.points.length - 1];
    expect(last.isLast).toBe(true);
  });

  it("offsets are zero for this reference", () => {
    const loc = decodeOpenLrBinary(AMSTERDAM_LINE);
    expect(loc.positiveOffset).toBe(0);
    expect(loc.negativeOffset).toBe(0);
  });

  it("throws on invalid base64 input", () => {
    expect(() => decodeOpenLrBinary("not-valid-openlr")).toThrow();
  });
});
