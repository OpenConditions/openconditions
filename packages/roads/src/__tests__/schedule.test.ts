import { describe, expect, it } from "vitest";
import {
  buildLocalSchedule,
  durationBetween,
  isoDayToICal,
  jsDayToICal,
  withTimezone,
} from "../schedule.js";

describe("durationBetween", () => {
  it("computes a same-day window", () => {
    expect(durationBetween("08:00", "17:00")).toBe("PT9H");
  });
  it("wraps an overnight window past midnight", () => {
    expect(durationBetween("20:00", "05:00")).toBe("PT9H");
  });
  it("handles hours+minutes", () => {
    expect(durationBetween("08:15", "09:45")).toBe("PT1H30M");
  });
  it("returns undefined when a time is missing/unparseable", () => {
    expect(durationBetween("08:00", undefined)).toBeUndefined();
    expect(durationBetween(undefined, "09:00")).toBeUndefined();
  });
});

describe("day conversions", () => {
  it("maps JS weekday (0=Sun..6=Sat) to iCal codes", () => {
    expect(jsDayToICal(0)).toBe("SU");
    expect(jsDayToICal(1)).toBe("MO");
    expect(jsDayToICal(6)).toBe("SA");
  });
  it("maps ISO weekday (1=Mon..7=Sun) to iCal codes", () => {
    expect(isoDayToICal(1)).toBe("MO");
    expect(isoDayToICal(7)).toBe("SU");
  });
});

describe("buildLocalSchedule", () => {
  it("builds a daily window with duration", () => {
    expect(
      buildLocalSchedule({ startDate: "2026-06-29", startTime: "20:00", endTime: "05:00" })
    ).toEqual({
      repeatFrequency: "P1D",
      startDate: "2026-06-29",
      startTime: "20:00",
      endTime: "05:00",
      duration: "PT9H",
    });
  });
  it("uses weekly frequency when day-of-week restricted", () => {
    const s = buildLocalSchedule({ startTime: "08:00", endTime: "17:00", byDay: ["MO", "WE"] });
    expect(s.repeatFrequency).toBe("P1W");
    expect(s.byDay).toEqual(["MO", "WE"]);
    expect(s.duration).toBe("PT9H");
  });
});

describe("withTimezone", () => {
  it("stamps the zone onto each schedule", () => {
    const out = withTimezone([{ repeatFrequency: "P1D", startTime: "20:00" }], "Europe/Berlin");
    expect(out).toEqual([
      { repeatFrequency: "P1D", startTime: "20:00", scheduleTimezone: "Europe/Berlin" },
    ]);
  });
  it("drops the schedule when the zone is unresolved (zone-less is ambiguous)", () => {
    expect(withTimezone([{ repeatFrequency: "P1D" }], null)).toBeUndefined();
    expect(withTimezone(undefined, "Europe/Berlin")).toBeUndefined();
    expect(withTimezone([], "Europe/Berlin")).toBeUndefined();
  });
});
