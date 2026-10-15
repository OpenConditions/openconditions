import { describe, expect, it } from "vitest";
import { clock, dayBefore, wallClock, zonedInstant } from "../time.js";

describe("zonedInstant", () => {
  it("reads a wall-clock time in the zone's offset of that day", () => {
    expect(zonedInstant("2026-10-14", "16:00", "America/Phoenix").toISOString()).toBe(
      "2026-10-14T23:00:00.000Z",
    );
    expect(zonedInstant("2026-12-14", "16:00", "America/Denver").toISOString()).toBe(
      "2026-12-14T23:00:00.000Z",
    );
    expect(zonedInstant("2026-10-14", "19:33:33", "America/New_York").toISOString()).toBe(
      "2026-10-14T23:33:33.000Z",
    );
  });

  it("reads the hour a zone repeats as its first pass, and either side of a change right", () => {
    expect(zonedInstant("2026-11-01", "01:30", "America/New_York").toISOString()).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    expect(zonedInstant("2026-11-01", "03:00", "America/New_York").toISOString()).toBe(
      "2026-11-01T08:00:00.000Z",
    );
    expect(zonedInstant("2026-03-08", "03:30", "America/Chicago").toISOString()).toBe(
      "2026-03-08T08:30:00.000Z",
    );
  });
});

describe("clock helpers", () => {
  it("turns a 12-hour time into 24 hours", () => {
    expect(clock(12, 0, "am")).toBe("00:00");
    expect(clock(12, 30, "pm")).toBe("12:30");
    expect(clock(9, 5, "pm")).toBe("21:05");
  });

  it("steps back a day across a month, and reads a zone's wall clock", () => {
    expect(dayBefore("2026-03-01")).toBe("2026-02-28");
    expect(wallClock(new Date("2026-10-14T23:38:05Z"), "America/Los_Angeles")).toEqual({
      date: "2026-10-14",
      time: "16:38:05",
    });
  });
});
