import { describe, expect, it } from "vitest";
import { minZoomForHighway, segmentId, segmentsForWay } from "../segment.js";

describe("segment helpers", () => {
  it("ids, lod, directions", () => {
    expect(segmentId(42, "b")).toBe("42:b");
    expect(minZoomForHighway("motorway")).toBe(5);
    expect(minZoomForHighway("residential")).toBe(11);
    expect(segmentsForWay({ oneway: false })).toEqual(["f", "b"]);
    expect(segmentsForWay({ oneway: true })).toEqual(["f"]);
    expect(segmentsForWay({ oneway: true, onewayReversed: true })).toEqual(["b"]);
  });
});
