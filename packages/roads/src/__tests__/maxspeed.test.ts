import { describe, expect, it } from "vitest";
import { parseMaxspeedKph } from "../maxspeed.js";

describe("parseMaxspeedKph", () => {
  it("parses a bare km/h number", () => {
    expect(parseMaxspeedKph("100")).toBe(100);
  });
  it("converts an 'N mph' value to km/h", () => {
    expect(parseMaxspeedKph("60 mph")).toBeCloseTo(96.56, 1);
  });
  it("ignores non-numeric zone values", () => {
    expect(parseMaxspeedKph("RO:urban")).toBeNull();
    expect(parseMaxspeedKph("none")).toBeNull();
    expect(parseMaxspeedKph("walk")).toBeNull();
  });
});
