import { describe, expect, it } from "vitest";
import { Validity } from "../kernel/validity.js";
import { isValidityInEffectAt } from "../schedule/in-effect.js";
import { Schedule } from "../schedule/schedule.js";

const nightly = { startTime: "20:00", duration: "PT9H", scheduleTimezone: "Europe/Berlin" };

describe("Schedule", () => {
  it("validates iCal days, ISO durations and IANA zones", () => {
    expect(Schedule.safeParse({ ...nightly, byDay: ["MO", "FR"] }).success).toBe(true);
    expect(Schedule.safeParse({ ...nightly, byDay: ["Monday"] }).success).toBe(false);
    expect(Schedule.safeParse({ ...nightly, duration: "9 hours" }).success).toBe(false);
    expect(Schedule.safeParse({ ...nightly, scheduleTimezone: "Nowhere/Atlantis" }).success).toBe(
      false,
    );
  });
});

describe("Validity", () => {
  it("rejects an end before the start", () => {
    expect(
      Validity.safeParse({
        status: "active",
        start: "2026-09-02T00:00:00Z",
        end: "2026-09-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("requires a zone designator on instants", () => {
    expect(Validity.safeParse({ status: "active", start: "2026-09-02T00:00:00" }).success).toBe(
      false,
    );
  });
});

describe("isValidityInEffectAt", () => {
  it("intersects the window with periods and removes exception occurrences", () => {
    const validity = {
      status: "active" as const,
      start: "2026-09-01T00:00:00Z",
      end: "2026-09-30T00:00:00Z",
      periods: [nightly],
      exceptions: [{ ...nightly, startDate: "2026-09-08", endDate: "2026-09-08" }],
    };
    expect(isValidityInEffectAt(validity, new Date("2026-09-07T20:00:00Z"))).toBe(true);
    expect(isValidityInEffectAt(validity, new Date("2026-09-08T20:00:00Z"))).toBe(false);
    expect(isValidityInEffectAt(validity, new Date("2026-09-08T10:00:00Z"))).toBe(false);
    expect(isValidityInEffectAt(validity, new Date("2026-10-01T20:00:00Z"))).toBe(false);
  });

  it("never lets an unevaluable exception suppress", () => {
    const validity = {
      status: "active" as const,
      exceptions: [{ ...nightly, startTime: "sunset" }],
    };
    expect(isValidityInEffectAt(validity, new Date("2026-09-08T20:00:00Z"))).toBe(true);
  });

  it("never reads status", () => {
    expect(isValidityInEffectAt({ status: "ended" }, new Date())).toBe(true);
  });
});
