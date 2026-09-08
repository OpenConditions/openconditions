import { describe, expect, it } from "vitest";
import { normalizeRefs, refScore } from "../refs.js";

describe("normalizeRefs", () => {
  it("uppercases, strips spaces/hyphens and splits multi-refs", () => {
    expect(normalizeRefs(["A 46"])).toEqual(["A46"]);
    expect(normalizeRefs(["B 9;B 56", "a-3", null, ""])).toEqual(["B9", "B56", "A3"]);
  });
});

describe("refScore", () => {
  it("1 on match, 0.5 when either side lacks a ref, 0 on stated mismatch", () => {
    expect(refScore(["A46"], "A 46")).toBe(1);
    expect(refScore([], "A 46")).toBe(0.5);
    expect(refScore(["A46"], null)).toBe(0.5);
    expect(refScore(["A46"], "A 57")).toBe(0);
    expect(refScore(["A46"], "A 46;A 57")).toBe(1);
  });
});
