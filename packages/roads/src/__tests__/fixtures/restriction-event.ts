import type { RoadEvent } from "../../model.js";
import type { RoadRestrictionDetailsV1 } from "../../restriction-types.js";

/**
 * A labelled normalized test fixture derived from the reviewed Fintraffic
 * capture of 2026-09-12 (record GUID50465935, phase GUID50469933). Parser tests
 * use the raw source fixture instead; this is the normalized-contract shape.
 * Every factory returns a fresh object graph so a test may mutate it freely.
 */
export function restrictionDetails(): RoadRestrictionDetailsV1 {
  return {
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
        direction: {
          basis: "road_reference",
          value: "both",
          description: null,
        },
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
          eventWindow: {
            startTime: "2026-06-11T21:00:00.000Z",
            endTime: "2026-12-14T21:59:59.999Z",
          },
          phaseWindow: {
            startTime: "2026-07-19T21:00:00.000Z",
            endTime: "2026-12-14T21:59:59.999Z",
          },
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
  };
}

export function restrictionEvent(): RoadEvent {
  return {
    id: "fi-digitraffic:GUID50465935",
    source: "fi-digitraffic",
    sourceFormat: "digitraffic",
    domain: "roads",
    kind: "event",
    type: "roadworks",
    category: "planned",
    isPlanned: true,
    severity: "high",
    severitySource: "declared",
    headline: "Tie 104, Raasepori. Tietyö.",
    geometry: { type: "Point", coordinates: [23.536928, 60.117282] },
    status: "active",
    validFrom: "2026-06-11T21:00:00.000Z",
    validTo: "2026-12-14T21:59:59.999Z",
    roads: [{ name: "104", ref: "104" }],
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
    fetchedAt: "2026-09-12T07:14:00.000Z",
    isStale: false,
    restrictionDetails: restrictionDetails(),
  };
}
