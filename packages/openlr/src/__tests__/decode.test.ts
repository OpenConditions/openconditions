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

  // Binary v3 offsets are bucketed relative to the LRP length: the distance from
  // the first to the second LRP for the positive offset, and from the
  // second-last to the last LRP for the negative offset (OpenLR whitepaper
  // v1.5 rev2, section 7.5.2 and Equation 8). The vectors and expected metres
  // are ported from TomTom's reference implementation
  // (github.com/tomtom-international/openlr, binary/src/test/java/openlr/binary/
  // OpenLRBinaryDecoderTest.java, Copyright TomTom International B.V.,
  // Apache-2.0).
  it("measures the positive offset against the first LRP length (whitepaper 13.1 example)", () => {
    const loc = decodeOpenLrBinary("CwRbWyNG9RpsCQCb/jsbtAT/6/+jK1lE");
    expect(loc.points.map((p) => p.distanceToNext)).toEqual([557, 264, 0]);
    // Bucket 68 is 26.76 % of the 557 m LRP length (whitepaper section 13.1.5).
    expect(loc.positiveOffset).toBe(149);
    expect(loc.negativeOffset).toBe(0);
  });

  it("measures each offset against its own end of a three-LRP reference", () => {
    const loc = decodeOpenLrBinary("CwRbWyNG9RpsCQCa/jsbtAT/6/+kK3ldYQ==");
    expect(loc.points.map((p) => p.distanceToNext)).toEqual([557, 264, 0]);
    // Positive offset: bucket 93 of the 557 m head; negative offset: bucket 97
    // of the 264 m tail. Neither depends on the 821 m total.
    expect(loc.positiveOffset).toBe(203);
    expect(loc.negativeOffset).toBe(101);
  });

  it("throws on invalid base64 input", () => {
    expect(() => decodeOpenLrBinary("not-valid-openlr")).toThrow();
  });
});
