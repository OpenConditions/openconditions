import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDigitraffic, parseDigitrafficSnapshot } from "../digitraffic.js";
import { digitrafficRestrictionDetails } from "../digitraffic-restrictions.js";
import { isRoadRestrictionDetails } from "../restrictions.js";
import { reconcileRoadSnapshots } from "../snapshot.js";
import type { SourceDescriptor } from "../types.js";

/**
 * Source fixture: five real reduced roadworks records from the reviewed
 * 2026-09-12 Fintraffic capture. Its provenance and reductions are recorded in
 * the companion manifest. Variants below are constructed inline and explicitly
 * labelled synthetic; none of them claims to have appeared in the live feed.
 */
const raw = JSON.parse(
  readFileSync(new URL("./fixtures/digitraffic/v2-restrictions.json", import.meta.url), "utf8"),
) as { features: Array<{ properties: Record<string, unknown> }> };

const src: SourceDescriptor = {
  id: "fi-digitraffic",
  attribution: "Fintraffic / Digitraffic",
  country: "FI",
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
};

const FETCHED_AT = "2026-09-12T07:14:00.000Z";

function snapshot() {
  return reconcileRoadSnapshots([parseDigitrafficSnapshot(raw, src, { fetchedAt: FETCHED_AT })]);
}

function propsOf(situationId: string): Record<string, unknown> {
  const feature = raw.features.find((f) => f.properties["situationId"] === situationId);
  if (!feature) throw new Error(`fixture has no record ${situationId}`);
  return structuredClone(feature.properties);
}

describe("digitraffic v2 restriction extraction", () => {
  it("keeps the weight phase start and detour scope", () => {
    const out = snapshot();
    const weight = out.observations.find((e) => e.id === "fi-digitraffic:GUID50465935")!;
    expect(weight.type).toBe("roadworks");
    expect(weight.restrictionDetails?.facts[0]).toMatchObject({
      dimension: "gross_weight",
      value: 26000,
      unit: "kg",
      meaning: "maximum_permitted",
      operator: "lte",
      validFrom: "2026-07-19T21:00:00.000Z",
      scope: { phaseId: "GUID50469933", restrictionBinding: "not_established" },
    });
    const pair = out.observations.find((e) => e.id === "fi-digitraffic:GUID50461965")!
      .restrictionDetails!.facts;
    expect(pair.map((f) => f.scope.kind).sort()).toEqual(["detour", "roadwork_phase"]);
    expect(weight.schedule).toBeUndefined();
  });

  it("does not present the phase weight limit as starting at the event start", () => {
    const details = digitrafficRestrictionDetails(propsOf("GUID50465935"), src)!;
    expect(details.facts).toHaveLength(1);
    expect(details.facts[0]!.validFrom).toBe("2026-07-19T21:00:00.000Z");
    expect(details.facts[0]!.validTo).toBe("2026-12-14T21:59:59.999Z");
    expect(details.facts[0]!.sourceTokens["eventWindow"]).toEqual({
      validFrom: "2026-06-11T21:00:00.000Z",
      validTo: "2026-12-14T21:59:59.999Z",
    });
  });

  it("keeps identical main-road and detour weights as separate scoped facts", () => {
    const details = digitrafficRestrictionDetails(propsOf("GUID50461965"), src)!;
    const byScope = new Map(details.facts.map((f) => [f.scope.kind, f]));
    expect(byScope.get("roadwork_phase")).toMatchObject({
      dimension: "gross_weight",
      value: 75000,
      unit: "kg",
    });
    expect(byScope.get("detour")).toMatchObject({
      dimension: "gross_weight",
      value: 75000,
      unit: "kg",
      scope: { phaseId: "GUID50464686" },
    });
    expect(byScope.get("roadwork_phase")!.id).not.toBe(byScope.get("detour")!.id);
  });

  it("normalizes all five demonstrated mappings with their units", () => {
    const seen = new Set<string>();
    for (const id of [
      "GUID50470575",
      "GUID50468844",
      "GUID50466626",
      "GUID50465935",
      "GUID50461965",
    ]) {
      for (const fact of digitrafficRestrictionDetails(propsOf(id), src)?.facts ?? []) {
        if (fact.kind !== "dimension") continue;
        seen.add(`${fact.dimension}:${fact.scope.kind}:${fact.value}:${fact.unit}`);
      }
    }
    expect(seen).toContain("width:roadwork_phase:5:m");
    expect(seen).toContain("width:roadwork_phase:6:m");
    expect(seen).toContain("height:roadwork_phase:5.5:m");
    expect(seen).toContain("height:roadwork_phase:7:m");
    expect(seen).toContain("length:roadwork_phase:40:m");
    expect(seen).toContain("gross_weight:roadwork_phase:26000:kg");
    expect(seen).toContain("gross_weight:roadwork_phase:75000:kg");
    expect(seen).toContain("gross_weight:detour:75000:kg");
  });

  it("carries source direction and liftability as context, not as permission", () => {
    const width = digitrafficRestrictionDetails(propsOf("GUID50470575"), src)!;
    expect(width.facts[0]!.direction).toEqual({
      basis: "road_reference",
      value: "negative",
      description: "Naantali",
    });
    expect(width.facts[0]!.sourceTokens["direction"]).toBe("neg");
    expect(width.facts[0]!.context.restrictionsLiftable).toBe(false);

    const liftable = digitrafficRestrictionDetails(propsOf("GUID50468844"), src)!;
    expect(liftable.facts[0]!.context.restrictionsLiftable).toBe(true);
    expect(liftable.facts[0]!.context.compliance).toBe("unknown");
  });

  it("keeps working hours as phase-bounded display context only", () => {
    const details = digitrafficRestrictionDetails(propsOf("GUID50461965"), src)!;
    const fact = details.facts.find((f) => f.scope.kind === "roadwork_phase")!;
    expect(fact.schedule).toBeUndefined();
    expect(fact.context.workingHours).toEqual([
      {
        scheduleTimezone: "Europe/Helsinki",
        startDate: "2025-12-29",
        endDate: "2026-11-30",
        startTime: "06:00",
        endTime: "12:00",
        duration: "PT6H",
        byDay: ["MO", "TU", "WE", "TH", "FR"],
        repeatFrequency: "P1W",
      },
    ]);
  });

  it("preserves phase location identity and references without a graph binding", () => {
    const details = digitrafficRestrictionDetails(propsOf("GUID50465935"), src)!;
    const fact = details.facts[0]!;
    expect(fact.scope.sourceLocationRefs).toEqual({
      scheme: "digitraffic_road_address",
      road: 104,
      roadSection: 1,
      primaryDistance: 1971,
      secondaryDistance: 2160,
      openlr: "IzWZ1wFPPg==",
    });
    expect(fact.scope.locationDescription).toContain("Paikasta Pohja");
    expect(fact.scope.restrictionBinding).toBe("not_established");
  });

  it("carries source rights and record provenance on every envelope", () => {
    const details = digitrafficRestrictionDetails(propsOf("GUID50465935"), src)!;
    expect(details.source).toMatchObject({
      sourceId: "fi-digitraffic",
      recordId: "GUID50465935",
      recordVersion: "31",
      sourceUpdatedAt: "2026-08-28T04:18:02.629Z",
      publisher: "Fintraffic / Digitraffic",
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      modificationNotice:
        "Normalized by OpenConditions; source units and structure may be transformed.",
    });
    expect(isRoadRestrictionDetails(details)).toBe(true);
  });

  it("leaves speed, signalling, lane and detour context out of the envelope", () => {
    const details = digitrafficRestrictionDetails(propsOf("GUID50461965"), src)!;
    expect(details.completeness).toBe("complete");
    expect(details.issues).toEqual([]);
    expect(details.facts.every((f) => f.kind === "dimension")).toBe(true);
    // Twelve source restrictions, two of which are vehicle-scoped.
    expect(details.facts).toHaveLength(2);
  });

  it("makes no restriction claim for a record with no vehicle restriction", () => {
    const props = propsOf("GUID50465935");
    const announcement = (props["announcements"] as Array<Record<string, unknown>>)[0]!;
    const phases = announcement["roadWorkPhases"] as Array<Record<string, unknown>>;
    // Synthetic: keep only the first phase, which carries no vehicle limit.
    announcement["roadWorkPhases"] = [phases[0]!];
    expect(digitrafficRestrictionDetails(props, src)).toBeUndefined();
  });
});

describe("digitraffic v2 restriction edge cases", () => {
  function withRestriction(
    entry: unknown,
    patchPhase: Record<string, unknown> = {},
  ): Record<string, unknown> {
    // Synthetic envelope built around the real GUID50470575 record.
    const props = propsOf("GUID50470575");
    const announcement = (props["announcements"] as Array<Record<string, unknown>>)[0]!;
    const phase = (announcement["roadWorkPhases"] as Array<Record<string, unknown>>)[0]!;
    phase["restrictions"] = [entry];
    Object.assign(phase, patchPhase);
    return props;
  }

  it("intersects a restriction's own window with the phase window", () => {
    const details = digitrafficRestrictionDetails(
      withRestriction({
        type: "vehicle width limit",
        restriction: {
          name: "Ajoneuvon maksimileveys",
          quantity: 5,
          unit: "m",
          timeAndDuration: {
            startTime: "2026-09-12T21:00:00.000Z",
            endTime: "2026-09-30T20:59:59.999Z",
          },
        },
      }),
      src,
    )!;
    expect(details.facts[0]!.validFrom).toBe("2026-09-12T21:00:00.000Z");
    expect(details.facts[0]!.validTo).toBe("2026-09-18T20:59:59.999Z");
  });

  it("keeps a fact with an impossible window temporally unknown and partial", () => {
    const details = digitrafficRestrictionDetails(
      withRestriction({
        type: "vehicle width limit",
        restriction: {
          name: "Ajoneuvon maksimileveys",
          quantity: 5,
          unit: "m",
          timeAndDuration: { startTime: "2027-01-01T00:00:00.000Z", endTime: null },
        },
      }),
      src,
    )!;
    expect(details.completeness).toBe("partial");
    expect(details.facts[0]!.validFrom).toBeNull();
    expect(details.facts[0]!.validTo).toBeNull();
    expect(details.issues[0]).toMatchObject({ code: "invalid_window" });
    expect(isRoadRestrictionDetails(details)).toBe(true);
  });

  it("reports a malformed phase timestamp instead of publishing a bare limit", () => {
    const details = digitrafficRestrictionDetails(
      withRestriction(
        { type: "vehicle height limit", restriction: { quantity: 4, unit: "m" } },
        { timeAndDuration: { startTime: "2026-13-45T00:00:00Z", endTime: null } },
      ),
      src,
    )!;
    expect(details.issues.map((i) => i.code)).toContain("invalid_window");
    expect(details.facts[0]!.validFrom).toBeNull();
  });

  it("reports an unsupported unit and an absent quantity", () => {
    const badUnit = digitrafficRestrictionDetails(
      withRestriction({ type: "vehicle height limit", restriction: { quantity: 550, unit: "cm" } }),
      src,
    )!;
    expect(badUnit.facts).toEqual([]);
    expect(badUnit.vehicleScope).toBe("unknown");
    expect(badUnit.completeness).toBe("partial");
    expect(badUnit.issues[0]).toMatchObject({ code: "unsupported_unit" });
    expect(isRoadRestrictionDetails(badUnit)).toBe(true);

    const noQuantity = digitrafficRestrictionDetails(
      withRestriction({ type: "vehicle height limit", restriction: { name: "Korkeus" } }),
      src,
    )!;
    expect(noQuantity.issues[0]).toMatchObject({ code: "invalid_value" });
  });

  it("rejects a nonpositive or non-numeric quantity", () => {
    for (const quantity of [0, -5, "5.5", null]) {
      const details = digitrafficRestrictionDetails(
        withRestriction({
          type: "vehicle width limit",
          restriction: { quantity, unit: "m" },
        }),
        src,
      )!;
      expect(details.facts, String(quantity)).toEqual([]);
      expect(details.issues.length).toBeGreaterThan(0);
    }
  });

  it("reports an unknown vehicle-scoped restriction without guessing its meaning", () => {
    const details = digitrafficRestrictionDetails(
      withRestriction({
        type: "vehicle axle weight limit",
        restriction: { name: "Akselipaino", quantity: 10, unit: "t" },
      }),
      src,
    )!;
    expect(details.facts).toEqual([]);
    expect(details.issues[0]).toMatchObject({
      code: "unsupported_type",
      sourceText: "vehicle axle weight limit",
    });
  });

  it("recognizes the v1 uppercase vocabulary as well as v2", () => {
    const v1 = digitrafficRestrictionDetails(
      withRestriction({
        type: "VEHICLE_GROSS_WEIGHT_LIMIT",
        restriction: { quantity: 26, unit: "t" },
      }),
      src,
    )!;
    expect(v1.facts[0]).toMatchObject({ dimension: "gross_weight", value: 26000, unit: "kg" });
  });

  it("prefers the phase location and direction over the event's", () => {
    const props = propsOf("GUID50470575");
    const announcement = (props["announcements"] as Array<Record<string, unknown>>)[0]!;
    const phase = (announcement["roadWorkPhases"] as Array<Record<string, unknown>>)[0]!;
    // Synthetic: give the phase its own direction, differing from the event's.
    (phase["locationDetails"] as Record<string, unknown>)["roadAddressLocation"] = {
      ...((phase["locationDetails"] as Record<string, Record<string, unknown>>)[
        "roadAddressLocation"
      ] as Record<string, unknown>),
      direction: "pos",
      directionDescription: "Kausela",
    };
    const details = digitrafficRestrictionDetails(props, src)!;
    expect(details.facts[0]!.direction).toEqual({
      basis: "road_reference",
      value: "positive",
      description: "Kausela",
    });
    expect(details.issues.map((i) => i.code)).toContain("conflicting_direction");
    expect(details.completeness).toBe("partial");
  });

  it("makes no claim when the source carries no licence URL", () => {
    const { licenseUrl: _licenseUrl, ...noRights } = src;
    expect(
      digitrafficRestrictionDetails(propsOf("GUID50465935"), noRights as SourceDescriptor),
    ).toBeUndefined();
  });
});

describe("digitraffic v2 event fields", () => {
  it("keeps the v2 taxonomy, severity, road state and speed limit populated", () => {
    const events = parseDigitraffic(raw, src);
    expect(events).toHaveLength(5);
    expect(events.every((e) => e.type === "roadworks")).toBe(true);
    const width = events.find((e) => e.id === "fi-digitraffic:GUID50470575")!;
    expect(width.severity).toBe("critical");
    expect(width.severitySource).toBe("declared");
    expect(width.roadState).toBe("some_lanes_closed");
    expect(width.speedLimitKph).toBe(60);
    expect(width.direction).toBe("Naantali");
    expect(width.roads).toEqual([{ name: "Turun kehätie", ref: "40", to: "Turun kehätie" }]);
    expect(width.subtype).toBe("road construction");

    const alternating = events.find((e) => e.id === "fi-digitraffic:GUID50468844")!;
    expect(alternating.roadState).toBe("single_lane_alternating");
    expect(alternating.speedLimitKph).toBe(50);
  });

  it("uses versionTime as the source update timestamp", () => {
    const events = parseDigitraffic(raw, src);
    expect(events.find((e) => e.id === "fi-digitraffic:GUID50465935")!.dataUpdatedAt).toBe(
      "2026-08-28T04:18:02.629Z",
    );
  });

  it("falls back to dataUpdatedTime, then releaseTime, and never to fetch time", () => {
    const props = propsOf("GUID50465935");
    delete props["versionTime"];
    props["dataUpdatedTime"] = "2026-09-01T00:00:00.000Z";
    const withData = parseDigitrafficSnapshot(
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [23.5, 60.1] },
            properties: props,
          },
        ],
      },
      src,
      { fetchedAt: FETCHED_AT },
    );
    expect(withData.records[0]!.event!.dataUpdatedAt).toBe("2026-09-01T00:00:00.000Z");

    delete props["dataUpdatedTime"];
    const withRelease = parseDigitrafficSnapshot(
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [23.5, 60.1] },
            properties: props,
          },
        ],
      },
      src,
      { fetchedAt: FETCHED_AT },
    );
    expect(withRelease.records[0]!.event!.dataUpdatedAt).toBe("2026-06-15T10:48:25.057Z");
  });

  it("keeps the event's working hours off its applicability schedule", () => {
    for (const event of parseDigitraffic(raw, src)) {
      if (event.restrictionDetails !== undefined) expect(event.schedule).toBeUndefined();
    }
  });

  it("accounts for an explicitly closed or cancelled record as terminal", () => {
    for (const token of ["closed", "canceled", "CANCELLED"]) {
      const props = propsOf("GUID50470575");
      // Synthetic: the capture contained no terminal record.
      props["earlyClosing"] = token;
      const report = parseDigitrafficSnapshot(
        {
          type: "FeatureCollection",
          features: [{ type: "Feature", geometry: null, properties: props }],
        },
        src,
      );
      expect(report.errors).toEqual([]);
      expect(report.records[0]!.disposition).toBe("terminal");
    }
  });

  it("treats a valid empty weight or exempted collection as a complete empty partition", () => {
    const empty = JSON.parse(
      readFileSync(
        new URL("./fixtures/digitraffic/empty-collection.json", import.meta.url),
        "utf8",
      ),
    );
    const report = parseDigitrafficSnapshot(empty, src);
    expect(report).toEqual({ inputCount: 0, records: [], errors: [] });
  });

  it("maps the other three v2 situation families through the taxonomy", () => {
    const families: Array<[string, string, string]> = [
      ["weight restriction", "W1", "dimension_restriction"],
      ["exempted transport", "E1", "authority"],
      ["traffic announcement", "A1", "accident"],
    ];
    for (const [situationType, id, expected] of families) {
      // Synthetic minimal v2 envelopes for the families the capture found empty.
      const report = parseDigitrafficSnapshot(
        {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [24.9, 60.2] },
              properties: {
                situationId: id,
                situationType,
                version: 1,
                versionTime: "2026-09-12T06:00:00.000Z",
                ...(situationType === "traffic announcement"
                  ? { trafficAnnouncementType: "accident report" }
                  : {}),
                announcements: [
                  {
                    language: "fi",
                    title: "T",
                    timeAndDuration: { startTime: "2026-09-12T00:00:00.000Z", endTime: null },
                  },
                ],
              },
            },
          ],
        },
        src,
      );
      expect(report.errors).toEqual([]);
      expect(report.records[0]!.event!.type, situationType).toBe(expected);
    }
  });

  it("does not change its result when the phases are reordered", () => {
    const props = propsOf("GUID50465935");
    const announcement = (props["announcements"] as Array<Record<string, unknown>>)[0]!;
    const phases = announcement["roadWorkPhases"] as unknown[];
    announcement["roadWorkPhases"] = [...phases].reverse();
    const reversed = digitrafficRestrictionDetails(props, src)!;
    const forward = digitrafficRestrictionDetails(propsOf("GUID50465935"), src)!;
    expect(reversed.facts).toHaveLength(1);
    expect(reversed.facts[0]!.value).toBe(forward.facts[0]!.value);
    expect(reversed.facts[0]!.validFrom).toBe(forward.facts[0]!.validFrom);
  });
});
