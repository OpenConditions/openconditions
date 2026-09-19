import { describe, expect, it } from "vitest";
import {
  effectStateAt,
  effectValidity,
  isRestrictionEvidence,
  routingBlockers,
} from "../kernel/effect-state.js";
import type { Effect } from "../kernel/effect-type.js";
import type { Validity } from "../kernel/validity.js";
import { closure } from "./fixtures.js";

const window: Validity = {
  status: "active",
  start: "2026-09-18T08:00:00Z",
  end: "2026-09-18T18:00:00Z",
};
const effect = (over: Partial<Effect> = {}) => ({ ...closure("R/closure"), ...over }) as Effect;
const at = (iso: string) => new Date(iso);

describe("effectStateAt", () => {
  it("evaluates the situation's window when the effect has none", () => {
    expect(effectValidity(effect(), window)).toBe(window);
    expect(effectStateAt(effect(), window, at("2026-09-18T07:00:00Z"))).toEqual({
      state: "scheduled",
      nextTransitionAt: "2026-09-18T08:00:00Z",
    });
    expect(effectStateAt(effect(), window, at("2026-09-18T12:00:00Z"))).toEqual({
      state: "active",
      nextTransitionAt: "2026-09-18T18:00:00.000Z",
    });
    expect(effectStateAt(effect(), window, at("2026-09-18T18:00:00Z"))).toEqual({
      state: "ended",
      nextTransitionAt: null,
    });
  });

  it("prefers the effect's own validity", () => {
    const own = effect({ validity: { status: "active", start: "2026-09-18T13:00:00Z" } });
    expect(effectStateAt(own, window, at("2026-09-18T12:00:00Z")).state).toBe("scheduled");
  });

  it("is active between periods only inside one", () => {
    const nightly: Validity = {
      status: "active",
      start: "2026-09-01T00:00:00Z",
      periods: [
        {
          scheduleTimezone: "Europe/Amsterdam",
          startTime: "22:00",
          endTime: "05:00",
          repeatFrequency: "P1D",
        },
      ],
    };
    expect(effectStateAt(effect(), nightly, at("2026-09-18T21:00:00Z"))).toEqual({
      state: "active",
      nextTransitionAt: "2026-09-19T03:00:00.000Z",
    });
    expect(effectStateAt(effect(), nightly, at("2026-09-18T12:00:00Z"))).toEqual({
      state: "scheduled",
      nextTransitionAt: "2026-09-18T20:00:00.000Z",
    });
  });

  it("is unknown when the parser could not read the window", () => {
    const unreadable = effect({
      normalization: "partial",
      issues: [{ code: "unsupported_schedule", sourcePath: "validity" }],
    });
    expect(effectStateAt(unreadable, window, at("2026-09-18T12:00:00Z"))).toEqual({
      state: "unknown",
      nextTransitionAt: null,
    });
  });
});

describe("routingBlockers", () => {
  it("lets a complete all-vehicle effect route", () => {
    expect(routingBlockers(effect())).toEqual([]);
    expect(isRestrictionEvidence(effect())).toBe(false);
  });

  it("withholds restriction evidence and non-routing operator actions", () => {
    const evidence = effect({ applicability: { kind: "unknown" }, normalization: "partial" });
    expect(routingBlockers(evidence)).toEqual(["applicability_unknown", "not_normalized"]);
    expect(isRestrictionEvidence(evidence)).toBe(true);
    expect(routingBlockers(effect({ actionStatus: "requested" }))).toEqual(["action_not_routable"]);
    expect(routingBlockers(effect({ actionStatus: "implemented" }))).toEqual([]);
  });
});
