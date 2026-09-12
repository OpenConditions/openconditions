import { describe, expect, it } from "vitest";
import {
  hasRestrictionEvidence,
  isPublishedRoadRestrictionDetails,
  isRoadRestrictionDetails,
  parseRestrictionInstant,
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
