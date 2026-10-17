import { assertCovered } from "@openconditions/conformance";
import {
  DATEX2_V2,
  DATEX2_V2_INFRASTRUCTURE,
  DATEX2_V3,
  DATEX2_V3_INFRASTRUCTURE,
} from "@openconditions/model-roads";
import { describe, expect, it } from "vitest";
import {
  type DatexVersion,
  parseMeasured,
  parseRecord,
  type RecordSpec,
} from "./helpers/datex-records.js";

/**
 * Every record class and enumerated value the DATEX II situation and
 * measured-data parsers map, from v2.3 and v3.7, run through the real parser
 * in a record carrying it. The lists are the model-roads vocabularies, which
 * `datex-schema-conformance.test.ts` holds equal to the official schemas.
 * A value is handled when the record keeps it in the meaning the standard
 * gives it, and without counting it unread; anything else is listed as
 * unsupported with the reason.
 */
const VERSIONS = [
  { version: "v2" as DatexVersion, label: "v2.3", vocab: DATEX2_V2 },
  { version: "v3" as DatexVersion, label: "v3.7", vocab: DATEX2_V3 },
];

/** v3's placeholder for a value an extension schema defines. */
const EXTENDED =
  "the placeholder for a value of a national extension schema, which the parser does not read: the record keeps its class's meaning and the value is counted unread";

/**
 * What each record class is, as a classification kind, by the class
 * definitions. Classes the model has no closer kind for (instructions,
 * network management, transit and roadside service information, car parks,
 * signs and the generic record) are situations of kind `other`.
 */
const CLASS_KIND: Readonly<Record<string, string>> = {
  AbnormalTraffic: "congestion",
  Accident: "incident",
  AnimalPresenceObstruction: "incident",
  AuthorityOperation: "authority",
  CarParks: "other",
  Conditions: "road_condition",
  ConstructionWorks: "roadworks",
  DisturbanceActivity: "security",
  EnvironmentalObstruction: "incident",
  EquipmentOrSystemFault: "equipment_fault",
  GeneralInstructionOrMessageToRoadUsers: "other",
  GeneralNetworkManagement: "other",
  GeneralObstruction: "incident",
  GenericSituationRecord: "other",
  InfrastructureDamageObstruction: "incident",
  MaintenanceWorks: "roadworks",
  NonWeatherRelatedRoadConditions: "road_condition",
  OperatorAction: "other",
  PoorEnvironmentConditions: "weather_condition",
  PublicEvent: "public_event",
  ReroutingManagement: "closure",
  RoadOperatorServiceDisruption: "equipment_fault",
  RoadOrCarriagewayOrLaneManagement: "other",
  RoadsideAssistance: "authority",
  RoadsideServiceDisruption: "other",
  ServiceDisruption: "other",
  SignSetting: "other",
  SpeedManagement: "restriction",
  TransitInformation: "other",
  VehicleObstruction: "incident",
  WeatherRelatedRoadConditions: "road_condition",
  WinterDrivingManagement: "winter_operation",
};

/** The reasons for the values one version's list holds; the versions' lists differ. */
const within = (values: readonly string[], reasons: Record<string, string>) =>
  Object.fromEntries(Object.entries(reasons).filter(([value]) => values.includes(value)));

const code = (c: { kind: string; type: string; subtype?: string } | undefined) =>
  c === undefined ? undefined : [c.kind, c.type, c.subtype].filter(Boolean).join(".");

describe.each(VERSIONS)("DATEX II $label situation records", ({ version, label, vocab }) => {
  it("reads every concrete SituationRecord subtype as what it is", () => {
    assertCovered(`${label} SituationRecord`, vocab.recordClasses, {
      handled: (cls) => {
        const { events, event, skipped } = parseRecord(version, { recordClass: cls });
        return (
          events.length === 1 &&
          Object.keys(skipped).length === 0 &&
          event?.situation?.classification?.kind === CLASS_KIND[cls]
        );
      },
    });
  });

  const discriminators = Object.entries(
    vocab.discriminators as Record<string, { element: string; values: readonly string[] }>,
  );

  it.each(discriminators)("reads every %s discriminator value", (cls, { element, values }) => {
    const classOnly = parseRecord(version, { recordClass: cls }).event?.situation?.classification;
    assertCovered(`${label} ${cls}.${element}`, values, {
      // A value refines the class's classification, or, where the model has
      // nothing finer, the record keeps it as its subtype; it is never counted
      // unread.
      handled: (value) => {
        const { event, skipped } = parseRecord(version, {
          recordClass: cls,
          body: `<:${element}>${value}</:${element}>`,
        });
        const classification = event?.situation?.classification;
        return (
          event !== undefined &&
          skipped.unknown_value === undefined &&
          classification !== undefined &&
          (code(classification) !== code(classOnly) || event.subtype === value)
        );
      },
      unsupported: values.includes("_extended") ? { _extended: EXTENDED } : {},
    });
  });

  it("reads every cause type into the record's causes", () => {
    const unsupported: Record<string, string> = {
      // Causes that name the record's own measure, or no cause at all; the
      // model's cause vocabulary has no value for them and the record keeps
      // the token as its subtype.
      instructionToRoadUsers: "names an instruction to road users, not what caused the record",
      networkManagement: "names the operator's own network management, not an underlying cause",
      rerouting: "names the rerouting measure itself, not what caused it",
      roadOrCarriagewayOrLaneManagement: "names the lane management measure itself",
      speedManagement: "names the speed management measure itself",
      roadsideServiceDisruption:
        "a disruption of roadside services (fuel, rest areas) has no counterpart in the cause vocabulary",
      transitServiceDisruption:
        "a public transport disruption has no counterpart in the cause vocabulary",
      earlierEvent: "names no kind of event, only that one happened earlier",
      _extended: EXTENDED,
    };
    assertCovered(`${label} CauseTypeEnum`, vocab.causeTypes, {
      handled: (cause) => {
        const { event, skipped } = parseRecord(version, {
          recordClass: "GeneralObstruction",
          causeType: cause,
        });
        return (
          skipped.unknown_value === undefined &&
          (event?.situation?.classification?.causes?.length ?? 0) > 0
        );
      },
      unsupported: within(vocab.causeTypes, unsupported),
    });
  });

  it("reads every severity on the severity scale", () => {
    const expected: Record<string, string> = {
      highest: "critical",
      high: "high",
      medium: "medium",
      low: "low",
      lowest: "low",
      unknown: "unknown",
    };
    assertCovered(`${label} SeverityEnum`, vocab.severities, {
      handled: (severity) => {
        const { event, skipped } = parseRecord(version, {
          recordClass: "Accident",
          severity,
        });
        return (
          skipped.unknown_value === undefined &&
          event?.severity === expected[severity] &&
          event.situation?.severityRaw === severity
        );
      },
      unsupported: {
        none: "the severity scale has no level for 'a severity rating of none'; it reads as unknown, and the token stays in severityRaw",
        ...(version === "v3" ? { _extended: EXTENDED } : {}),
      },
    });
  });

  it("reads every probability of occurrence as a confidence", () => {
    const expected: Record<string, string> = {
      certain: "observed",
      probable: "likely",
      riskOf: "possible",
    };
    assertCovered(`${label} ProbabilityOfOccurrenceEnum`, vocab.probabilities, {
      handled: (probability) => {
        const { event, skipped } = parseRecord(version, { recordClass: "Accident", probability });
        return skipped.unknown_value === undefined && event?.confidence === expected[probability];
      },
      unsupported: version === "v3" ? { _extended: EXTENDED } : {},
    });
  });

  it("reads every validity status as the record's lifecycle", () => {
    const values =
      version === "v3"
        ? ["active", "planned", "suspended", "definedByValidityTimeSpec", "_extended"]
        : ["active", "suspended", "definedByValidityTimeSpec"];
    // The standard's meaning: `active` and `definedByValidityTimeSpec` are in
    // force (the latter by its time specification), `planned` and `suspended`
    // are declared not in force, so neither may read as an active effect.
    const expected: Record<
      string,
      (e: NonNullable<ReturnType<typeof parseRecord>["event"]>) => boolean
    > = {
      active: (e) => e.status === "active" && e.situation?.statusIssue === undefined,
      definedByValidityTimeSpec: (e) =>
        e.status === "active" && e.situation?.statusIssue === undefined,
      planned: (e) =>
        e.situation?.validityStatus === "planned" && e.situation.statusIssue !== undefined,
      suspended: (e) =>
        e.status === "inactive" &&
        e.situation?.validityStatus === "suspended" &&
        e.situation.statusIssue !== undefined,
    };
    assertCovered(`${label} ValidityStatusEnum`, values, {
      handled: (validityStatus) => {
        const { event, skipped } = parseRecord(version, {
          recordClass: "Accident",
          validityStatus,
        });
        const check = expected[validityStatus];
        return (
          skipped.unknown_value === undefined &&
          event !== undefined &&
          check !== undefined &&
          check(event)
        );
      },
      unsupported:
        version === "v3"
          ? {
              _extended: `${EXTENDED}; the record carries an unsupported_status issue so it never routes as active`,
            }
          : {},
    });
  });
});

/**
 * The road state each `RoadOrCarriagewayOrLaneManagementTypeEnum` value
 * declares, by the enumeration's definitions; `null` where the value manages
 * lanes without closing or opening the road.
 */
const ROAD_STATE: Readonly<Record<string, string | null>> = {
  roadClosed: "closed",
  carriagewayClosures: "closed",
  closedPermanentlyForTheWinter: "closed",
  overnightClosures: "closed",
  intermittentShortTermClosures: "closed",
  turnAroundInOperation: "closed",
  laneClosures: "some_lanes_closed",
  doNotUseSpecifiedLanesOrCarriageways: "some_lanes_closed",
  singleAlternateLineTraffic: "single_lane_alternating",
  roadCleared: "open",
  contraflow: null,
  carPoolLaneInOperation: null,
  clearALaneForEmergencyVehicles: null,
  clearALaneForSnowploughsAndGrittingVehicles: null,
  hardShoulderRunningInOperation: null,
  hardShoulderRunningNotInOperation: null,
  heightRestrictionInOperation: null,
  keepToTheLeft: null,
  keepToTheRight: null,
  lanesDeviated: null,
  narrowLanes: null,
  newRoadworksLayout: null,
  rollingRoadBlock: null,
  rushHourLaneInOperation: null,
  tidalFlowLaneInOperation: null,
  useOfSpecifiedLanesOrCarriagewaysAllowed: null,
  useSpecifiedLanesOrCarriageways: null,
  vehicleStorageInOperation: null,
  weightRestrictionInOperation: null,
  other: null,
};

describe.each(VERSIONS)(
  "DATEX II $label lane and carriageway management",
  ({ version, label, vocab }) => {
    const values = (vocab.discriminators as Record<string, { values: readonly string[] }>)[
      "RoadOrCarriagewayOrLaneManagement"
    ]!.values;
    const manage = (value: string) =>
      parseRecord(version, {
        recordClass: "RoadOrCarriagewayOrLaneManagement",
        body: `<:roadOrCarriagewayOrLaneManagementType>${value}</:roadOrCarriagewayOrLaneManagementType>`,
      }).event;

    it("reads the road state every management type declares", () => {
      assertCovered(`${label} RoadOrCarriagewayOrLaneManagementTypeEnum`, values, {
        handled: (value) =>
          value in ROAD_STATE && (manage(value)?.roadState ?? null) === ROAD_STATE[value],
        unsupported: values.includes("_extended") ? { _extended: EXTENDED } : {},
      });
    });

    it("types a contraflow as one, not as alternating single-lane working", () => {
      const event = manage("contraflow");
      expect(event?.type).toBe("contraflow");
      expect(event?.roadState).toBeUndefined();
    });

    it("types a declared road closure as a road closure", () => {
      expect(manage("roadClosed")?.type).toBe("road_closure");
    });
  },
);

describe("DATEX II discriminator values refine the class as the standard defines them", () => {
  const cases: [string, string, string, string][] = [
    ["Accident", "accidentType", "seriousInjuryOrFatalAccident", "incident.accident.fatal"],
    [
      "Accident",
      "accidentType",
      "accidentInvolvingHazardousMaterials",
      "incident.accident.hazmat_spill",
    ],
    ["GeneralObstruction", "obstructionType", "objectOnTheRoad", "incident.obstruction.object"],
    [
      "VehicleObstruction",
      "vehicleObstructionType",
      "brokenDownVehicle",
      "incident.breakdown.disabled_vehicle",
    ],
    [
      "EnvironmentalObstruction",
      "environmentalObstructionType",
      "flooding",
      "road_hazard.hazard.flooding",
    ],
    ["MaintenanceWorks", "roadMaintenanceType", "resurfacingWork", "roadworks.works.resurfacing"],
    [
      "RoadOrCarriagewayOrLaneManagement",
      "roadOrCarriagewayOrLaneManagementType",
      "laneClosures",
      "closure.closure.lane",
    ],
    [
      "RoadOrCarriagewayOrLaneManagement",
      "roadOrCarriagewayOrLaneManagementType",
      "carriagewayClosures",
      "closure.closure.carriageway",
    ],
    [
      "GeneralNetworkManagement",
      "generalNetworkManagementType",
      "bridgeSwingInOperation",
      "closure.closure.bridge",
    ],
    ["PoorEnvironmentConditions", "poorEnvironmentType", "fog", "weather_condition.weather.fog"],
  ];
  it.each(VERSIONS)("$label", ({ version }) => {
    for (const [cls, element, value, expected] of cases) {
      const { event } = parseRecord(version, {
        recordClass: cls,
        body: `<:${element}>${value}</:${element}>`,
      });
      expect(code(event?.situation?.classification), `${cls}:${value}`).toBe(expected);
      expect(event?.subtype, `${cls}:${value}`).toBe(value);
    }
  });
});

const MEASURED = [
  { version: "v2" as DatexVersion, label: "v2.3", infrastructure: DATEX2_V2_INFRASTRUCTURE },
  { version: "v3" as DatexVersion, label: "v3.7", infrastructure: DATEX2_V3_INFRASTRUCTURE },
];

/** A measured value of each read type, and how its value lands in the site reading. */
const READ_TYPES: Readonly<
  Record<
    string,
    {
      body: string;
      check: (r: NonNullable<ReturnType<typeof parseMeasured>["reading"]>) => boolean;
    }
  >
> = {
  TrafficSpeed: {
    body: `<:averageVehicleSpeed numberOfInputValuesUsed="10"><:speed>87</:speed></:averageVehicleSpeed>`,
    check: (r) => r.speedKph === 87 && r.sampleCount === 10,
  },
  TrafficFlow: {
    body: `<:vehicleFlow><:vehicleFlowRate>1260</:vehicleFlowRate></:vehicleFlow>`,
    check: (r) => r.volume === 1260,
  },
  TrafficConcentration: {
    body: `<:occupancy><:percentage>12.5</:percentage></:occupancy>`,
    check: (r) => r.occupancy === 12.5,
  },
  TrafficStatus: {
    body: `<:trafficStatus><:trafficStatusValue>freeFlow</:trafficStatusValue></:trafficStatus>`,
    check: (r) => r.los === "free_flow",
  },
};

describe.each(MEASURED)("DATEX II $label measured data", ({ version, label, infrastructure }) => {
  it("reads every traffic BasicData type the site reading has a place for", () => {
    assertCovered(`${label} BasicData`, Object.keys(infrastructure.measuredValues), {
      handled: (type) => {
        const read = READ_TYPES[type];
        if (read === undefined) return false;
        const { reading, skipped } = parseMeasured(version, [{ type, body: read.body }]);
        return reading !== undefined && Object.keys(skipped).length === 0 && read.check(reading);
      },
      unsupported: within(Object.keys(infrastructure.measuredValues), {
        TrafficHeadway: "a site reading has no headway; the value is counted unread",
        TrafficGap: "a site reading has no gap between vehicles; the value is counted unread",
        TravelTimeData:
          "a site reading has no travel time (travel times are read from ElaboratedData); the value is counted unread",
        IndividualVehicleDataValues:
          "per-vehicle records are not a site measurement; the value is counted unread",
      }),
    });
  });

  it("reads every traffic status as a level of service", () => {
    const expected: Record<string, string> = {
      impossible: "blocked",
      congested: "queuing",
      heavy: "heavy",
      slow: "heavy",
      freeFlow: "free_flow",
      unknown: "unknown",
      stationary: "stationary",
      queuing: "queuing",
    };
    const speed = { type: "TrafficSpeed", body: READ_TYPES["TrafficSpeed"]!.body };
    assertCovered(`${label} TrafficStatusEnum`, infrastructure.trafficStatuses, {
      handled: (status) => {
        const { reading, skipped } = parseMeasured(version, [
          speed,
          {
            type: "TrafficStatus",
            body: `<:trafficStatus><:trafficStatusValue>${status}</:trafficStatusValue></:trafficStatus>`,
          },
        ]);
        return skipped.unknown_value === undefined && reading?.los === expected[status];
      },
      unsupported:
        version === "v3"
          ? {
              unspecifiedAbnormal:
                "abnormal traffic of no stated kind names no level of service; counted unread",
              other: "names no level of service; counted unread",
              _extended: EXTENDED,
            }
          : {},
    });
  });
});
