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

  it("reads a time without an offset in its publisher's zone, else as UTC", () => {
    expect(toIsoTimestamp("2026-07-14T09:34:00", "America/Toronto")).toBe(
      "2026-07-14T13:34:00.000Z",
    );
    expect(toIsoTimestamp("2026-10-11 03:53:30", "Asia/Bangkok")).toBe("2026-10-10T20:53:30.000Z");
    expect(toIsoTimestamp("2026-01-15T08:00:00.250", "Europe/Brussels")).toBe(
      "2026-01-15T07:00:00.250Z",
    );
    expect(toIsoTimestamp("2026/02/09 06:30:00", "America/Toronto")).toBe(
      "2026-02-09T11:30:00.000Z",
    );
    expect(toIsoTimestamp("2026/02/09", "America/Toronto")).toBe("2026-02-09T05:00:00.000Z");
    expect(toIsoTimestamp("2026-07-14T09:34")).toBe("2026-07-14T09:34:00.000Z");
    expect(toIsoTimestamp("2026-07-14")).toBe("2026-07-14T00:00:00.000Z");
    expect(toIsoTimestamp("2026/07/14")).toBe("2026-07-14T00:00:00.000Z");
    expect(toIsoTimestamp("2026-06-25T10:00:00Z", "Asia/Bangkok")).toBe("2026-06-25T10:00:00.000Z");
  });

  it("reads a time without an offset alike whatever the host's zone", () => {
    const host = process.env["TZ"];
    process.env["TZ"] = "Pacific/Auckland";
    try {
      expect(toIsoTimestamp("2026-07-14T09:34:00")).toBe("2026-07-14T09:34:00.000Z");
      expect(toIsoTimestamp("2026-07-14 09:34:00", "Europe/Berlin")).toBe(
        "2026-07-14T07:34:00.000Z",
      );
    } finally {
      if (host === undefined) delete process.env["TZ"];
      else process.env["TZ"] = host;
    }
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
