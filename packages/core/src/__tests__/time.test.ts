import { describe, expect, it } from "vitest";
import { calendarDayOf, nextDay, sourceTimestamp, toIsoTimestamp, validityBound } from "../time.js";

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

  it("refuses a day the month does not have instead of rolling it into the next", () => {
    expect(toIsoTimestamp("2026-02-30T10:00:00Z")).toBeUndefined();
    expect(toIsoTimestamp("2026-04-31T00:00:00+02:00")).toBeUndefined();
    expect(toIsoTimestamp("2026-13-01T00:00:00Z")).toBeUndefined();
    expect(toIsoTimestamp("2026-02-29T00:00:00Z")).toBeUndefined();
    expect(toIsoTimestamp("2024-02-29T00:00:00Z")).toBe("2024-02-29T00:00:00.000Z");
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

  it("reads a dotted date day first, in its publisher's zone", () => {
    expect(toIsoTimestamp("04.05.2026", "Europe/Berlin")).toBe("2026-05-03T22:00:00.000Z");
    expect(toIsoTimestamp("13.04.2026")).toBe("2026-04-13T00:00:00.000Z");
    expect(toIsoTimestamp("1.11.2026 9:30", "Europe/Berlin")).toBe("2026-11-01T08:30:00.000Z");
    expect(toIsoTimestamp("27.10.2026, 23:59:59", "Europe/Berlin")).toBe(
      "2026-10-27T22:59:59.000Z",
    );
    expect(toIsoTimestamp("10.08.2026  16 Uhr", "Europe/Berlin")).toBe("2026-08-10T14:00:00.000Z");
    expect(toIsoTimestamp("10.08.2026 16:30 Uhr", "Europe/Berlin")).toBe(
      "2026-08-10T14:30:00.000Z",
    );
    expect(toIsoTimestamp("10.08.2026 16")).toBeUndefined();
    expect(toIsoTimestamp("31.04.2026")).toBeUndefined();
    expect(toIsoTimestamp("01.13.2026")).toBeUndefined();
    expect(toIsoTimestamp("01.05.2026 24:00")).toBeUndefined();
  });

  it("reads English dates, but no free text that only mentions a date", () => {
    expect(toIsoTimestamp("Thu, 29 Oct 2026 10:00:00 GMT")).toBe("2026-10-29T10:00:00.000Z");
    expect(toIsoTimestamp("October 29, 2026 10:00 UTC")).toBe("2026-10-29T10:00:00.000Z");
    for (const text of ["Ende Dez. 2026", "Ende Nov. 2026", "KW 46", "Mitte 2027", "Oct 2026"]) {
      expect(toIsoTimestamp(text), text).toBeUndefined();
    }
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

describe("validityBound", () => {
  const berlin = { timeZone: "Europe/Berlin" };

  it("reads a date alone as its whole day in the source's zone, the end running to the next midnight", () => {
    for (const day of ["2026-11-01", "2026-11-01Z", "2026/11/01", "01.11.2026", "1.11.2026"]) {
      expect(validityBound(day, "start", berlin), day).toBe("2026-10-31T23:00:00.000Z");
      expect(validityBound(day, "end", berlin), day).toBe("2026-11-01T23:00:00.000Z");
    }
    // Across the change to CET and the end of a year.
    expect(validityBound("2026-10-24", "end", berlin)).toBe("2026-10-24T22:00:00.000Z");
    expect(validityBound("31.12.2026", "end")).toBe("2027-01-01T00:00:00.000Z");
  });

  it("reads a value with a time of day as the instant it is", () => {
    expect(validityBound("2026-11-01T11:00:00Z", "end", berlin)).toBe("2026-11-01T11:00:00.000Z");
    expect(validityBound("01.11.2026 17:00", "end", berlin)).toBe("2026-11-01T16:00:00.000Z");
    expect(validityBound(Date.UTC(2026, 10, 1, 9), "start", berlin)).toBe(
      "2026-11-01T09:00:00.000Z",
    );
  });

  it("reads midnights as days only for a source that writes days so", () => {
    const midnight = "2026-10-30T00:00:00.000";
    const epoch = Date.UTC(2026, 9, 30);
    expect(validityBound(midnight, "end", berlin)).toBe("2026-10-29T23:00:00.000Z");
    expect(validityBound(epoch, "end", berlin)).toBe("2026-10-30T00:00:00.000Z");
    const days = { ...berlin, daysAtMidnight: true };
    expect(validityBound(midnight, "end", days)).toBe("2026-10-30T23:00:00.000Z");
    expect(validityBound(epoch, "end", days)).toBe("2026-10-30T23:00:00.000Z");
    expect(validityBound("30.10.2026 00:00", "start", days)).toBe("2026-10-29T23:00:00.000Z");
    expect(validityBound(epoch + 3_600_000, "end", days)).toBe("2026-10-30T01:00:00.000Z");
  });

  it("reads a source's local times marked UTC as the local times they are", () => {
    const marked = { ...berlin, localTimesMarkedUtc: true };
    expect(validityBound("2026-11-21T09:00:00Z", "start", marked)).toBe("2026-11-21T08:00:00.000Z");
    expect(validityBound("2026-10-05T07:00:00+00:00", "start", marked)).toBe(
      "2026-10-05T05:00:00.000Z",
    );
    expect(sourceTimestamp("2026-10-28T08:55:00Z", marked)).toBe("2026-10-28T07:55:00.000Z");
    expect(sourceTimestamp("2026-10-28T08:55:00+02:00", marked)).toBe("2026-10-28T06:55:00.000Z");
    expect(sourceTimestamp("2026-10-28T08:55:00Z", berlin)).toBe("2026-10-28T08:55:00.000Z");
  });

  it("refuses a day the month does not have", () => {
    expect(validityBound("2026-02-30", "end")).toBeUndefined();
    expect(validityBound("31.04.2026", "start")).toBeUndefined();
  });

  it("names the day a value is, or none", () => {
    expect(calendarDayOf("2026-11-01Z")).toBe("2026-11-01");
    expect(calendarDayOf("2026-11-01T00:00:00Z")).toBeUndefined();
    expect(calendarDayOf("2026-11-01T00:00:00Z", { daysAtMidnight: true })).toBe("2026-11-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
    expect(calendarDayOf("2026-11-01z")).toBe("2026-11-01");
    expect(calendarDayOf("2026/10/30 00:00", { daysAtMidnight: true })).toBe("2026-10-30");
    expect(calendarDayOf("30.10.2026 00:00 Uhr", { daysAtMidnight: true })).toBe("2026-10-30");
  });

  it("drops a UTC mark from a date alone too, under localTimesMarkedUtc", () => {
    const marked = { timeZone: "Europe/Berlin", localTimesMarkedUtc: true };
    expect(sourceTimestamp("2026-11-01Z", marked)).toBe("2026-10-31T23:00:00.000Z");
    expect(validityBound("2026-11-01Z", "start", marked)).toBe("2026-10-31T23:00:00.000Z");
  });
});
