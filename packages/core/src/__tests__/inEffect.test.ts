import { describe, expect, it } from "vitest";
import { isInEffectAt } from "../inEffect.js";

const BERLIN = "Europe/Berlin";

describe("isInEffectAt", () => {
  it("treats an event with no temporal info as always in effect", () => {
    expect(isInEffectAt({}, new Date("2026-09-06T10:00:00Z"))).toBe(true);
  });

  it("uses validFrom/validTo when there is no schedule", () => {
    const ev = { validFrom: "2026-09-06T08:00:00Z", validTo: "2026-09-06T16:00:00Z" };
    expect(isInEffectAt(ev, new Date("2026-09-06T07:59:00Z"))).toBe(false);
    expect(isInEffectAt(ev, new Date("2026-09-06T12:00:00Z"))).toBe(true);
    expect(isInEffectAt(ev, new Date("2026-09-06T16:00:00Z"))).toBe(false);
    expect(isInEffectAt(ev, new Date("2026-09-06T16:01:00Z"))).toBe(false);
  });

  it("a schedule narrows the coarse window: nightly 20:00-05:00 local", () => {
    const ev = {
      validFrom: "2026-09-01T00:00:00Z",
      validTo: "2026-09-30T00:00:00Z",
      schedule: [
        {
          startTime: "20:00",
          duration: "PT9H",
          byDay: ["MO", "TU", "WE", "TH", "FR"],
          scheduleTimezone: BERLIN,
        },
      ],
    };
    // Tue 2026-09-08 12:00 Berlin (10:00Z) -> outside the nightly window
    expect(isInEffectAt(ev, new Date("2026-09-08T10:00:00Z"))).toBe(false);
    // Tue 22:00 Berlin (20:00Z) -> inside
    expect(isInEffectAt(ev, new Date("2026-09-08T20:00:00Z"))).toBe(true);
    // Wed 03:00 Berlin (01:00Z) -> still inside Tuesday's occurrence (overnight)
    expect(isInEffectAt(ev, new Date("2026-09-09T01:00:00Z"))).toBe(true);
    // Sat 22:00 Berlin -> byDay excludes SA
    expect(isInEffectAt(ev, new Date("2026-09-12T20:00:00Z"))).toBe(false);
  });

  it("a matching schedule occurrence does not revive an expired validity span", () => {
    const ev = {
      validFrom: "2026-09-01T00:00:00Z",
      validTo: "2026-09-30T00:00:00Z",
      schedule: [{ startTime: "20:00", duration: "PT9H", scheduleTimezone: BERLIN }],
    };
    // Inside a nightly occurrence, but eight months after the closure ended.
    expect(isInEffectAt(ev, new Date("2027-05-05T20:00:00Z"))).toBe(false);
  });

  it("a matching schedule occurrence does not start a closure before its validFrom", () => {
    const ev = {
      validFrom: "2027-01-01T00:00:00Z",
      schedule: [{ startTime: "20:00", duration: "PT9H", scheduleTimezone: BERLIN }],
    };
    expect(isInEffectAt(ev, new Date("2026-09-08T20:00:00Z"))).toBe(false);
    // Same time of day, once the span has started.
    expect(isInEffectAt(ev, new Date("2027-01-04T20:00:00Z"))).toBe(true);
  });

  it("is in effect only where the span and an occurrence overlap", () => {
    const ev = {
      validFrom: "2026-09-01T00:00:00Z",
      validTo: "2026-09-30T00:00:00Z",
      schedule: [{ startTime: "20:00", duration: "PT9H", scheduleTimezone: BERLIN }],
    };
    expect(isInEffectAt(ev, new Date("2026-09-08T20:00:00Z"))).toBe(true);
  });

  it("honours exceptDate and endTime fallback when duration is absent", () => {
    const ev = {
      schedule: [
        {
          startTime: "09:00",
          endTime: "11:00",
          exceptDate: ["2026-09-07"],
          scheduleTimezone: BERLIN,
        },
      ],
    };
    expect(isInEffectAt(ev, new Date("2026-09-08T08:00:00Z"))).toBe(true); // 10:00 Berlin
    expect(isInEffectAt(ev, new Date("2026-09-07T08:00:00Z"))).toBe(false); // excepted day
  });

  it("is DST-correct: 02:30 local on the spring-forward day resolves, not throws", () => {
    const ev = { schedule: [{ startTime: "02:30", duration: "PT1H", scheduleTimezone: BERLIN }] };
    expect(() => isInEffectAt(ev, new Date("2026-03-29T01:00:00Z"))).not.toThrow();
  });

  it("a zone-less schedule never suppresses", () => {
    const ev = { schedule: [{ startTime: "20:00", duration: "PT1H" } as never] };
    expect(isInEffectAt(ev, new Date("2026-09-08T10:00:00Z"))).toBe(true);
  });

  it.each([
    ["a plain wall clock", "20:00"],
    ["a UTC offset suffix", "20:00:00+02:00"],
    ["a Z suffix", "20:00:00Z"],
  ])("evaluates a nightly 20:00 window written with %s", (_label, startTime) => {
    // All three denote 20:00 local: a zone suffix is dropped rather than
    // applied, because a recurrence's time of day is local to its own
    // scheduleTimezone. Same expectations as the plain-wall-clock control.
    const ev = { schedule: [{ startTime, duration: "PT9H", scheduleTimezone: BERLIN }] };
    expect(isInEffectAt(ev, new Date("2026-09-08T10:00:00Z"))).toBe(false); // 12:00 Berlin
    expect(isInEffectAt(ev, new Date("2026-09-08T20:00:00Z"))).toBe(true); // 22:00 Berlin
    expect(isInEffectAt(ev, new Date("2026-09-09T01:00:00Z"))).toBe(true); // 03:00, overnight
  });

  it("zero-pads a 1-digit hour instead of failing closed", () => {
    const ev = { schedule: [{ startTime: "8:00", duration: "PT9H", scheduleTimezone: BERLIN }] };
    expect(isInEffectAt(ev, new Date("2026-09-08T10:00:00Z"))).toBe(true); // 12:00 Berlin
    expect(isInEffectAt(ev, new Date("2026-09-08T20:00:00Z"))).toBe(false); // 22:00 Berlin
  });

  it("an unparseable start time never suppresses", () => {
    const ev = { schedule: [{ startTime: "sunset", duration: "PT1H", scheduleTimezone: BERLIN }] };
    expect(isInEffectAt(ev, new Date("2026-09-08T10:00:00Z"))).toBe(true);
  });

  it("an unknown timezone never suppresses", () => {
    const ev = {
      schedule: [{ startTime: "20:00", duration: "PT1H", scheduleTimezone: "Nowhere/Atlantis" }],
    };
    expect(isInEffectAt(ev, new Date("2026-09-08T10:00:00Z"))).toBe(true);
  });
});
