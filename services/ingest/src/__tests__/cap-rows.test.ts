import { describe, expect, it } from "vitest";
import { MAX_ROWS_PER_SOURCE, capRows } from "../pipeline/write-postgis.js";

describe("capRows", () => {
  it("returns the input unchanged when under the cap", () => {
    const rows = [1, 2, 3];
    expect(capRows(rows, 10)).toBe(rows);
  });

  it("truncates to the cap when exceeded", () => {
    const rows = Array.from({ length: 5 }, (_, i) => i);
    expect(capRows(rows, 2)).toEqual([0, 1]);
  });

  it("defaults to a large positive MAX_ROWS_PER_SOURCE", () => {
    expect(MAX_ROWS_PER_SOURCE).toBeGreaterThan(0);
    expect(capRows(Array.from({ length: 3 }, (_, i) => i))).toHaveLength(3);
  });
});
