import { describe, expect, it } from "vitest";
import {
  hasRestrictionEvidence,
  intersectRestrictionWindows,
  isPublishedRoadRestrictionDetails,
  isRoadRestrictionDetails,
  normalizeRestrictionDimension,
  parseRestrictionInstant,
  projectRoadRestrictionDetails,
  restrictionViewDeadline,
} from "../restrictions.js";
import type { RoadRestrictionFact } from "../restriction-types.js";
import { restrictionDetails } from "./fixtures/restriction-event.js";

describe("restriction evidence presence", () => {
  it("keeps an unsupported present envelope distinct from absence", () => {
    expect(hasRestrictionEvidence({})).toBe(false);
    expect(hasRestrictionEvidence({ restrictionDetails: undefined })).toBe(true);
    expect(hasRestrictionEvidence({ restrictionDetails: { schemaVersion: 9 } })).toBe(true);
    expect(hasRestrictionEvidence({ restrictionDetailsUnsupported: true })).toBe(true);
  });

  it("does not treat an explicitly false marker alone as evidence", () => {
    expect(hasRestrictionEvidence({ restrictionDetailsUnsupported: false })).toBe(false);
  });
});

describe("restriction envelope validation", () => {
  it("rejects invalid values and an empty apparently complete restriction", () => {
    const good = restrictionDetails();
    expect(isRoadRestrictionDetails(good)).toBe(true);
    for (const value of [0, -1, Infinity, NaN, "26000"]) {
      const bad = structuredClone(good);
      Object.assign(bad.facts[0]!, { value });
      expect(isRoadRestrictionDetails(bad)).toBe(false);
    }
    expect(isRoadRestrictionDetails({ ...good, facts: [] })).toBe(false);
  });

  it("rejects an unknown schema version rather than reading it as no restriction", () => {
    const details = restrictionDetails();
    expect(isRoadRestrictionDetails({ ...details, schemaVersion: 2 })).toBe(false);
    expect(isRoadRestrictionDetails({ ...details, schemaVersion: "1" })).toBe(false);
  });

  it("rejects a unit that does not match its dimension", () => {
    const kgAsMetres = restrictionDetails();
    Object.assign(kgAsMetres.facts[0]!, { unit: "m" });
    expect(isRoadRestrictionDetails(kgAsMetres)).toBe(false);

    const heightInKg = restrictionDetails();
    Object.assign(heightInKg.facts[0]!, { dimension: "height", value: 5.5, unit: "kg" });
    expect(isRoadRestrictionDetails(heightInKg)).toBe(false);

    const unknownUnit = restrictionDetails();
    Object.assign(unknownUnit.facts[0]!, { unit: "t" });
    expect(isRoadRestrictionDetails(unknownUnit)).toBe(false);
  });

  it("refuses to call a non-lte comparator a permitted maximum", () => {
    const details = restrictionDetails();
    Object.assign(details.facts[0]!, { operator: "gt" });
    expect(isRoadRestrictionDetails(details)).toBe(false);

    const predicate = restrictionDetails();
    Object.assign(predicate.facts[0]!, { operator: "gt", meaning: "event_applies_when" });
    expect(isRoadRestrictionDetails(predicate)).toBe(true);
  });

  it("rejects malformed direction, scope and binding claims", () => {
    for (const patch of [
      { direction: { basis: "guessed", value: "both", description: null } },
      { direction: { basis: "road_reference", value: "f", description: null } },
      { scope: { ...restrictionDetails().facts[0]!.scope, kind: "segment" } },
      {
        scope: { ...restrictionDetails().facts[0]!.scope, restrictionBinding: "exact" },
      },
    ]) {
      const details = restrictionDetails();
      Object.assign(details.facts[0]!, patch);
      expect(isRoadRestrictionDetails(details)).toBe(false);
    }
  });

  it("accepts a declared partial envelope with no facts and an issue", () => {
    const details = restrictionDetails();
    expect(
      isRoadRestrictionDetails({
        ...details,
        vehicleScope: "unknown",
        completeness: "partial",
        facts: [],
        issues: [
          {
            code: "unsupported_type",
            factId: null,
            sourcePath: "announcements[0].roadWorkPhases[0].restrictions[0]",
            sourceText: "tuntematon rajoitus",
          },
        ],
      })
    ).toBe(true);
  });

  it("accepts verified class and usage facts without numeric fields", () => {
    const details = restrictionDetails();
    const base = details.facts[0]!;
    const classFact = {
      id: "GUID1:event:event_road:announcements[0]",
      kind: "vehicle_class",
      meaning: "event_applies_when",
      value: "truck",
      scope: base.scope,
      direction: base.direction,
      validFrom: base.validFrom,
      validTo: base.validTo,
      sourceTokens: { sourcePath: "announcements[0]", vehicleType: "lorry" },
      context: base.context,
    } as unknown as RoadRestrictionFact;
    expect(isRoadRestrictionDetails({ ...details, facts: [classFact] })).toBe(true);

    const unverified = { ...classFact, value: "tractor" } as unknown as RoadRestrictionFact;
    expect(isRoadRestrictionDetails({ ...details, facts: [unverified] })).toBe(false);

    const numeric = { ...classFact, value: 7 } as unknown as RoadRestrictionFact;
    expect(isRoadRestrictionDetails({ ...details, facts: [numeric] })).toBe(false);
  });

  it("rejects duplicate fact ids and non-increasing windows", () => {
    const details = restrictionDetails();
    expect(
      isRoadRestrictionDetails({ ...details, facts: [details.facts[0]!, details.facts[0]!] })
    ).toBe(false);

    const reversed = restrictionDetails();
    Object.assign(reversed.facts[0]!, {
      validFrom: "2026-12-14T21:59:59.999Z",
      validTo: "2026-07-19T21:00:00.000Z",
    });
    expect(isRoadRestrictionDetails(reversed)).toBe(false);
  });

  it("rejects an issue code outside the closed set and unbounded source text", () => {
    const details = restrictionDetails();
    expect(
      isRoadRestrictionDetails({
        ...details,
        issues: [{ code: "made_up", factId: null, sourcePath: "x" }],
      })
    ).toBe(false);
    expect(
      isRoadRestrictionDetails({
        ...details,
        issues: [
          { code: "unsupported_type", factId: null, sourcePath: "x", sourceText: "a".repeat(4097) },
        ],
      })
    ).toBe(false);
  });

  it("rejects non-JSON and nonfinite source tokens", () => {
    for (const tokens of [
      { quantity: Number.POSITIVE_INFINITY },
      { when: new Date("2026-07-19T21:00:00Z") },
      { read: () => 1 },
    ]) {
      const details = restrictionDetails();
      Object.assign(details.facts[0]!, { sourceTokens: tokens });
      expect(isRoadRestrictionDetails(details)).toBe(false);
    }
  });

  it("requires trustworthy source rights on the envelope", () => {
    for (const patch of [
      { licenseUrl: "javascript:alert(1)" },
      { feedUrls: ["not-a-url"] },
      { attribution: "" },
      { sourceUpdatedAt: "2026-08-28T04:18:02" },
    ]) {
      const details = restrictionDetails();
      Object.assign(details.source, patch);
      expect(isRoadRestrictionDetails(details)).toBe(false);
    }
  });
});

describe("instant parsing", () => {
  it("requires an explicit zone and a real calendar date", () => {
    expect(parseRestrictionInstant("2026-07-19T21:00:00.000Z")).toBe(
      Date.parse("2026-07-19T21:00:00.000Z")
    );
    expect(parseRestrictionInstant("2026-07-19T23:00:00+02:00")).toBe(
      Date.parse("2026-07-19T21:00:00.000Z")
    );
    expect(parseRestrictionInstant("2026-02-30T00:00:00Z")).toBeNull();
    expect(parseRestrictionInstant("2026-07-19T21:00:00")).toBeNull();
    expect(parseRestrictionInstant("2026-07-19")).toBeNull();
    expect(parseRestrictionInstant(1_755_000_000_000)).toBeNull();
  });
});

describe("published envelope validation", () => {
  it("requires evaluation metadata and a per-fact state", () => {
    const details = restrictionDetails();
    const published = {
      ...details,
      facts: [{ ...details.facts[0]!, state: "active" }],
      evaluatedAt: "2026-09-12T07:14:00.000Z",
      sourceCheckedAt: "2026-09-12T07:13:00.000Z",
      freshUntil: "2026-09-12T07:23:00.000Z",
      nextTransitionAt: null,
      isStale: false,
    };
    expect(isPublishedRoadRestrictionDetails(published)).toBe(true);
    expect(isPublishedRoadRestrictionDetails(details)).toBe(false);
    expect(isPublishedRoadRestrictionDetails({ ...published, facts: [details.facts[0]!] })).toBe(
      false
    );
    expect(
      isPublishedRoadRestrictionDetails({
        ...published,
        facts: [{ ...details.facts[0]!, state: "expired" }],
      })
    ).toBe(false);
  });
});

describe("dimension normalization", () => {
  it("intersects phase dates and converts tonnes without changing meaning", () => {
    expect(
      normalizeRestrictionDimension({ dimension: "gross_weight", value: 26, unit: "t" })
    ).toEqual({ value: 26000, unit: "kg" });
    expect(
      intersectRestrictionWindows([
        { validFrom: "2026-06-11T21:00:00Z", validTo: "2026-12-14T21:59:59.999Z" },
        { validFrom: "2026-07-19T21:00:00Z", validTo: null },
      ]).window.validFrom
    ).toBe("2026-07-19T21:00:00.000Z");
  });

  it("refuses coercion, unknown units and nonpositive quantities", () => {
    expect(normalizeRestrictionDimension({ dimension: "height", value: 5.5, unit: "m" })).toEqual({
      value: 5.5,
      unit: "m",
    });
    expect(
      normalizeRestrictionDimension({ dimension: "gross_weight", value: 26000, unit: "kg" })
    ).toEqual({ value: 26000, unit: "kg" });
    for (const input of [
      { dimension: "height", value: "5.5", unit: "m" },
      { dimension: "height", value: 5.5, unit: "cm" },
      { dimension: "height", value: 0, unit: "m" },
      { dimension: "height", value: -1, unit: "m" },
      { dimension: "height", value: Infinity, unit: "m" },
      { dimension: "gross_weight", value: 26, unit: "lb" },
      { dimension: "gross_weight", value: 26, unit: "m" },
      { dimension: "width", value: 5, unit: "t" },
    ] as const) {
      expect(normalizeRestrictionDimension(input), JSON.stringify(input)).toBeNull();
    }
  });

  it("reports an invalid or empty window intersection instead of dropping bounds silently", () => {
    expect(intersectRestrictionWindows([])).toEqual({
      window: { validFrom: null, validTo: null },
    });
    expect(
      intersectRestrictionWindows([{ validFrom: "2026-07-19T21:00:00Z", validTo: null }])
    ).toEqual({ window: { validFrom: "2026-07-19T21:00:00.000Z", validTo: null } });
    expect(
      intersectRestrictionWindows([
        { validFrom: "2026-08-01T00:00:00Z", validTo: "2026-09-01T00:00:00Z" },
        { validFrom: "2026-09-02T00:00:00Z", validTo: "2026-10-01T00:00:00Z" },
      ])
    ).toEqual({ window: { validFrom: null, validTo: null }, issue: "invalid_window" });
    expect(
      intersectRestrictionWindows([{ validFrom: "2026-02-30T00:00:00Z", validTo: null }])
    ).toEqual({ window: { validFrom: null, validTo: null }, issue: "invalid_window" });
    expect(
      intersectRestrictionWindows([
        { validFrom: "2026-09-01T00:00:00Z", validTo: "2026-09-01T00:00:00Z" },
      ])
    ).toEqual({ window: { validFrom: null, validTo: null }, issue: "invalid_window" });
  });
});

describe("restriction publication projection", () => {
  const fresh = { sourceCheckedAt: "2026-09-12T19:59:00Z", freshnessWindowSec: 600 };

  it("does not lift a limit outside working hours", () => {
    const input = restrictionDetails();
    input.facts[0]!.context.workingHours = [
      {
        scheduleTimezone: "Europe/Helsinki",
        byDay: ["MO"],
        startTime: "06:00",
        endTime: "12:00",
        duration: "PT6H",
      },
    ];
    const view = projectRoadRestrictionDetails(input, {
      at: new Date("2026-09-12T20:00:00Z"),
      ...fresh,
    }).restrictionDetails!;
    expect(view.facts[0]!.state).toBe("active");
    expect(view.isStale).toBe(false);
    expect(view.freshUntil).toBe("2026-09-12T20:09:00.000Z");
    expect(input).not.toHaveProperty("evaluatedAt");
    expect(view.facts[0]!.context.workingHours).toEqual(input.facts[0]!.context.workingHours);
  });

  it("labels a fact scheduled before its start and ended at its end", () => {
    const input = restrictionDetails();
    const before = projectRoadRestrictionDetails(input, {
      at: new Date("2026-07-01T00:00:00Z"),
      sourceCheckedAt: "2026-07-01T00:00:00Z",
      freshnessWindowSec: 600,
    }).restrictionDetails!;
    expect(before.facts[0]!.state).toBe("scheduled");
    expect(before.nextTransitionAt).toBe("2026-07-19T21:00:00.000Z");

    const atEnd = projectRoadRestrictionDetails(input, {
      at: new Date("2026-12-14T21:59:59.999Z"),
      sourceCheckedAt: "2026-12-14T21:59:00Z",
      freshnessWindowSec: 600,
    }).restrictionDetails!;
    expect(atEnd.facts[0]!.state).toBe("ended");
    expect(atEnd.nextTransitionAt).toBeNull();
  });

  it("treats an open-ended known start as active and an unbounded fact as unknown", () => {
    const openEnded = restrictionDetails();
    openEnded.facts[0]!.validTo = null;
    expect(
      projectRoadRestrictionDetails(openEnded, {
        at: new Date("2026-09-12T20:00:00Z"),
        ...fresh,
      }).restrictionDetails!.facts[0]!.state
    ).toBe("active");

    const unbounded = restrictionDetails();
    openEnded.facts[0]!.validTo = null;
    unbounded.facts[0]!.validFrom = null;
    unbounded.facts[0]!.validTo = null;
    expect(
      projectRoadRestrictionDetails(unbounded, {
        at: new Date("2026-09-12T20:00:00Z"),
        ...fresh,
      }).restrictionDetails!.facts[0]!.state
    ).toBe("unknown");
  });

  it("keeps an invalid-window or unsupported-schedule fact temporally unknown", () => {
    const input = restrictionDetails();
    input.completeness = "partial";
    input.facts[0]!.validFrom = null;
    input.facts[0]!.validTo = null;
    input.issues = [
      {
        code: "invalid_window",
        factId: input.facts[0]!.id,
        sourcePath: "announcements[0].roadWorkPhases[1].timeAndDuration",
        sourceTokens: { startTime: "2026-13-01T00:00:00Z" },
      },
    ];
    expect(
      projectRoadRestrictionDetails(input, {
        at: new Date("2026-09-12T20:00:00Z"),
        ...fresh,
      }).restrictionDetails!.facts[0]!.state
    ).toBe("unknown");

    const unsupportedSchedule = restrictionDetails();
    unsupportedSchedule.completeness = "partial";
    unsupportedSchedule.issues = [
      {
        code: "unsupported_schedule",
        factId: unsupportedSchedule.facts[0]!.id,
        sourcePath: "announcements[0].roadWorkPhases[1].restrictions[2]",
      },
    ];
    expect(
      projectRoadRestrictionDetails(unsupportedSchedule, {
        at: new Date("2026-09-12T20:00:00Z"),
        ...fresh,
      }).restrictionDetails!.facts[0]!.state
    ).toBe("unknown");
  });

  it("applies a whole-record temporal issue to every fact", () => {
    const input = restrictionDetails();
    input.completeness = "partial";
    input.issues = [
      { code: "invalid_window", factId: null, sourcePath: "announcements[0].timeAndDuration" },
    ];
    expect(
      projectRoadRestrictionDetails(input, {
        at: new Date("2026-09-12T20:00:00Z"),
        ...fresh,
      }).restrictionDetails!.facts.every((f) => f.state === "unknown")
    ).toBe(true);
  });

  it("blocks an active label when the source status could not be interpreted", () => {
    const input = restrictionDetails();
    input.completeness = "partial";
    input.issues = [
      {
        code: "unsupported_status",
        factId: input.facts[0]!.id,
        sourcePath: "properties.validityStatus",
        sourceText: "suspended",
      },
    ];
    expect(
      projectRoadRestrictionDetails(input, {
        at: new Date("2026-09-12T20:00:00Z"),
        ...fresh,
      }).restrictionDetails!.facts[0]!.state
    ).toBe("unknown");
  });

  it("evaluates a represented recurrence and its exception across a Helsinki DST change", () => {
    const input = restrictionDetails();
    input.facts[0]!.schedule = [
      {
        scheduleTimezone: "Europe/Helsinki",
        repeatFrequency: "P1D",
        startTime: "22:00",
        endTime: "05:00",
        duration: "PT7H",
        exceptDate: ["2026-10-26"],
      },
    ];
    // 2026-10-25 03:00 Helsinki ends summer time; 23:30 local is then UTC+2.
    const inside = projectRoadRestrictionDetails(input, {
      at: new Date("2026-10-25T21:30:00Z"),
      sourceCheckedAt: "2026-10-25T21:29:00Z",
      freshnessWindowSec: 600,
    }).restrictionDetails!;
    expect(inside.facts[0]!.state).toBe("active");

    const excluded = projectRoadRestrictionDetails(input, {
      at: new Date("2026-10-26T21:30:00Z"),
      sourceCheckedAt: "2026-10-26T21:29:00Z",
      freshnessWindowSec: 600,
    }).restrictionDetails!;
    expect(excluded.facts[0]!.state).toBe("scheduled");
    expect(excluded.nextTransitionAt).not.toBeNull();
  });

  it("marks a view stale when freshness is unknown or elapsed", () => {
    const input = restrictionDetails();
    const at = new Date("2026-09-12T20:00:00Z");
    const missing = projectRoadRestrictionDetails(input, {
      at,
      sourceCheckedAt: null,
      freshnessWindowSec: 600,
    }).restrictionDetails!;
    expect(missing.freshUntil).toBeNull();
    expect(missing.isStale).toBe(true);

    const elapsed = projectRoadRestrictionDetails(input, {
      at,
      sourceCheckedAt: "2026-09-12T19:45:00Z",
      freshnessWindowSec: 600,
    }).restrictionDetails!;
    expect(elapsed.freshUntil).toBe("2026-09-12T19:55:00.000Z");
    expect(elapsed.isStale).toBe(true);
  });

  it("reports a malformed envelope as unsupported rather than as no restriction", () => {
    for (const value of [undefined, null, {}, { schemaVersion: 9 }, "details"]) {
      expect(
        projectRoadRestrictionDetails(value, {
          at: new Date("2026-09-12T20:00:00Z"),
          ...fresh,
        })
      ).toEqual({ restrictionDetailsUnsupported: true });
    }
  });

  it("preserves clipped issue text and its truncation marker", () => {
    const input = restrictionDetails();
    input.completeness = "partial";
    input.issues = [
      {
        code: "unsupported_type",
        factId: null,
        sourcePath: "announcements[0].roadWorkPhases[0].restrictions[3]",
        sourceText: "x".repeat(4096),
        truncated: true,
      },
    ];
    const view = projectRoadRestrictionDetails(input, {
      at: new Date("2026-09-12T20:00:00Z"),
      ...fresh,
    }).restrictionDetails!;
    expect(view.issues[0]!.truncated).toBe(true);
    expect(view.issues[0]!.sourceText).toHaveLength(4096);
  });
});

describe("restriction projection robustness", () => {
  it("reports an unusable evaluation instant as unsupported", () => {
    expect(
      projectRoadRestrictionDetails(restrictionDetails(), {
        at: new Date("not a date"),
        sourceCheckedAt: "2026-09-12T19:59:00Z",
        freshnessWindowSec: 600,
      })
    ).toEqual({ restrictionDetailsUnsupported: true });
  });
});

describe("restrictionViewDeadline", () => {
  const at = new Date("2026-09-12T07:14:00.000Z");

  function view(over: Record<string, unknown> = {}) {
    return {
      ...restrictionDetails(),
      facts: restrictionDetails().facts.map((fact) => ({ ...fact, state: "active" as const })),
      evaluatedAt: at.toISOString(),
      sourceCheckedAt: "2026-09-12T07:13:00.000Z",
      freshUntil: "2026-09-12T07:23:00.000Z",
      nextTransitionAt: null,
      isStale: false,
      ...over,
    } as Parameters<typeof restrictionViewDeadline>[0][number];
  }

  it("caps a distant deadline at one minute", () => {
    expect(restrictionViewDeadline([view()], at).toISOString()).toBe("2026-09-12T07:15:00.000Z");
  });

  it("shortens to an imminent freshness or transition deadline", () => {
    expect(
      restrictionViewDeadline([view({ freshUntil: "2026-09-12T07:14:20.000Z" })], at).toISOString()
    ).toBe("2026-09-12T07:14:20.000Z");
    expect(
      restrictionViewDeadline(
        [view({ nextTransitionAt: "2026-09-12T07:14:05.000Z" })],
        at
      ).toISOString()
    ).toBe("2026-09-12T07:14:05.000Z");
  });

  it("takes the earliest deadline across several views", () => {
    expect(
      restrictionViewDeadline(
        [view(), view({ nextTransitionAt: "2026-09-12T07:14:10.000Z" })],
        at
      ).toISOString()
    ).toBe("2026-09-12T07:14:10.000Z");
  });

  it("refuses to extend a cache for a stale, freshness-less or elapsed view", () => {
    for (const over of [
      { isStale: true },
      { freshUntil: null },
      { freshUntil: "2026-09-12T07:13:59.000Z" },
    ]) {
      expect(restrictionViewDeadline([view(over)], at).getTime(), JSON.stringify(over)).toBe(
        at.getTime()
      );
    }
  });

  it("returns the ceiling when there is nothing to evaluate", () => {
    expect(restrictionViewDeadline([], at).toISOString()).toBe("2026-09-12T07:15:00.000Z");
  });
});
