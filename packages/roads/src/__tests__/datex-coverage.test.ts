import { assertCovered } from "@openconditions/conformance";
import type { DirectionRef, Effect } from "@openconditions/model";
import {
  DATEX2_DELAY_BANDS,
  DATEX2_DELAY_TYPES,
  DATEX2_ROADWORKS_DURATIONS,
  DATEX2_ROADWORKS_SCALES,
  DATEX2_SOURCE_TYPES,
  DATEX2_V2,
  DATEX2_V2_INFRASTRUCTURE,
  DATEX2_V3,
  DATEX2_V3_INFRASTRUCTURE,
} from "@openconditions/model-roads";
import { describe, expect, it } from "vitest";
import type { RoadEvent } from "../model.js";
import { applicabilityOf, effectsOf } from "../situation/effects.js";
import { entryOf } from "../situation/location.js";
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
    // `none` is "a severity rating of none", a declared absence of impact:
    // not the missing rating `unknown` is.
    const expected: Record<string, string> = {
      highest: "critical",
      high: "high",
      medium: "medium",
      low: "low",
      lowest: "low",
      none: "none",
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
      unsupported: version === "v3" ? { _extended: EXTENDED } : {},
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

/** `OperatorActionStatusEnum` as the kernel's action statuses. */
const ACTION_STATUS: Readonly<Record<string, string>> = {
  requested: "requested",
  approved: "approved",
  beingImplemented: "being_implemented",
  implemented: "implemented",
  rejected: "rejected",
  terminationRequested: "termination_requested",
  beingTerminated: "being_terminated",
};

/** What each `TrafficConstrictionTypeEnum` value declares about the road. */
const CONSTRICTION: Readonly<
  Record<string, { roadState?: string; closureScope?: string } | undefined>
> = {
  roadBlocked: { roadState: "closed" },
  carriagewayBlocked: { roadState: "closed", closureScope: "carriageway" },
  lanesBlocked: { roadState: "some_lanes_closed" },
  roadPartiallyObstructed: undefined,
  carriagewayPartiallyObstructed: undefined,
  lanesPartiallyObstructed: undefined,
};

const DAY: Readonly<Record<string, string>> = {
  monday: "MO",
  tuesday: "TU",
  wednesday: "WE",
  thursday: "TH",
  friday: "FR",
  saturday: "SA",
  sunday: "SU",
};

/** A road closure by network management, with `measure` before its management type. */
const closureBy = (measure: string) =>
  `${measure}<:roadOrCarriagewayOrLaneManagementType>roadClosed</:roadOrCarriagewayOrLaneManagementType>`;

describe.each(VERSIONS)(
  "DATEX II $label measures and their timing",
  ({ version, label, vocab }) => {
    it("reads every operator action status as the action's status", () => {
      assertCovered(`${label} OperatorActionStatusEnum`, vocab.operatorActionStatuses, {
        handled: (status) => {
          const { event, skipped } = parseRecord(version, {
            recordClass: "RoadOrCarriagewayOrLaneManagement",
            body: closureBy(
              `<:operatorActionStatus>${status}</:operatorActionStatus><:complianceOption>mandatory</:complianceOption>`,
            ),
          });
          return (
            skipped.unknown_value === undefined &&
            event?.situation?.actionStatus === ACTION_STATUS[status] &&
            event.situation.effectIssues === undefined
          );
        },
        unsupported:
          version === "v3"
            ? {
                _extended: `${EXTENDED}; every effect carries unsupported_status, so none routes on a status it cannot establish`,
              }
            : {},
      });
    });

    it("reads every compliance option as the measure's compliance", () => {
      assertCovered(`${label} ComplianceOptionEnum`, vocab.complianceOptions, {
        handled: (option) => {
          const { event, skipped } = parseRecord(version, {
            recordClass: "RoadOrCarriagewayOrLaneManagement",
            body: closureBy(`<:complianceOption>${option}</:complianceOption>`),
          });
          return skipped.unknown_value === undefined && event?.situation?.compliance === option;
        },
        unsupported:
          version === "v3"
            ? { _extended: `${EXTENDED}; the measure's compliance reads as unknown` }
            : {},
      });
    });

    it("reads every traffic constriction as the state of the road", () => {
      assertCovered(`${label} TrafficConstrictionTypeEnum`, vocab.trafficConstrictionTypes, {
        handled: (constriction) => {
          if (!(constriction in CONSTRICTION)) return false;
          const element = `<:trafficConstrictionType>${constriction}</:trafficConstrictionType>`;
          const { event, skipped } = parseRecord(version, {
            recordClass: "Accident",
            ...(version === "v3"
              ? { body: `${element}<:accidentType>collision</:accidentType>` }
              : { impact: element, body: `<:accidentType>collision</:accidentType>` }),
          });
          const expected = CONSTRICTION[constriction];
          return (
            skipped.unknown_value === undefined &&
            event?.roadState === expected?.roadState &&
            event?.situation?.closureScope === expected?.closureScope
          );
        },
        unsupported:
          version === "v3" ? { _extended: `${EXTENDED}; the record declares no road state` } : {},
      });
    });

    it("reads every traffic type as the vehicles the measure applies to", () => {
      assertCovered(`${label} TrafficTypeEnum`, vocab.trafficTypes, {
        handled: (traffic) => {
          const { event, skipped } = parseRecord(version, {
            recordClass: "RoadOrCarriagewayOrLaneManagement",
            body: closureBy(
              `<:complianceOption>mandatory</:complianceOption><:applicableForTrafficType>${traffic}</:applicableForTrafficType>`,
            ),
          });
          if (event === undefined || skipped.unknown_value !== undefined) return false;
          const applicability = applicabilityOf(event);
          const token = `applicableForTrafficType:${traffic}`;
          // Through traffic is "traffic which is not for local access": local
          // access is spared. Any other kind of traffic no selector names.
          return traffic === "throughTraffic"
            ? applicability.kind === "all" &&
                applicability.except?.some((s) => s.usage === "local_access") === true
            : applicability.kind === "unknown" && applicability.raw?.includes(token) === true;
        },
        unsupported:
          version === "v3"
            ? { _extended: `${EXTENDED}; the measure's vehicles read as unknown` }
            : {},
      });
    });

    it("reads every roadworks mobility as the work zone it makes", () => {
      const expected: Record<string, string | undefined> = {
        mobile: "moving",
        stationary: "static",
        unknown: undefined,
      };
      assertCovered(`${label} mobility types`, vocab.mobilityTypes, {
        handled: (mobility) => {
          if (!(mobility in expected)) return false;
          const { event, skipped } = parseRecord(version, {
            recordClass: "MaintenanceWorks",
            body: `<:mobility><:mobilityType>${mobility}</:mobilityType></:mobility><:roadMaintenanceType>roadworks</:roadMaintenanceType>`,
          });
          return skipped.unknown_value === undefined && event?.workZoneType === expected[mobility];
        },
        unsupported:
          version === "v3" ? { _extended: `${EXTENDED}; the work zone reads as neither` } : {},
      });
    });

    const recurrence = (content: string) =>
      `<:validPeriod><:recurringDayWeekMonthPeriod>${content}</:recurringDayWeekMonthPeriod></:validPeriod>`;
    const unrepresentable =
      "the schedule carries no such day or month: it is dropped from its group, a group left naming nothing is reported, and every effect carries unsupported_schedule";

    it("reads every recurrence day as a day of the schedule", () => {
      assertCovered(`${label} DayEnum`, vocab.days, {
        handled: (day) => {
          const { event, skipped } = parseRecord(version, {
            recordClass: "Accident",
            body: "<:accidentType>collision</:accidentType>",
            timeSpec: recurrence(`<:applicableDay>${day}</:applicableDay>`),
          });
          return (
            skipped.unknown_value === undefined &&
            event?.schedule?.[0]?.byDay?.join() === DAY[day] &&
            event.situation?.effectIssues === undefined
          );
        },
        unsupported: version === "v3" ? { _extended: `${EXTENDED}; ${unrepresentable}` } : {},
      });
    });

    it("reads every recurrence month as a month of the schedule", () => {
      assertCovered(`${label} MonthOfYearEnum`, vocab.months, {
        handled: (month) => {
          const { event, skipped } = parseRecord(version, {
            recordClass: "Accident",
            body: "<:accidentType>collision</:accidentType>",
            timeSpec: recurrence(`<:applicableMonth>${month}</:applicableMonth>`),
          });
          return (
            skipped.unknown_value === undefined &&
            event?.schedule?.[0]?.byMonth?.join() ===
              String(vocab.months.indexOf(month as never) + 1) &&
            event.situation?.effectIssues === undefined
          );
        },
        unsupported: version === "v3" ? { _extended: `${EXTENDED}; ${unrepresentable}` } : {},
      });
    });

    if ("weeksOfMonth" in vocab) {
      it("reports every week of the month as a recurrence it cannot carry", () => {
        assertCovered(`${label} WeekOfMonthEnum`, vocab.weeksOfMonth, {
          handled: () => false,
          unsupported: Object.fromEntries(
            vocab.weeksOfMonth.map((week) => [
              week,
              "a schedule has no week of the month (and v2.3 does not say how weeks are counted); every effect carries unsupported_schedule, so the record never routes as if in force every week",
            ]),
          ),
        });
        const { event } = parseRecord(version, {
          recordClass: "Accident",
          body: "<:accidentType>collision</:accidentType>",
          timeSpec: recurrence(
            "<:applicableDay>monday</:applicableDay><:applicableWeek>firstWeekOfMonth</:applicableWeek>",
          ),
        });
        expect(event?.situation?.effectIssues).toContainEqual(
          expect.objectContaining({
            code: "unsupported_schedule",
            sourceTokens: { unsupportedFields: ["applicableWeek"] },
          }),
        );
      });
    }

    it("keeps an overrun end as the estimate it was, not as a bound", () => {
      // The record's version time is 08:00: by then its 08:00 end has passed.
      const overrun = parseRecord(version, {
        recordClass: "Accident",
        body: "<:accidentType>collision</:accidentType>",
        overrunning: "<:overrunning>true</:overrunning>",
        timeSpec: "<:overallEndTime>2026-09-18T08:00:00Z</:overallEndTime>",
      }).event;
      expect(overrun?.validTo).toBeNull();
      expect(overrun?.situation?.estimatedEnd).toBe("2026-09-18T08:00:00Z");
      const replanned = parseRecord(version, {
        recordClass: "Accident",
        body: "<:accidentType>collision</:accidentType>",
        overrunning: "<:overrunning>true</:overrunning>",
        timeSpec: "<:overallEndTime>2026-09-18T12:00:00Z</:overallEndTime>",
      }).event;
      expect(replanned?.validTo).toBe("2026-09-18T12:00:00Z");
      expect(replanned?.situation?.estimatedEnd).toBeUndefined();
    });

    it("reads the remaining capacity as the delay's", () => {
      const { event } = parseRecord(version, {
        recordClass: "Accident",
        body: "<:accidentType>collision</:accidentType>",
        impact: "<:capacityRemaining>40</:capacityRemaining>",
      });
      expect(event?.capacityRemainingPct).toBe(40);
    });

    it("keeps a measure that applies only at some places within its location partial", () => {
      const { event } = parseRecord(version, {
        recordClass: "RoadOrCarriagewayOrLaneManagement",
        body: closureBy(
          "<:complianceOption>mandatory</:complianceOption><:placesAtWhichApplicable>inTunnels</:placesAtWhichApplicable>",
        ),
      });
      expect(event?.situation?.effectIssues).toEqual([
        {
          code: "compound_condition",
          sourcePath: "situationRecord.placesAtWhichApplicable",
          sourceTokens: { placesAtWhichApplicable: ["inTunnels"] },
        },
      ]);
    });
  },
);

/** The effects of one parsed record, at a location whose direction is `direction`. */
const effectsAt = (event: RoadEvent, direction?: DirectionRef) =>
  effectsOf(event, {
    recordId: "R1",
    closureNature: false,
    laneClosureNature: false,
    ...(direction ? { direction } : {}),
  }).map((p) => p.effect);

/** What each `DirectionEnum` value reads as, at a location whose direction is Alert-C positive. */
const DIRECTION: Readonly<Record<string, DirectionRef>> = {
  allDirections: { value: "both", basis: "text", text: "allDirections" },
  bothWays: { value: "both", basis: "text", text: "bothWays" },
  aligned: { value: "positive", basis: "alert_c" },
  opposite: { value: "negative", basis: "alert_c" },
  northBound: { value: "unknown", basis: "compass", compass: "N", text: "northBound" },
  northEastBound: { value: "unknown", basis: "compass", compass: "NE", text: "northEastBound" },
  eastBound: { value: "unknown", basis: "compass", compass: "E", text: "eastBound" },
  southEastBound: { value: "unknown", basis: "compass", compass: "SE", text: "southEastBound" },
  southBound: { value: "unknown", basis: "compass", compass: "S", text: "southBound" },
  southWestBound: { value: "unknown", basis: "compass", compass: "SW", text: "southWestBound" },
  westBound: { value: "unknown", basis: "compass", compass: "W", text: "westBound" },
  northWestBound: { value: "unknown", basis: "compass", compass: "NW", text: "northWestBound" },
  // Rings, towns and `other` have no axis a direction can hold: their words stay.
  clockwise: { value: "unknown", basis: "text", text: "clockwise" },
  anticlockwise: { value: "unknown", basis: "text", text: "anticlockwise" },
  innerRing: { value: "unknown", basis: "text", text: "innerRing" },
  outerRing: { value: "unknown", basis: "text", text: "outerRing" },
  inboundTowardsTown: { value: "unknown", basis: "text", text: "inboundTowardsTown" },
  outboundFromTown: { value: "unknown", basis: "text", text: "outboundFromTown" },
  other: { value: "unknown", basis: "text", text: "other" },
  unknown: { value: "unknown", basis: "unknown" },
};

describe.each(VERSIONS)(
  "DATEX II $label impact, roadworks and source",
  ({ version, label, vocab }) => {
    const delayed = (delays: string) =>
      parseRecord(version, {
        recordClass: "AbnormalTraffic",
        body: "<:abnormalTrafficType>queuingTraffic</:abnormalTrafficType>",
        impact: `<:delays>${delays}</:delays>`,
      });
    const delayEffect = (event: RoadEvent | undefined) =>
      event === undefined
        ? undefined
        : effectsAt(event).find((e): e is Extract<Effect, { kind: "delay" }> => e.kind === "delay");

    it("reads every delay band into the delay effect", () => {
      assertCovered(`${label} DelayBandEnum`, vocab.delayBands, {
        handled: (band) => {
          const { event, skipped } = delayed(`<:delayBand>${band}</:delayBand>`);
          const expected = entryOf(DATEX2_DELAY_BANDS, band);
          return (
            skipped.unknown_value === undefined &&
            expected !== undefined &&
            event?.delayBand === expected &&
            delayEffect(event)?.delayBand === expected
          );
        },
        unsupported: version === "v3" ? { _extended: `${EXTENDED}; the delay has no band` } : {},
      });
    });

    it("reads every delays type into the delay effect", () => {
      assertCovered(`${label} DelaysTypeEnum`, vocab.delaysTypes, {
        handled: (type) => {
          const { event, skipped } = delayed(`<:delaysType>${type}</:delaysType>`);
          const expected = entryOf(DATEX2_DELAY_TYPES, type);
          return (
            skipped.unknown_value === undefined &&
            expected !== undefined &&
            delayEffect(event)?.delayType === expected
          );
        },
        unsupported:
          version === "v3" ? { _extended: `${EXTENDED}; the delay has no description` } : {},
      });
    });

    it("keeps a delay's length, band and description together", () => {
      const { event } = delayed(
        "<:delayBand>betweenThirtyMinutesAndOneHour</:delayBand><:delaysType>longDelays</:delaysType><:delayTimeValue>2400</:delayTimeValue>",
      );
      expect(delayEffect(event)).toMatchObject({
        delay: { value: 2400, unit: "s" },
        delayBand: "between_thirty_minutes_and_one_hour",
        delayType: "long_delays",
      });
    });

    it("reads every traffic direction as the direction the measure applies in", () => {
      const location: DirectionRef = { value: "positive", basis: "alert_c" };
      assertCovered(`${label} DirectionEnum`, vocab.directions, {
        handled: (direction) => {
          const { event, skipped } = parseRecord(version, {
            recordClass: "RoadOrCarriagewayOrLaneManagement",
            body: closureBy(
              `<:complianceOption>mandatory</:complianceOption><:applicableForTrafficDirection>${direction}</:applicableForTrafficDirection>`,
            ),
          });
          const expected = DIRECTION[direction];
          return (
            event !== undefined &&
            skipped.unknown_value === undefined &&
            expected !== undefined &&
            effectsAt(event, location).every(
              (e) => JSON.stringify(e.direction) === JSON.stringify(expected),
            )
          );
        },
        unsupported:
          version === "v3"
            ? { _extended: `${EXTENDED}; the measure's direction reads as unknown` }
            : {},
      });
    });

    it("reads aligned and opposite as text where the location's direction has no axis", () => {
      const { event } = parseRecord(version, {
        recordClass: "RoadOrCarriagewayOrLaneManagement",
        body: closureBy(
          "<:complianceOption>mandatory</:complianceOption><:applicableForTrafficDirection>opposite</:applicableForTrafficDirection>",
        ),
      });
      expect(effectsAt(event!).map((e) => e.direction)).toEqual([
        { value: "unknown", basis: "text", text: "opposite" },
      ]);
      expect(
        effectsAt(event!, { value: "both", basis: "alert_c" }).map((e) => e.direction),
      ).toEqual([{ value: "unknown", basis: "text", text: "opposite" }]);
    });

    it("reads several traffic directions as one only when they agree", () => {
      const measure = (directions: string[]) =>
        parseRecord(version, {
          recordClass: "RoadOrCarriagewayOrLaneManagement",
          body: closureBy(
            `<:complianceOption>mandatory</:complianceOption>${directions
              .map((d) => `<:applicableForTrafficDirection>${d}</:applicableForTrafficDirection>`)
              .join("")}`,
          ),
        }).event!;
      expect(effectsAt(measure(["northBound", "southBound"]))[0]?.direction).toEqual({
        value: "unknown",
        basis: "text",
        text: "northBound southBound",
      });
      expect(effectsAt(measure(["northBound", "bothWays"]))[0]?.direction).toEqual({
        value: "both",
        basis: "text",
        text: "northBound bothWays",
      });
    });

    const duration = version === "v3" ? "roadworksDurationClassification" : "roadworksDuration";
    const works = (content: string) =>
      parseRecord(version, {
        recordClass: "MaintenanceWorks",
        body: `${content}<:roadMaintenanceType>roadworks</:roadMaintenanceType>`,
      });

    it("reads every roadworks scale", () => {
      assertCovered(`${label} RoadworksScaleEnum`, vocab.roadworksScales, {
        handled: (scale) => {
          const { event, skipped } = works(`<:roadworksScale>${scale}</:roadworksScale>`);
          return (
            skipped.unknown_value === undefined &&
            event?.roadworks?.scale !== undefined &&
            event.roadworks.scale === entryOf(DATEX2_ROADWORKS_SCALES, scale)
          );
        },
        unsupported: version === "v3" ? { _extended: `${EXTENDED}; the works have no scale` } : {},
      });
    });

    it("reads every roadworks duration", () => {
      assertCovered(`${label} RoadworksDurationEnum`, vocab.roadworksDurations, {
        handled: (value) => {
          const { event, skipped } = works(`<:${duration}>${value}</:${duration}>`);
          return (
            skipped.unknown_value === undefined &&
            event?.roadworks?.durationClass !== undefined &&
            event.roadworks.durationClass === entryOf(DATEX2_ROADWORKS_DURATIONS, value)
          );
        },
        unsupported:
          version === "v3" ? { _extended: `${EXTENDED}; the works have no duration class` } : {},
      });
    });

    it("reads whether works are urgent and under traffic, and counts a flag that is no boolean", () => {
      expect(
        works("<:underTraffic>true</:underTraffic><:urgentRoadworks>false</:urgentRoadworks>").event
          ?.roadworks,
      ).toEqual({ underTraffic: true, urgent: false });
      const unreadable = works("<:urgentRoadworks>yes</:urgentRoadworks>");
      expect(unreadable.event?.roadworks).toBeUndefined();
      expect(unreadable.skipped.unknown_value).toBe(1);
    });

    it("reads every source type as the informant's type", () => {
      assertCovered(`${label} SourceTypeEnum`, vocab.sourceTypes, {
        handled: (type) => {
          const { event, skipped } = parseRecord(version, {
            recordClass: "Accident",
            body: "<:accidentType>collision</:accidentType>",
            source: `<:sourceType>${type}</:sourceType>`,
          });
          return (
            skipped.unknown_value === undefined &&
            event?.situation?.informationSource?.type !== undefined &&
            event.situation.informationSource.type === entryOf(DATEX2_SOURCE_TYPES, type)
          );
        },
        unsupported:
          version === "v3" ? { _extended: `${EXTENDED}; the informant's type is not read` } : {},
      });
    });

    it("reads the informant's name, id, country and reliability", () => {
      const { event } = parseRecord(version, {
        recordClass: "Accident",
        body: "<:accidentType>collision</:accidentType>",
        source: `<:sourceCountry>nl</:sourceCountry><:sourceIdentification>RWS-12</:sourceIdentification><:sourceName><:values><:value lang="nl">Verkeerscentrale</:value></:values></:sourceName><:sourceType>policePatrol</:sourceType><:reliable>true</:reliable>`,
      });
      expect(event?.situation?.informationSource).toEqual({
        type: "police_patrol",
        name: [{ lang: "nl", text: "Verkeerscentrale" }],
        id: "RWS-12",
        country: "NL",
        reliable: true,
      });
    });

    it("reads lanes restricted fully or partially as restricted, never as closed", () => {
      const { event } = parseRecord(version, {
        recordClass: "RoadOrCarriagewayOrLaneManagement",
        body: "<:complianceOption>mandatory</:complianceOption><:roadOrCarriagewayOrLaneManagementType>narrowLanes</:roadOrCarriagewayOrLaneManagementType>",
        impact:
          "<:numberOfLanesRestricted>2</:numberOfLanesRestricted><:numberOfOperationalLanes>0</:numberOfOperationalLanes>",
      });
      const lanes = effectsAt(event!).find((e) => e.kind === "lane_restriction");
      // Two narrowed lanes and none fully operational is not a closed road.
      expect(lanes).toMatchObject({
        lanesTotal: 2,
        lanesRestricted: 2,
        lanesOperational: 0,
        vehicleImpact: "unknown",
      });
      expect(lanes).not.toHaveProperty("lanesClosed");
    });
  },
);

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
