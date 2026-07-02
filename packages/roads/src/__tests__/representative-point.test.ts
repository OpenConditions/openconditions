import { describe, expect, it } from "vitest";
import { representativePoint } from "../flow.js";

describe("representativePoint", () => {
  it("returns a Point's own coordinates", () => {
    expect(representativePoint({ type: "Point", coordinates: [24.9, 60.2] })).toEqual([24.9, 60.2]);
  });
  it("returns a LineString's middle vertex", () => {
    expect(
      representativePoint({
        type: "LineString",
        coordinates: [
          [0, 0],
          [10, 10],
          [20, 20],
        ],
      })
    ).toEqual([10, 10]);
  });
  it("returns the lower-middle vertex for an even-length LineString", () => {
    expect(
      representativePoint({
        type: "LineString",
        coordinates: [
          [0, 0],
          [2, 2],
        ],
      })
    ).toEqual([2, 2]);
  });
});
