import type { Feature } from "geojson";
import { describe, expect, it } from "vitest";
import { observationsToGeoJSON } from "@openconditions/publishers";
import type { Observation } from "@openconditions/core";
import { featureToRoadConditionEvent } from "../toRoadConditionEvents.js";

/**
 * The host DTO projection. The published feature is produced by the real
 * publisher, not hand-written, so producer and consumer cannot drift silently.
 */

const AT = new Date("2026-09-12T07:14:00.000Z");

const restrictionDetails = {
  schemaVersion: 1,
  vehicleScope: "specific",
  completeness: "complete",
  issues: [],
  source: {
    sourceId: "fi-digitraffic",
    recordId: "GUID50465935",
    recordVersion: "31",
    sourceUpdatedAt: "2026-08-28T04:18:02.629Z",
    feedUrls: ["https://tie.digitraffic.fi/api/traffic-message/v2/roadworks"],
    publisher: "Fintraffic / Digitraffic",
    license: "CC-BY-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    attribution: "Fintraffic / Digitraffic",
    modificationNotice:
      "Normalized by OpenConditions; source units and structure may be transformed.",
  },
  facts: [
    {
      id: "GUID50465935:GUID50469933:roadwork_phase:restrictions[2]",
      kind: "dimension",
      dimension: "gross_weight",
      meaning: "maximum_permitted",
      value: 26000,
      unit: "kg",
      operator: "lte",
      scope: {
        kind: "roadwork_phase",
        phaseId: "GUID50469933",
        locationDescription: "Tie 104, Raasepori",
        sourceLocationRefs: { scheme: "digitraffic_road_address", road: 104 },
        restrictionBinding: "not_established",
      },
      direction: { basis: "road_reference", value: "both", description: null },
      validFrom: "2026-07-19T21:00:00.000Z",
      validTo: "2026-12-14T21:59:59.999Z",
      sourceTokens: { type: "vehicle gross weight limit", quantity: 26, unit: "t" },
      context: {
        restrictionsLiftable: false,
        compliance: "unknown",
        operatorActionStatus: null,
        validityStatus: null,
      },
    },
  ],
};

function observation(over: Record<string, unknown> = {}): Observation {
  return {
    id: "fi-digitraffic:GUID50465935",
    source: "fi-digitraffic",
    sourceFormat: "digitraffic",
    domain: "roads",
    kind: "event",
    type: "dimension_restriction",
    subtype: "road construction",
    category: "planned",
    severity: "high",
    severitySource: "declared",
    headline: "Tie 104, Raasepori. Tietyö.",
    status: "active",
    geometry: { type: "Point", coordinates: [23.536928, 60.117282] },
    isPlanned: true,
    roads: [{ name: "104", ref: "104" }],
    origin: {
      kind: "feed",
      attribution: {
        provider: "Fintraffic / Digitraffic",
        license: "CC-BY-4.0",
        url: "https://creativecommons.org/licenses/by/4.0/",
      },
    },
    dataUpdatedAt: "2026-08-28T04:18:02.629Z",
    fetchedAt: "2026-09-12T07:14:00.000Z",
    isStale: false,
    sourceCheckedAt: "2026-09-12T07:13:00.000Z",
    freshnessWindowSec: 600,
    restrictionDetails,
    ...over,
  } as unknown as Observation;
}

function publish(obs: Observation): Feature {
  return observationsToGeoJSON([obs], {}, { at: AT }).features[0]!;
}

describe("host restriction projection", () => {
  it("carries the evaluated envelope through unchanged", () => {
    const feature = publish(observation());
    const event = featureToRoadConditionEvent(feature)!;
    expect(event.restrictionDetails).toEqual(feature.properties!["restrictionDetails"]);
    expect(event.restrictionDetailsUnsupported).toBeUndefined();
    expect(event.restrictionDetails!.facts[0]).toMatchObject({
      value: 26000,
      unit: "kg",
      state: "active",
      scope: { kind: "roadwork_phase", restrictionBinding: "not_established" },
    });
    expect(event.restrictionDetails!.source.attribution).toBe("Fintraffic / Digitraffic");
  });

  it("maps the OC dimension-restriction type to the host vocabulary, keeping the subtype", () => {
    const event = featureToRoadConditionEvent(publish(observation()))!;
    expect(event.type).toBe("restriction");
    expect(event.subtype).toBe("road construction");
  });

  it("marks an invalid envelope unsupported instead of dropping the claim", () => {
    const event = featureToRoadConditionEvent(
      publish(observation({ restrictionDetails: { schemaVersion: 9 } }))
    )!;
    expect(event.restrictionDetailsUnsupported).toBe(true);
    expect(event.restrictionDetails).toBeUndefined();
  });

  it("rejects a published envelope that lost its evaluation metadata", () => {
    // A hand-built feature that skipped the publisher: the host must not trust it.
    const event = featureToRoadConditionEvent({
      type: "Feature",
      geometry: { type: "Point", coordinates: [23.5, 60.1] },
      properties: { id: "fi-digitraffic:GUID50465935", restrictionDetails },
    })!;
    expect(event.restrictionDetailsUnsupported).toBe(true);
    expect(event.restrictionDetails).toBeUndefined();
  });

  it("makes no restriction claim for an ordinary event", () => {
    const event = featureToRoadConditionEvent(
      publish(observation({ restrictionDetails: undefined, type: "roadworks" }))
    )!;
    // An explicitly present-but-undefined envelope is still a claim.
    expect(event.restrictionDetailsUnsupported).toBe(true);

    const plain = observation();
    delete (plain as unknown as Record<string, unknown>)["restrictionDetails"];
    const ordinary = featureToRoadConditionEvent(publish(plain))!;
    expect(ordinary.restrictionDetails).toBeUndefined();
    expect(ordinary.restrictionDetailsUnsupported).toBeUndefined();
  });

  it("carries the stale flag and freshness deadline the producer computed", () => {
    const stale = featureToRoadConditionEvent(
      publish(observation({ sourceCheckedAt: "2026-09-12T06:00:00.000Z" }))
    )!;
    expect(stale.restrictionDetails!.isStale).toBe(true);
    expect(stale.restrictionDetails!.freshUntil).toBe("2026-09-12T06:10:00.000Z");
  });
});
