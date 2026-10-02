import { describe, expect, it } from "vitest";
import { situationToRoadConditionEvent } from "../situation.js";

type Rec = Record<string, unknown>;

const effect = (id: string, kind: string, fields: Rec = {}): Rec => ({
  id,
  kind,
  v: 1,
  applicability: { kind: "all" },
  compliance: "mandatory",
  normalization: "complete",
  source: { path: "situationRecord[0]", tokens: { raw: "x" } },
  ...fields,
});

function record(over: Rec = {}): Rec {
  return {
    id: "oc:situation:fi-digitraffic:GUID1",
    class: "situation",
    kind: "roadworks",
    type: "works",
    subtype: "resurfacing",
    groupId: "GUID1",
    revision: 2,
    temporality: "scheduled",
    planned: true,
    certainty: "likely",
    severity: { label: "moderate", level: 2, source: "declared" },
    headline: [
      { lang: "fi", text: "Tietyö" },
      { lang: "en", text: "Road works" },
    ],
    description: [{ lang: "fi", text: "Päällystystyö" }],
    validity: {
      status: "planned",
      start: "2026-09-20T06:00:00Z",
      end: "2026-09-30T18:00:00Z",
      periods: [
        {
          startTime: "06:00",
          duration: "PT12H",
          repeatFrequency: "P1D",
          scheduleTimezone: "Europe/Helsinki",
        },
      ],
    },
    effects: [effect("GUID1/speed_limit", "speed_limit", { limit: { value: 50, unit: "km/h" } })],
    details: {
      kind: "roadworks",
      v: 1,
      phases: [
        {
          id: "phase-1",
          validity: {
            status: "active",
            start: "2026-09-21T06:00:00Z",
            end: "2026-09-22T18:00:00Z",
          },
          effects: [
            effect("GUID1/lane_restriction", "lane_restriction", {
              vehicleImpact: "some_lanes_closed",
            }),
          ],
        },
      ],
    },
    location: {
      geometry: {
        type: "LineString",
        coordinates: [
          [24.9, 60.1],
          [24.95, 60.12],
        ],
      },
      extent: "linear",
      geometryOrigin: "source",
      fuzziness: "exact",
      roads: [
        { ref: "1", name: [{ lang: "fi", text: "Turunväylä" }], class: "motorway", from: "Espoo" },
      ],
      direction: { value: "positive", basis: "carriageway", text: "kohti Turkua" },
    },
    provenance: {
      origin: "feed",
      sourceId: "fi-digitraffic",
      sourceUpdatedAt: "2026-09-19T12:00:00Z",
      attribution: {
        provider: "Fintraffic / Digitraffic",
        license: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      },
    },
    freshness: { fetchedAt: "2026-09-19T12:05:00.000Z", expiresAt: "2026-09-19T12:20:00.000Z" },
    ...over,
  };
}

describe("situationToRoadConditionEvent", () => {
  it("maps a situation record field for field", () => {
    expect(situationToRoadConditionEvent(record(), "road-conditions-openconditions")).toEqual({
      id: "oc:situation:fi-digitraffic:GUID1",
      source: "fi-digitraffic",
      provider: "road-conditions-openconditions",
      groupId: "GUID1",
      kind: "roadworks",
      type: "works",
      subtype: "resurfacing",
      severity: { label: "moderate", level: 2 },
      certainty: "likely",
      temporality: "scheduled",
      planned: true,
      headline: [
        { lang: "fi", text: "Tietyö" },
        { lang: "en", text: "Road works" },
      ],
      description: [{ lang: "fi", text: "Päällystystyö" }],
      geometry: {
        type: "LineString",
        coordinates: [
          [24.9, 60.1],
          [24.95, 60.12],
        ],
      },
      roads: [
        { ref: "1", name: [{ lang: "fi", text: "Turunväylä" }], class: "motorway", from: "Espoo" },
      ],
      direction: { value: "positive", text: "kohti Turkua" },
      validity: {
        status: "planned",
        start: "2026-09-20T06:00:00Z",
        end: "2026-09-30T18:00:00Z",
        periods: [
          {
            startTime: "06:00",
            duration: "PT12H",
            repeatFrequency: "P1D",
            scheduleTimezone: "Europe/Helsinki",
          },
        ],
      },
      effects: [
        expect.objectContaining({ id: "GUID1/speed_limit", limit: { value: 50, unit: "km/h" } }),
        expect.objectContaining({ id: "GUID1/lane_restriction" }),
      ],
      origin: "feed",
      attribution: {
        provider: "Fintraffic / Digitraffic",
        license: "CC-BY-4.0",
        url: "https://creativecommons.org/licenses/by/4.0/",
      },
      updatedAt: "2026-09-19T12:00:00Z",
      fetchedAt: "2026-09-19T12:05:00.000Z",
      expiresAt: "2026-09-19T12:20:00.000Z",
    });
  });

  it("keeps a phase effect to its phase's window and drops every effect's parser trace", () => {
    const event = situationToRoadConditionEvent(record())!;
    expect(event.effects[1]!.validity).toEqual({
      status: "active",
      start: "2026-09-21T06:00:00Z",
      end: "2026-09-22T18:00:00Z",
    });
    expect(event.effects[0]!.validity).toBeUndefined();
    expect(event.effects.every((e) => !("source" in e))).toBe(true);
  });

  it("carries a crowd situation's evidence", () => {
    const crowd = record({
      provenance: {
        origin: "crowd",
        sourceId: "crowd",
        attribution: { provider: "OpenConditions" },
      },
      evidence: {
        state: "corroborated",
        confidenceScore: 0.8,
        routingEligible: true,
        corroborations: 3,
      },
    });
    expect(situationToRoadConditionEvent(crowd)).toMatchObject({
      origin: "crowd",
      evidence: { state: "corroborated", confidenceScore: 0.8, routingEligible: true },
    });
  });

  it("cannot show a situation it has no place for", () => {
    const unplaced = record({ location: { geometry: null, openlr: "CwRbWyNG9RpsCQCb/jsbtAT/" } });
    expect(situationToRoadConditionEvent(unplaced)).toBeNull();
  });
});
