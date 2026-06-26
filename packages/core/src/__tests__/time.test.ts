import { describe, expect, it } from "vitest";
import { toIsoTimestamp } from "../time.js";

describe("toIsoTimestamp", () => {
  it("converts epoch seconds (the iPeloton/IBI511 shape) to ISO", () => {
    // 1757502000 is the value that crashed the on-511 batch insert as a raw
    // timestamptz; it is epoch seconds, not an ISO string.
    expect(toIsoTimestamp(1757502000)).toBe("2025-09-10T11:00:00.000Z");
  });

  it("converts a numeric epoch-seconds string to ISO", () => {
    expect(toIsoTimestamp("1757502000")).toBe("2025-09-10T11:00:00.000Z");
  });

  it("treats large epochs as milliseconds", () => {
    expect(toIsoTimestamp(1757502000000)).toBe("2025-09-10T11:00:00.000Z");
  });

  it("normalises ISO strings (Z and numeric offset) to UTC ISO", () => {
    expect(toIsoTimestamp("2026-06-25T10:00:00Z")).toBe("2026-06-25T10:00:00.000Z");
    expect(toIsoTimestamp("2026-06-26T13:54:00+0200")).toBe("2026-06-26T11:54:00.000Z");
  });

  it("passes through a Date", () => {
    expect(toIsoTimestamp(new Date("2026-06-25T10:00:00Z"))).toBe("2026-06-25T10:00:00.000Z");
  });

  it("returns undefined for null/undefined/empty/unparseable input", () => {
    expect(toIsoTimestamp(null)).toBeUndefined();
    expect(toIsoTimestamp(undefined)).toBeUndefined();
    expect(toIsoTimestamp("")).toBeUndefined();
    expect(toIsoTimestamp("   ")).toBeUndefined();
    expect(toIsoTimestamp("not a date")).toBeUndefined();
    expect(toIsoTimestamp(new Date("nope"))).toBeUndefined();
    expect(toIsoTimestamp({})).toBeUndefined();
    expect(toIsoTimestamp(Number.NaN)).toBeUndefined();
  });
});
