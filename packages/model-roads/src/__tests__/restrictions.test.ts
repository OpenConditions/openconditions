import { describe, expect, it } from "vitest";
import type { RoadRestrictionFact } from "../restriction-types.js";
import {
  intersectRestrictionWindows,
  isRoadRestrictionDetails,
  normalizeRestrictionDimension,
  parseRestrictionInstant,
} from "../restrictions.js";
import { restrictionDetails } from "./fixtures/restriction-details.js";

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
      }),
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
      isRoadRestrictionDetails({ ...details, facts: [details.facts[0]!, details.facts[0]!] }),
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
      }),
    ).toBe(false);
    expect(
      isRoadRestrictionDetails({
        ...details,
        issues: [
          { code: "unsupported_type", factId: null, sourcePath: "x", sourceText: "a".repeat(4097) },
        ],
      }),
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
      Date.parse("2026-07-19T21:00:00.000Z"),
    );
    expect(parseRestrictionInstant("2026-07-19T23:00:00+02:00")).toBe(
      Date.parse("2026-07-19T21:00:00.000Z"),
    );
    expect(parseRestrictionInstant("2026-02-30T00:00:00Z")).toBeNull();
    expect(parseRestrictionInstant("2026-07-19T21:00:00")).toBeNull();
    expect(parseRestrictionInstant("2026-07-19")).toBeNull();
    expect(parseRestrictionInstant(1_755_000_000_000)).toBeNull();
  });
});

describe("dimension normalization", () => {
  it("intersects phase dates and converts tonnes without changing meaning", () => {
    expect(
      normalizeRestrictionDimension({ dimension: "gross_weight", value: 26, unit: "t" }),
    ).toEqual({ value: 26000, unit: "kg" });
    expect(
      intersectRestrictionWindows([
        { validFrom: "2026-06-11T21:00:00Z", validTo: "2026-12-14T21:59:59.999Z" },
        { validFrom: "2026-07-19T21:00:00Z", validTo: null },
      ]).window.validFrom,
    ).toBe("2026-07-19T21:00:00.000Z");
  });

  it("refuses coercion, unknown units and nonpositive quantities", () => {
    expect(normalizeRestrictionDimension({ dimension: "height", value: 5.5, unit: "m" })).toEqual({
      value: 5.5,
      unit: "m",
    });
    expect(
      normalizeRestrictionDimension({ dimension: "gross_weight", value: 26000, unit: "kg" }),
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
      intersectRestrictionWindows([{ validFrom: "2026-07-19T21:00:00Z", validTo: null }]),
    ).toEqual({ window: { validFrom: "2026-07-19T21:00:00.000Z", validTo: null } });
    expect(
      intersectRestrictionWindows([
        { validFrom: "2026-08-01T00:00:00Z", validTo: "2026-09-01T00:00:00Z" },
        { validFrom: "2026-09-02T00:00:00Z", validTo: "2026-10-01T00:00:00Z" },
      ]),
    ).toEqual({ window: { validFrom: null, validTo: null }, issue: "invalid_window" });
    expect(
      intersectRestrictionWindows([{ validFrom: "2026-02-30T00:00:00Z", validTo: null }]),
    ).toEqual({ window: { validFrom: null, validTo: null }, issue: "invalid_window" });
    expect(
      intersectRestrictionWindows([
        { validFrom: "2026-09-01T00:00:00Z", validTo: "2026-09-01T00:00:00Z" },
      ]),
    ).toEqual({ window: { validFrom: null, validTo: null }, issue: "invalid_window" });
  });
});
