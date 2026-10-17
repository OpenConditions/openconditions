import {
  type Effect,
  effectStateAt,
  lifecycleInForce,
  routingBlockers,
  type Validity,
} from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { parseEvents } from "../parse.js";
import {
  type DatexVersion,
  datexDocument,
  parseRecord,
  type RecordSpec,
} from "./helpers/datex-records.js";
import { roadFeed } from "./helpers/road-feed.js";

/**
 * What a DATEX record says about its measure and its timing, carried onto
 * the situation's effects: the operator action's status, compliance, the
 * traffic and places it applies to, the road a constriction blocks, the
 * remaining capacity, recurrences and their exceptions, and an overrun end.
 */
const FETCHED_AT = "2026-09-18T09:00:00.000Z";

function draftOf(version: DatexVersion, spec: RecordSpec) {
  const feed = roadFeed({ id: "xx-datex-measures" });
  const { situations } = parseEvents(feed, [Buffer.from(datexDocument(version, spec))], {
    fetchedAt: FETCHED_AT,
  });
  expect(situations).toHaveLength(1);
  const draft = situations[0]!;
  const validity = draft["validity"] as Validity;
  const effects = draft["effects"] as Effect[];
  return {
    validity,
    effects,
    of: (kind: string) => effects.find((e) => e.kind === kind),
    state: (effect: Effect | undefined, at: string) =>
      effect === undefined ? undefined : effectStateAt(effect, validity, new Date(at)).state,
  };
}

const management = (
  measure: string,
  type = "roadClosed",
): Pick<RecordSpec, "recordClass" | "body"> => ({
  recordClass: "RoadOrCarriagewayOrLaneManagement",
  body: `${measure}<:roadOrCarriagewayOrLaneManagementType>${type}</:roadOrCarriagewayOrLaneManagementType>`,
});
const MANDATORY = "<:complianceOption>mandatory</:complianceOption>";

describe.each(["v2", "v3"] as const)("DATEX %s measures", (version) => {
  it("carries the operator action status onto every effect", () => {
    for (const [status, routes] of [
      ["approved", false],
      ["implemented", true],
      ["terminationRequested", true],
    ] as const) {
      const { of } = draftOf(
        version,
        management(`<:operatorActionStatus>${status}</:operatorActionStatus>${MANDATORY}`),
      );
      const closure = of("closure")!;
      expect(closure.actionStatus).toBeDefined();
      expect(routingBlockers(closure).length === 0, status).toBe(routes);
    }
  });

  it("states an advisory measure as advisory", () => {
    const { of } = draftOf(version, {
      recordClass: "SpeedManagement",
      body: "<:complianceOption>advisory</:complianceOption><:speedManagementType>speedRestrictionInOperation</:speedManagementType><:temporarySpeedLimit>60</:temporarySpeedLimit>",
    });
    expect(of("speed_limit")).toMatchObject({ compliance: "advisory", advisory: true });
  });

  it("closes only the carriageway a carriageway closure names", () => {
    const { of } = draftOf(version, management(MANDATORY, "carriagewayClosures"));
    expect(of("closure")).toMatchObject({ scope: "carriageway" });
  });

  it("closes the road an unplanned event blocks", () => {
    const element = "<:trafficConstrictionType>roadBlocked</:trafficConstrictionType>";
    const { of } = draftOf(version, {
      recordClass: "Accident",
      ...(version === "v3"
        ? { body: `${element}<:accidentType>collision</:accidentType>` }
        : { impact: element, body: "<:accidentType>collision</:accidentType>" }),
    });
    expect(of("closure")).toMatchObject({ scope: "road", applicability: { kind: "all" } });
  });

  it("spares local access from a measure for through traffic only", () => {
    const { of } = draftOf(
      version,
      management(
        `${MANDATORY}<:applicableForTrafficType>throughTraffic</:applicableForTrafficType>`,
      ),
    );
    expect(of("closure")?.applicability).toEqual({
      kind: "all",
      except: [{ usage: "local_access" }],
      raw: ["applicableForTrafficType:throughTraffic"],
    });
  });

  it("never routes a measure for vehicles it cannot name as every vehicle", () => {
    const groups = {
      v3: "<:forVehiclesWithCharacteristicsOf><com:grossWeightCharacteristic><com:comparisonOperator>greaterThan</com:comparisonOperator><com:grossVehicleWeight>7.5</com:grossVehicleWeight><com:typeOfWeight>maximumPermitted</com:typeOfWeight></com:grossWeightCharacteristic></:forVehiclesWithCharacteristicsOf>",
      v2: "<:forVehiclesWithCharacteristicsOf><:grossWeightCharacteristic><:comparisonOperator>greaterThan</:comparisonOperator><:grossVehicleWeight>7.5</:grossVehicleWeight><:typeOfWeight>maximumPermitted</:typeOfWeight></:grossWeightCharacteristic></:forVehiclesWithCharacteristicsOf>",
    };
    const { of } = draftOf(version, management(`${MANDATORY}${groups[version]}`));
    const closure = of("closure")!;
    expect(closure.applicability).toMatchObject({ kind: "unknown" });
    expect(routingBlockers(closure)).toContain("applicability_unknown");
  });

  it("keeps a measure for some kinds of place partial", () => {
    const { of } = draftOf(
      version,
      management(`${MANDATORY}<:placesAtWhichApplicable>inTunnels</:placesAtWhichApplicable>`),
    );
    const closure = of("closure")!;
    expect(closure.normalization).toBe("partial");
    expect(routingBlockers(closure)).toContain("not_normalized");
  });

  it("states the remaining capacity on the delay", () => {
    const { of } = draftOf(version, {
      recordClass: "Accident",
      body: "<:accidentType>collision</:accidentType>",
      impact: "<:capacityRemaining>40</:capacityRemaining>",
    });
    expect(of("delay")).toMatchObject({ capacityRemainingPct: 40 });
  });

  it("applies a weekday recurrence on its days only, outside its exceptions", () => {
    // 2026-09-21 is a Monday, 2026-09-22 a Tuesday; noon in Amsterdam.
    const { validity, of, state } = draftOf(version, {
      ...management(MANDATORY),
      timeSpec:
        "<:validPeriod><:recurringDayWeekMonthPeriod><:applicableDay>monday</:applicableDay></:recurringDayWeekMonthPeriod></:validPeriod>" +
        "<:exceptionPeriod><:startOfPeriod>2026-09-28T00:00:00+02:00</:startOfPeriod><:endOfPeriod>2026-09-29T00:00:00+02:00</:endOfPeriod></:exceptionPeriod>",
    });
    expect(validity.periods).toEqual([
      expect.objectContaining({ byDay: ["MO"], scheduleTimezone: "Europe/Amsterdam" }),
    ]);
    expect(validity.exceptions).toHaveLength(1);
    const closure = of("closure");
    expect(state(closure, "2026-09-21T10:00:00Z")).toBe("active");
    expect(state(closure, "2026-09-22T10:00:00Z")).toBe("scheduled");
    expect(state(closure, "2026-09-28T10:00:00Z")).toBe("scheduled");
  });

  it("leaves a recurrence it cannot carry unknown instead of continuous", () => {
    const special =
      version === "v3"
        ? "<:recurringSpecialDay><:intersectWithApplicableDays>false</:intersectWithApplicableDays><:specialDayType>publicHoliday</:specialDayType></:recurringSpecialDay>"
        : "<:recurringDayWeekMonthPeriod><:applicableWeek>firstWeekOfMonth</:applicableWeek></:recurringDayWeekMonthPeriod>";
    const { of, state } = draftOf(version, {
      ...management(MANDATORY),
      timeSpec: `<:validPeriod>${special}</:validPeriod>`,
    });
    const closure = of("closure")!;
    expect(closure.issues).toContainEqual(
      expect.objectContaining({ code: "unsupported_schedule" }),
    );
    expect(state(closure, FETCHED_AT)).toBe("unknown");
  });

  it("keeps an overrun record in force past the end it planned", () => {
    const { validity, of, state } = draftOf(version, {
      ...management(MANDATORY),
      overrunning: "<:overrunning>true</:overrunning>",
      timeSpec: "<:overallEndTime>2026-09-18T08:00:00Z</:overallEndTime>",
    });
    expect(validity.end).toBeUndefined();
    expect(validity.estimatedEnd).toBe("2026-09-18T08:00:00Z");
    expect(lifecycleInForce(validity)).toBe(true);
    expect(state(of("closure"), FETCHED_AT)).toBe("active");
  });
});

describe.each(["v2", "v3"] as const)("DATEX %s tokens the tables do not name", (version) => {
  // Inherited object keys are not table entries: each must take the path of
  // any other value outside the enumeration.
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "reads %s as no action status, constriction or road state",
    (token) => {
      const action = parseRecord(version, {
        ...management(`<:operatorActionStatus>${token}</:operatorActionStatus>${MANDATORY}`),
      });
      expect(action.event?.situation?.actionStatus).toBeUndefined();
      expect(action.event?.situation?.effectIssues).toContainEqual(
        expect.objectContaining({ code: "unsupported_status" }),
      );
      expect(action.skipped.unknown_value).toBe(1);

      const element = `<:trafficConstrictionType>${token}</:trafficConstrictionType>`;
      const blocked = parseRecord(version, {
        recordClass: "Accident",
        ...(version === "v3"
          ? { body: `${element}<:accidentType>collision</:accidentType>` }
          : { impact: element, body: "<:accidentType>collision</:accidentType>" }),
      });
      expect(blocked.event?.roadState).toBeUndefined();
      expect(blocked.skipped.unknown_value).toBe(1);

      const managed = parseRecord(version, management(MANDATORY, token));
      expect(managed.event?.roadState).toBeUndefined();
    },
  );

  it.each([
    ["an inherited key", "<:applicableDay>constructor</:applicableDay>"],
    ["an inherited month key", "<:applicableMonth>toString</:applicableMonth>"],
    [
      "one unreadable day among readable ones",
      "<:applicableDay>monday</:applicableDay><:applicableDay>funday</:applicableDay>",
    ],
    [
      "one unreadable month among readable ones",
      "<:applicableMonth>may</:applicableMonth><:applicableMonth>maytember</:applicableMonth>",
    ],
  ])("leaves a recurrence naming %s unknown, never narrowed", (_label, days) => {
    const { of, state } = draftOf(version, {
      ...management(MANDATORY),
      timeSpec: `<:validPeriod><:recurringDayWeekMonthPeriod>${days}</:recurringDayWeekMonthPeriod></:validPeriod>`,
    });
    const closure = of("closure")!;
    expect(closure.issues).toContainEqual(
      expect.objectContaining({
        code: "unsupported_schedule",
        sourceTokens: { unsupportedFields: ["recurringDayWeekMonthPeriod"] },
      }),
    );
    expect(state(closure, FETCHED_AT)).toBe("unknown");
  });
});
