import { readFileSync } from "node:fs";
import type { Observation } from "@openconditions/core";
import {
  observationsToGeoJSON,
  type SegmentConditionRow,
  segmentConditionsToJson,
} from "@openconditions/publishers";
import { type RoadEvent, roadAttributes } from "@openconditions/roads";
import { featureCollectionToRoadConditionEvents } from "../toRoadConditionEvents.js";
import type { RoadConditionEvent } from "../types.js";

/**
 * Builds the cross-repository restriction contract fixture from the ACTUAL
 * producer code paths: the real GeoJSON publisher, the real host projection and
 * the real segment-conditions emitter. Nothing here is hand-written expected
 * output, so a producer change cannot pass by editing the golden file alone.
 */

/** Frozen evaluation instant shared by both repositories' contract tests. */
export const CONTRACT_EVALUATED_AT = "2026-09-11T12:00:00.000Z";

export interface RestrictionContractFixture {
  fixtureVersion: 1;
  evaluatedAt: string;
  displayEvents: RoadConditionEvent[];
  segmentConditions: ReturnType<typeof segmentConditionsToJson>;
  /** Display ids that must produce zero shared-routing effects. */
  expectedConditionalIds: string[];
}

const CONTROL_INPUT_URL = new URL(
  "../../../../packages/publishers/src/__tests__/fixtures/contracts/road-conditions-v1.input.json",
  import.meta.url,
);

interface ControlInput {
  at: string;
  resolverVersion: string;
  rows: SegmentConditionRow[];
}

function controlInput(): ControlInput {
  return JSON.parse(readFileSync(CONTROL_INPUT_URL, "utf8")) as ControlInput;
}

const CONDITIONAL_ID = "fi-digitraffic:GUID50465935";

/**
 * The normalized conditional event: one verified 26 t phase limit, active at
 * the frozen instant, with complete rights and no legacy applicability fields.
 */
function conditionalEvent(): RoadEvent & { sourceCheckedAt: string; freshnessWindowSec: number } {
  return {
    id: CONDITIONAL_ID,
    source: "fi-digitraffic",
    sourceFormat: "digitraffic",
    domain: "roads",
    kind: "event",
    type: "dimension_restriction",
    subtype: "road construction",
    category: "planned",
    isPlanned: true,
    severity: "high",
    severitySource: "declared",
    headline: "Tie 104, Raasepori. Tietyö.",
    geometry: { type: "Point", coordinates: [23.536928, 60.117282] },
    status: "active",
    roadState: "closed",
    validFrom: "2026-06-11T21:00:00.000Z",
    validTo: "2026-12-14T21:59:59.999Z",
    roads: [{ name: "Turun kehätie", ref: "104" }],
    direction: "both",
    origin: {
      kind: "feed",
      attribution: {
        provider: "Fintraffic / Digitraffic",
        license: "CC-BY-4.0",
        url: "https://creativecommons.org/licenses/by/4.0/",
      },
    },
    dataUpdatedAt: "2026-08-28T04:18:02.629Z",
    fetchedAt: CONTRACT_EVALUATED_AT,
    isStale: false,
    sourceCheckedAt: "2026-09-11T11:59:00.000Z",
    freshnessWindowSec: 600,
    restrictionDetails: {
      schemaVersion: 1,
      vehicleScope: "specific",
      completeness: "complete",
      issues: [],
      source: {
        sourceId: "fi-digitraffic",
        recordId: "GUID50465935",
        recordVersion: "31",
        sourceUpdatedAt: "2026-08-28T04:18:02.629Z",
        feedUrls: [
          "https://tie.digitraffic.fi/api/traffic-message/v2/traffic-announcements",
          "https://tie.digitraffic.fi/api/traffic-message/v2/roadworks",
          "https://tie.digitraffic.fi/api/traffic-message/v2/weight-restrictions",
          "https://tie.digitraffic.fi/api/traffic-message/v2/exempted-transports",
        ],
        publisher: "Fintraffic / Digitraffic",
        license: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        attribution: "Fintraffic / Digitraffic",
        modificationNotice:
          "Normalized by OpenConditions; source units and structure may be transformed.",
      },
      facts: [
        {
          id: "GUID50465935:GUID50469933:roadwork_phase:announcements[0].roadWorkPhases[1].restrictions[2]",
          kind: "dimension",
          dimension: "gross_weight",
          meaning: "maximum_permitted",
          value: 26000,
          unit: "kg",
          operator: "lte",
          scope: {
            kind: "roadwork_phase",
            phaseId: "GUID50469933",
            locationDescription: "Tie 104 välillä Pohja - Sammatti, Raasepori.",
            sourceLocationRefs: {
              scheme: "digitraffic_road_address",
              road: 104,
              roadSection: 1,
              primaryDistance: 1971,
              secondaryDistance: 2160,
            },
            restrictionBinding: "not_established",
          },
          direction: { basis: "road_reference", value: "both", description: null },
          validFrom: "2026-07-19T21:00:00.000Z",
          validTo: "2026-12-14T21:59:59.999Z",
          sourceTokens: {
            sourcePath: "announcements[0].roadWorkPhases[1].restrictions[2]",
            type: "vehicle gross weight limit",
            name: "Painorajoitus",
            quantity: 26,
            unit: "t",
            phaseId: "GUID50469933",
            direction: "both",
          },
          context: {
            restrictionsLiftable: false,
            compliance: "unknown",
            operatorActionStatus: null,
            validityStatus: null,
            workingHours: [
              {
                scheduleTimezone: "Europe/Helsinki",
                startDate: "2026-07-20",
                endDate: "2026-12-14",
                byDay: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"],
                startTime: "00:00",
                endTime: "23:59",
                duration: "PT23H59M",
                repeatFrequency: "P1D",
              },
            ],
          },
        },
      ],
    },
  };
}

/** The unconditional control event that must keep publishing normally. */
function controlEvent(
  row: SegmentConditionRow,
): Observation & { sourceCheckedAt: string; freshnessWindowSec: number } {
  return {
    id: row.id,
    source: row.source,
    sourceFormat: "native",
    domain: "roads",
    kind: "event",
    type: "road_closure",
    category: "incident",
    severity: "high",
    severitySource: "declared",
    headline: "Road closed",
    geometry: {
      type: "LineString",
      coordinates: [
        [13.4, 52.5],
        [13.41, 52.5],
      ],
    },
    status: "active",
    validFrom: row.valid_from as string,
    validTo: row.valid_to as string,
    origin: {
      kind: "feed",
      attribution: {
        provider: "Example road authority",
        license: "CC0-1.0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
      },
    },
    dataUpdatedAt: "2026-09-11T11:59:00.000Z",
    fetchedAt: CONTRACT_EVALUATED_AT,
    isStale: false,
    sourceCheckedAt: "2026-09-11T11:59:00.000Z",
    freshnessWindowSec: 600,
  } as unknown as Observation & { sourceCheckedAt: string; freshnessWindowSec: number };
}

/**
 * The adversarial graph row: the eligible control row with its identity and
 * attributes replaced by the actual normalized conditional event, and every
 * other eligibility condition — evidence, binding currency, rights — left
 * satisfied. That isolates the restriction guard from every other check.
 */
function conditionalRow(control: SegmentConditionRow, event: RoadEvent): SegmentConditionRow {
  const attributes = roadAttributes(event);
  return {
    ...control,
    id: event.id,
    source: event.source,
    routing_source_id: event.source,
    child_source_id: event.source,
    type: event.type,
    attributes,
    source_license: "CC-BY-4.0",
    license_url: "https://creativecommons.org/licenses/by/4.0/",
    attribution: "Fintraffic / Digitraffic",
    source_uri: null,
  };
}

/** The same row with only its restriction evidence removed. */
function withoutRestrictionEvidence(row: SegmentConditionRow): SegmentConditionRow {
  const attributes = { ...(row.attributes ?? {}) };
  delete attributes["restrictionDetails"];
  delete attributes["restrictionDetailsUnsupported"];
  delete attributes["restrictions"];
  delete attributes["vehiclesAffected"];
  return { ...row, attributes };
}

export function buildRestrictionContractFixture(): RestrictionContractFixture {
  const input = controlInput();
  const control = input.rows[0];
  if (!control) throw new Error("contract control input has no rows");
  const at = new Date(CONTRACT_EVALUATED_AT);
  if (control.valid_from === null || control.valid_to === null) {
    throw new Error("contract control row must carry a validity window");
  }

  const conditional = conditionalEvent();
  const events = [controlEvent(control), conditional as unknown as Observation];
  const rows = [control, conditionalRow(control, conditional)];

  const displayEvents = featureCollectionToRoadConditionEvents(
    observationsToGeoJSON(events, {}, { at }),
  );
  const segmentConditions = segmentConditionsToJson(rows, at, {
    resolverVersion: input.resolverVersion,
    evaluatedAt: at,
  });

  // The conditional record must be visible for display…
  if (!displayEvents.some((event) => event.id === conditional.id)) {
    throw new Error("contract fixture lost the conditional display event");
  }
  // …and absent from shared routing, with the control still emitted.
  if (segmentConditions.conditions.map((condition) => condition.id).join(",") !== control.id) {
    throw new Error(
      `contract fixture emitted unexpected segment conditions: ${segmentConditions.conditions
        .map((condition) => condition.id)
        .join(",")}`,
    );
  }
  // The same row without restriction evidence DOES emit, so the exclusion is
  // attributable to the restriction guard and not to any other condition.
  const withoutEvidence = segmentConditionsToJson([withoutRestrictionEvidence(rows[1]!)], at, {
    resolverVersion: input.resolverVersion,
    evaluatedAt: at,
  });
  if (withoutEvidence.conditions.length !== 1) {
    throw new Error(
      "contract fixture control failed: the conditional row is excluded for a reason other than its restriction evidence",
    );
  }

  return {
    fixtureVersion: 1,
    evaluatedAt: CONTRACT_EVALUATED_AT,
    displayEvents,
    segmentConditions,
    expectedConditionalIds: [conditional.id],
  };
}

/** The adversarial segment row without restriction evidence, for assertions. */
export function contractRowWithoutRestrictionEvidence(): {
  row: SegmentConditionRow;
  at: Date;
  resolverVersion: string;
} {
  const input = controlInput();
  const control = input.rows[0]!;
  return {
    row: withoutRestrictionEvidence(conditionalRow(control, conditionalEvent())),
    at: new Date(CONTRACT_EVALUATED_AT),
    resolverVersion: input.resolverVersion,
  };
}
