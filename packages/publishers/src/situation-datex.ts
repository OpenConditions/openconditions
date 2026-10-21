import { scheduleTimezoneForGeometry } from "@openconditions/core";
import {
  type DirectionRef,
  type Effect,
  type InformationSource,
  isoDurationToMs,
  type Schedule,
  type SituationClass,
  situationEffects,
  type Validity,
  zonedWallClockToInstant,
} from "@openconditions/model";
import {
  DATEX2_CAUSE_TYPES,
  DATEX2_FAULTY_EQUIPMENT,
  DATEX2_RECORDS,
  datexDiscriminator,
} from "@openconditions/model-roads";
import { type ExportDiagnosticSink, ProjectionDiagnostics } from "./export-diagnostics.js";
import {
  definesManagementNature,
  omittedPath,
  type ProjectionEffect,
  projectionEffects,
  projectionStateAt,
  sameInterval,
} from "./export-validity.js";
import type { FeedInfo } from "./types.js";
import { buildXmlDocument } from "./xml.js";

type Rec = Record<string, unknown>;
type Text = { lang: string; text: string }[];

/**
 * DATEX II v3 SituationPublication emitter over situations. Spec:
 * https://docs.datex2.eu/ (v3 modular schemas: messageContainer / situation /
 * common / locationReferencing). Hand-built with fast-xml-parser, mirroring
 * the reader in `@openconditions/roads`.
 *
 * One `situation` per situation: a record for its nature (`DATEX2_RECORDS`),
 * then one record per effect in force or scheduled that DATEX has a
 * management record for (closures, lane restrictions, contraflow, speed
 * limits, diversions). An effect whose record would repeat the nature record
 * is folded into it; a nature without a record of its own leads with its first
 * effect's. A record keeps the DATEX id it was read from (`sourceRecordRef`),
 * else `<situation id>#<effect id>`. Every record states the situation's
 * probability; severity, the informant, the cause and headline travel on its
 * leading record. A delay (its length, band, description, queue and remaining
 * capacity) supplements that record only when its timing and place agree.
 *
 * The output validates against the base DATEX II v3.7 schemas inside an
 * Exchange 2020 `messageContainer`, but it is NOT SRTI-profile-conformant
 * and NOT NAP-publication-ready — see `docs/datex-conformance.md`. A line is
 * a linear location, a place a location table gave is its Alert-C point, and
 * any other geometry is reduced to a representative point; the publication
 * creator carries one feed-level country.
 *
 * DATEX output cannot carry an effect's vehicle conditions faithfully, so a
 * situation with any vehicle-specific effect, or one that is restriction
 * evidence, is left out rather than exported with a changed meaning.
 */

const SEVERITY: Readonly<Record<string, string>> = {
  none: "none",
  minor: "low",
  moderate: "medium",
  major: "high",
  critical: "highest",
};

/** A table's own entry for a key; an inherited key such as `constructor` is none. */
function ownEntry<T>(table: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * A severity as DATEX `severity`: its label's value, or DATEX's own `unknown`
 * where a source declared it unknown. A severity nobody stated is not written.
 */
function severityOf(severity: Rec | undefined): string | undefined {
  const label = String(severity?.["label"]);
  if (label === "unknown") return severity?.["declaredRaw"] !== undefined ? "unknown" : undefined;
  return ownEntry(SEVERITY, label);
}

/**
 * v3 dropped v2's `improbable`; it travels as an extended value. The record
 * must state a probability, so one nobody stated is an extended `unknown`
 * rather than a guess.
 */
const PROBABILITY: Readonly<Record<string, string | Rec>> = {
  observed: "certain",
  likely: "probable",
  possible: "riskOf",
  unlikely: extended("improbable"),
  unknown: extended("unknown"),
};

const COMPLIANCE: Readonly<Record<string, string | Rec>> = {
  mandatory: "mandatory",
  advisory: "advisory",
  unknown: extended("unknown"),
};

/** Record classes deriving from `NetworkManagement`, which must state their compliance. */
const NETWORK_MANAGEMENT = new Set([
  "GeneralInstructionOrMessageToRoadUsers",
  "GeneralNetworkManagement",
  "ReroutingManagement",
  "RoadOrCarriagewayOrLaneManagement",
  "SpeedManagement",
  "WinterDrivingManagement",
]);

/** Record classes deriving from `OperatorAction`, which may state the action's status. */
const OPERATOR_ACTIONS = new Set([
  ...NETWORK_MANAGEMENT,
  "ConstructionWorks",
  "MaintenanceWorks",
  "RoadsideAssistance",
]);

/** The kernel's action statuses as `OperatorActionStatusEnum`. */
const ACTION_STATUS: Readonly<Record<NonNullable<Effect["actionStatus"]>, string>> = {
  requested: "requested",
  approved: "approved",
  being_implemented: "beingImplemented",
  implemented: "implemented",
  rejected: "rejected",
  termination_requested: "terminationRequested",
  being_terminated: "beingTerminated",
};

/**
 * The `ValidityStatusEnum` value of a lifecycle. The kernel's `active` leaves
 * the window to decide, which is DATEX `definedByValidityTimeSpec`; DATEX
 * `active` would hold the record in force "regardless of the definition of the
 * validity time specification", even before the start or after the end it
 * exports. `planned` and `suspended` are DATEX's own.
 */
const VALIDITY_STATUS: Readonly<Partial<Record<Validity["status"], string>>> = {
  active: "definedByValidityTimeSpec",
  planned: "planned",
  suspended: "suspended",
};

const CLOSURE_BY_SCOPE: Readonly<Record<string, string>> = {
  carriageway: "carriagewayClosures",
};

/** A DATEX enumeration value outside the schema's list. */
function extended(value: string): Rec {
  return { "@__extendedValue": value, "#text": "_extended" };
}

/** The `Class:discriminator` code DATEX has for an effect, if any. */
function effectCode(effect: Effect): string | undefined {
  switch (effect.kind) {
    case "closure":
      return `RoadOrCarriagewayOrLaneManagement:${CLOSURE_BY_SCOPE[effect.scope] ?? "roadClosed"}`;
    case "lane_restriction":
      if (effect.vehicleImpact === "all_lanes_closed") {
        return "RoadOrCarriagewayOrLaneManagement:roadClosed";
      }
      // A lane closure measure with every lane open states no lane restricted,
      // as the publishers who report one write it.
      if (effect.vehicleImpact === "all_lanes_open") {
        return "RoadOrCarriagewayOrLaneManagement:laneClosures";
      }
      // Lanes restricted in a way no one states, none of them known closed,
      // are managed lanes, not lane closures.
      return effect.vehicleImpact === "unknown" && !((effect.lanesClosed ?? 0) > 0)
        ? "RoadOrCarriagewayOrLaneManagement:other"
        : "RoadOrCarriagewayOrLaneManagement:laneClosures";
    case "contraflow":
      return "RoadOrCarriagewayOrLaneManagement:contraflow";
    case "speed_limit":
      return "SpeedManagement:speedRestrictionInOperation";
    case "detour":
      return "ReroutingManagement:followDiversionSigns";
    default:
      return undefined;
  }
}

/**
 * Nature records the reader takes as closing the road themselves: a movable
 * bridge open to shipping, traffic held. A closure of the whole road at the
 * situation's place is what they already say.
 */
const CLOSING_NATURES = new Set([
  "GeneralNetworkManagement:bridgeSwingInOperation",
  "GeneralNetworkManagement:trafficHeld",
]);

function closedByNature(effect: Effect, natureCode: string | undefined): boolean {
  return (
    natureCode !== undefined &&
    CLOSING_NATURES.has(natureCode) &&
    effect.kind === "closure" &&
    effect.scope === "road"
  );
}

/** Whether two values of the model say the same: a direction, a place, a text. */
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether the DATEX location of a place states its direction: a point's
 * bearing, or the direction of its Alert-C point.
 */
function statesDirection(location: Rec): boolean {
  const geometry = location["geometry"] as { type?: string } | undefined;
  if (geometry?.type === "LineString") return false;
  const direction = location["direction"] as DirectionRef | undefined;
  return (
    (direction?.basis === "alert_c" && alertCOf(location, false) !== undefined) ||
    (direction?.basis === "bearing" &&
      direction.bearingDeg !== undefined &&
      representativePoint(geometry) !== null)
  );
}

/**
 * What an effect says about the record's impact: its lanes. DATEX counts the
 * lanes restricted fully or partially, so closed lanes are restricted ones
 * where no count of restricted lanes is known, none where every lane is open,
 * and the lanes that remain fully operational as stated. The total travels
 * with the location's carriageway.
 */
function effectImpact(effect: Effect): Rec {
  if (effect.kind !== "lane_restriction") return {};
  const impact: Rec = {};
  const restricted =
    effect.lanesRestricted ??
    effect.lanesClosed ??
    (effect.vehicleImpact === "all_lanes_open" ? 0 : undefined);
  if (restricted !== undefined) impact["sit:numberOfLanesRestricted"] = restricted;
  if (effect.lanesOperational !== undefined) {
    impact["sit:numberOfOperationalLanes"] = effect.lanesOperational;
  }
  return impact;
}

/**
 * What an effect adds after its record's discriminator: a speed, or a
 * diversion's description and route.
 */
function effectDetail(effect: Effect): Rec {
  if (effect.kind === "speed_limit") return { "sit:temporarySpeedLimit": effect.limit.value };
  if (effect.kind !== "detour") return {};
  const route = effect.geometry?.type === "LineString" ? effect.geometry.coordinates : undefined;
  return {
    ...(effect.description?.length
      ? { "sit:reroutingItineraryDescription": multilingual(effect.description) }
      : {}),
    ...(route
      ? {
          "sit:alternativeRoute": {
            "@_xsi:type": "loc:ItineraryByIndexedLocations",
            "loc:locationContainedInItinerary": {
              "@_index": 0,
              "loc:location": {
                "@_xsi:type": "loc:LinearLocation",
                "loc:gmlLineString": { "loc:posList": posList(route as [number, number][]) },
              },
            },
          },
        }
      : {}),
  };
}

/** A DATEX `MultilingualString`: every language of a text. */
function multilingual(text: Text): Rec {
  return {
    "com:values": { "com:value": text.map((t) => ({ "@_lang": t.lang, "#text": t.text })) },
  };
}

/** GML coordinates as DATEX writes them: latitude before longitude. */
const posList = (coordinates: readonly [number, number][]) =>
  coordinates.map(([lon, lat]) => `${lat} ${lon}`).join(" ");

/** First coordinate of any geometry, as [lon, lat]. */
function representativePoint(geometry: unknown): [number, number] | null {
  const g = geometry as { type?: string; coordinates?: unknown; geometries?: unknown[] } | null;
  if (g?.type === "GeometryCollection") {
    for (const part of g.geometries ?? []) {
      const found = representativePoint(part);
      if (found) return found;
    }
    return null;
  }
  let c: unknown = g?.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number"
    ? [c[0], c[1]]
    : null;
}

/** A road's name, plain in `roadInformation`, so only its first language. */
const roadName = (road: Rec) => (road["name"] as Text | undefined)?.[0];

type AlertC = { country: string; table: number; version?: string; code: number } & Rec;

/**
 * An Alert-C table number and version as the reader takes them back. A table
 * published with its edition ("6.13" version "A", NDW) is kept as table 6 of
 * version "6.13.A", so that version splits back into the two; any other
 * version is the table's own.
 */
function alertCTable(tmc: AlertC & { version: string }): { table: string; version: string } {
  const [, table, version] = /^(\d+\.\d+)\.(.+)$/.exec(tmc.version) ?? [];
  return table !== undefined && version !== undefined && Math.trunc(Number(table)) === tmc.table
    ? { table, version }
    : { table: String(tmc.table), version: tmc.version };
}

/** The TMC direction bit as DATEX `alertCDirectionCoded`. */
const CODED_DIRECTION = ["positive", "negative"] as const;

/**
 * The location's Alert-C reference, when DATEX can state it: a point on a
 * point location, a primary and secondary location on a linear one, of a
 * named table edition, with the direction along the table's axis an Alert-C
 * reference must state (its own, else the place's Alert-C direction), and,
 * by method 4, the whole metres each lies from its location. An extent, a
 * second location on a point or none on a line say what the reference cannot.
 */
function alertCOf(location: Rec, linear: boolean): Rec | undefined {
  const tmc = location["tmc"] as AlertC | undefined;
  if (tmc?.version === undefined || tmc["extent"] !== undefined) return undefined;
  const place = location["direction"] as DirectionRef | undefined;
  const coded =
    typeof tmc["direction"] === "number"
      ? CODED_DIRECTION[tmc["direction"]]
      : place?.basis === "alert_c" && (place.value === "positive" || place.value === "negative")
        ? place.value
        : undefined;
  const secondary = tmc["secondary"] as number | undefined;
  if (coded === undefined || linear !== (secondary !== undefined)) return undefined;
  const offsets = [tmc["primaryOffsetM"], ...(linear ? [tmc["secondaryOffsetM"]] : [])];
  const method = tmc["method"] ?? (offsets.some((o) => o !== undefined) ? 4 : 2);
  if (method === 4 && !offsets.every((o) => Number.isSafeInteger(o))) return undefined;
  if (method === 2 && offsets.some((o) => o !== undefined)) return undefined;
  const { table, version } = alertCTable(tmc as AlertC & { version: string });
  const at = (code: number, offset: unknown) => ({
    "loc:alertCLocation": { "loc:specificLocation": code },
    ...(method === 4 ? { "loc:offsetDistance": { "loc:offsetDistance": offset } } : {}),
  });
  return {
    "@_xsi:type": `loc:AlertCMethod${method}${linear ? "Linear" : "Point"}`,
    "loc:alertCLocationCountryCode": tmc.country,
    "loc:alertCLocationTableNumber": table,
    "loc:alertCLocationTableVersion": version,
    "loc:alertCDirection": {
      "loc:alertCDirectionCoded": coded,
      "loc:alertCAffectedDirection": tmc["affectedDirection"] ?? "unknown",
    },
    [`loc:alertCMethod${method}PrimaryPointLocation`]: at(tmc.code, tmc["primaryOffsetM"]),
    ...(linear
      ? {
          [`loc:alertCMethod${method}SecondaryPointLocation`]: at(
            secondary as number,
            tmc["secondaryOffsetM"],
          ),
        }
      : {}),
  };
}

/** Whether DATEX states a place a location table gave as the table reference it came from. */
export function datexStatesTablePlace(location: Rec | undefined): boolean {
  return location?.["geometryOrigin"] === "tmc_table" && alertCOf(location, false) !== undefined;
}

/**
 * A place as a DATEX location: a line as a linear location of its GML
 * coordinates, a place a location table gave as its Alert-C point alone (the
 * reader looks it up again), anything else as a point at its first
 * coordinate, with its bearing and its Alert-C point where it has them.
 * External location codes, the lanes of the carriageway (`lanesTotal`) and
 * the roads travel with it.
 */
function buildLocation(
  location: Rec,
  diagnostics: ProjectionDiagnostics,
  path: string,
  effect?: Effect,
  directionPath = path,
  lanesTotal?: number,
): Rec {
  const geometry = location["geometry"] as { type?: string; coordinates?: unknown } | undefined;
  const line =
    geometry?.type === "LineString" ? (geometry.coordinates as [number, number][]) : undefined;
  const alertC = alertCOf(location, line !== undefined);
  const direction = location["direction"] as DirectionRef | undefined;
  const loc: Rec = {
    "@_xsi:type": line
      ? alertC
        ? "loc:SingleRoadLinearLocation"
        : "loc:LinearLocation"
      : "loc:PointLocation",
  };
  const external = (location["external"] as { system: string; code: string }[] | undefined) ?? [];
  if (external.length > 0) {
    loc["loc:externalReferencing"] = external.map((e) => ({
      "loc:externalLocationCode": e.code,
      "loc:externalReferencingSystem": e.system,
    }));
  }
  const roads = ((location["roads"] as Rec[] | undefined) ?? []).flatMap((road) => {
    const info: Rec = {};
    const name = roadName(road)?.text;
    if (name) info["loc:roadName"] = name;
    if (typeof road["ref"] === "string") info["loc:roadNumber"] = road["ref"];
    return Object.keys(info).length > 0 ? [info] : [];
  });
  const supplementary: Rec = {
    ...(lanesTotal !== undefined
      ? {
          "loc:carriageway": {
            "loc:carriageway": "unspecifiedCarriageway",
            "loc:originalNumberOfLanes": lanesTotal,
          },
        }
      : {}),
    ...(roads.length > 0 ? { "loc:roadInformation": roads } : {}),
  };
  if (Object.keys(supplementary).length > 0) {
    loc["loc:supplementaryPositionalDescription"] = supplementary;
  }
  let bearing = false;
  if (line) {
    loc["loc:gmlLineString"] = { "loc:posList": posList(line) };
  } else if (!(alertC && location["geometryOrigin"] === "tmc_table")) {
    const pt = representativePoint(geometry);
    if (pt) {
      if (geometry?.type !== "Point")
        diagnostics.emit(
          "geometry_to_point",
          "field",
          "reduced",
          `${path}/geometry`,
          "DATEX exports this geometry as its first representative coordinate only.",
          effect,
        );
      const bearingDeg = direction?.basis === "bearing" ? direction.bearingDeg : undefined;
      bearing = bearingDeg !== undefined;
      loc["loc:pointByCoordinates"] = {
        ...(bearingDeg !== undefined ? { "loc:bearing": bearingDeg } : {}),
        "loc:pointCoordinates": { "loc:latitude": pt[1], "loc:longitude": pt[0] },
      };
    }
  }
  // A line whose Alert-C reference is a point: the line, then the point, as
  // the publishers who place a line by a point code write them. The
  // itinerary is no location of its own, so it holds no external codes.
  const pointOnLine =
    line && !alertC && external.length === 0 ? alertCOf(location, false) : undefined;
  let reference: Rec = loc;
  if (alertC) loc[line ? "loc:alertCLinear" : "loc:alertCPoint"] = alertC;
  else if (pointOnLine)
    reference = {
      "@_xsi:type": "loc:ItineraryByIndexedLocations",
      "loc:locationContainedInItinerary": [
        { "@_index": 0, "loc:location": loc },
        {
          "@_index": 1,
          "loc:location": { "@_xsi:type": "loc:PointLocation", "loc:alertCPoint": pointOnLine },
        },
      ],
    };
  else if (location["tmc"] !== undefined)
    diagnostics.emit(
      "field_not_exported",
      "field",
      "omitted",
      `${path}/tmc`,
      "An Alert-C reference needs its table edition, a direction along the table's axis, a second location on a line and none on a point, whole-metre offsets for method 4, and no extent.",
      effect,
    );
  if (direction !== undefined && !bearing && !(alertC && direction.basis === "alert_c" && !line))
    diagnostics.emit(
      "direction_not_exported",
      "field",
      "omitted",
      `${directionPath}/direction`,
      "DATEX states a location's direction as a point's bearing or an Alert-C direction; this location has neither.",
      effect,
    );
  return reference;
}

/**
 * DATEX requires a start; without a declared one, the record is valid from
 * `since`, its version time, the earliest moment it is known to hold.
 */
function buildValidity(validity: Validity, since: string, geometry: unknown): Rec {
  const spec: Rec = { "com:overallStartTime": validity.start ?? since };
  if (validity.end) spec["com:overallEndTime"] = validity.end;
  const zone = scheduleTimezoneForGeometry(
    geometry as Parameters<typeof scheduleTimezoneForGeometry>[0],
  );
  const periods = (schedules: Schedule[] | undefined) =>
    (schedules ?? [])
      .map((s) => periodOf(s, zone, validity.end === undefined))
      .filter((p): p is Rec => p !== undefined);
  const valid = periods(validity.periods);
  const exceptions = periods(validity.exceptions);
  if (valid.length > 0) spec["com:validPeriod"] = valid;
  if (exceptions.length > 0) spec["com:exceptionPeriod"] = exceptions;
  return {
    "com:validityStatus": VALIDITY_STATUS[validity.status] ?? "definedByValidityTimeSpec",
    "com:validityTimeSpecification": spec,
  };
}

/** iCal day codes and month numbers as DATEX `DayEnum` and `MonthOfYearEnum` values. */
const DAY_NAMES: Readonly<Record<string, string>> = {
  MO: "monday",
  TU: "tuesday",
  WE: "wednesday",
  TH: "thursday",
  FR: "friday",
  SA: "saturday",
  SU: "sunday",
};
const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** A local `HH:MM[:SS]` as an `xs:time`, else undefined. */
function timeOfDay(value: string | undefined): string | undefined {
  const m = value === undefined ? null : /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  return m ? `${m[1]}:${m[2]}:${m[3] ?? "00"}` : undefined;
}

/** The length from one local time of day to the next, past midnight when it ends earlier. */
function dayPeriodLength(start: string, end: string): string {
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let length = minutes(end) - minutes(start);
  if (length <= 0) length += 24 * 60;
  const [h, m] = [Math.floor(length / 60), length % 60];
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}`;
}

/**
 * A schedule as a DATEX `Period`, or undefined when DATEX cannot state it as
 * the reader takes it back. DATEX writes a period's times of day without a
 * zone, and the reader places them in the zone of the record's location, so a
 * schedule in any other zone cannot be stated. One window (a start and a
 * length) is its start and end instants; a daily or weekly recurrence is its
 * times of day, days and months, within its first and last day.
 */
/** The local date after `date`. */
const nextDay = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

function periodOf(s: Schedule, zone: string | null, openEnded: boolean): Rec | undefined {
  if (
    s.scheduleTimezone !== zone ||
    s.repeatCount !== undefined ||
    s.byMonthDay !== undefined ||
    s.exceptDate !== undefined
  )
    return undefined;
  const at = (date: string, time: string) =>
    zonedWallClockToInstant(s.scheduleTimezone, `${date}T${time}`);
  const start = timeOfDay(s.startTime);
  if (s.repeatFrequency === undefined) {
    const length = isoDurationToMs(s.duration);
    const from = s.startDate !== undefined && start ? at(s.startDate, start) : null;
    if (
      from === null ||
      !length ||
      s.endDate !== s.startDate ||
      s.endTime !== undefined ||
      s.byDay !== undefined ||
      s.byMonth !== undefined
    )
      return undefined;
    return {
      "com:startOfPeriod": from.toISOString(),
      "com:endOfPeriod": new Date(from.getTime() + length).toISOString(),
    };
  }
  // Days overlapping from a start, which the reader makes of a period that
  // only starts, in a validity that does not end: the time from then on.
  if (
    s.repeatFrequency === "P1D" &&
    s.duration === "PT25H" &&
    openEnded &&
    s.startDate !== undefined &&
    start !== undefined &&
    s.endDate === undefined &&
    s.endTime === undefined &&
    s.byDay === undefined &&
    s.byMonth === undefined
  ) {
    const from = at(s.startDate, start);
    return from === null ? undefined : { "com:startOfPeriod": from.toISOString() };
  }
  const weekly = s.repeatFrequency === "P1W";
  if ((!weekly && s.repeatFrequency !== "P1D") || weekly !== (s.byDay !== undefined))
    return undefined;
  if (start === undefined && (s.startTime ?? s.endTime ?? s.duration) !== undefined)
    return undefined;
  if (start === undefined && s.byDay === undefined && s.byMonth === undefined) return undefined;
  const end = start === undefined ? undefined : timeOfDay(s.endTime);
  // The reader takes an occurrence's length from its times of day.
  if (
    start !== undefined &&
    (end === undefined ||
      (s.duration ?? dayPeriodLength(start, end)) !== dayPeriodLength(start, end))
  )
    return undefined;
  const days = (s.byDay ?? []).map((d) => ownEntry(DAY_NAMES, d));
  const months = (s.byMonth ?? []).map((m) => MONTH_NAMES[m - 1]);
  if (days.some((d) => d === undefined) || months.some((m) => m === undefined)) return undefined;
  // The period runs from the start of its first occurrence to the end of its
  // last, so neither bound cuts an occurrence short.
  const first = s.startDate === undefined ? null : at(s.startDate, start ?? "00:00:00");
  const last =
    s.endDate === undefined
      ? null
      : start === undefined || end === undefined
        ? at(nextDay(s.endDate), "00:00:00")
        : at(end <= start ? nextDay(s.endDate) : s.endDate, end);
  if ((s.startDate !== undefined && first === null) || (s.endDate !== undefined && last === null))
    return undefined;
  return {
    ...(first ? { "com:startOfPeriod": first.toISOString() } : {}),
    ...(last ? { "com:endOfPeriod": last.toISOString() } : {}),
    ...(start !== undefined
      ? {
          "com:recurringTimePeriodOfDay": {
            "com:startTimeOfPeriod": start,
            "com:endTimeOfPeriod": end,
          },
        }
      : {}),
    ...(days.length > 0 || months.length > 0
      ? {
          "com:recurringDayWeekMonthPeriod": {
            ...(days.length > 0 ? { "com:applicableDay": days } : {}),
            ...(months.length > 0 ? { "com:applicableMonth": months } : {}),
          },
        }
      : {}),
  };
}

/** Whether DATEX states every period and exception of a validity at a place in `geometry`. */
export function datexStatesTiming(validity: Validity, geometry: unknown): boolean {
  const zone = scheduleTimezoneForGeometry(
    geometry as Parameters<typeof scheduleTimezoneForGeometry>[0],
  );
  return [...(validity.periods ?? []), ...(validity.exceptions ?? [])].every(
    (s) => periodOf(s, zone, validity.end === undefined) !== undefined,
  );
}

/** A public comment: its text and, where it says what it is, its DATEX `commentType`. */
interface Comment {
  text: Text;
  type?: string;
}

function comment({ text, type }: Comment): Rec {
  return {
    "sit:comment": multilingual(text),
    ...(type !== undefined ? { "sit:commentType": type } : {}),
  };
}

interface RecordHeader {
  id: string;
  version: string;
  time: string;
  probability: string | Rec;
}

interface RecordBody {
  validity: Validity;
  location: Rec;
  /** The geometry of the record's place, whose zone the reader reads its periods' times of day in. */
  geometry: unknown;
  /**
   * What only the leading record carries: severity, the informant, the cause,
   * and the public comments (the headline, then the description and any
   * other comment).
   */
  lead?: {
    severity?: string;
    source?: Rec;
    cause?: string;
    comments: Comment[];
  };
  impact?: Rec;
  /** A delay's supplement to the leading record: its impact and, on abnormal traffic, its queue. */
  supplement?: DelaySupplement;
  compliance?: string;
  actionStatus?: Effect["actionStatus"];
  /** A network management measure's `applicableForTrafficDirection`. */
  trafficDirection?: string;
  /** What roadworks say of the works before their discriminator. */
  works?: Rec;
  detail?: Rec;
}

/** Record classes deriving from `Roadworks`. */
const ROADWORKS = new Set(["ConstructionWorks", "MaintenanceWorks"]);

/**
 * A record of `code` (`Class` or `Class:discriminator`) in schema order: the
 * situation record's elements up to its location, then the class's own —
 * an operator action's status, compliance and the traffic direction for
 * network management, the works' own elements for roadworks, the
 * discriminator and `detail`.
 */
function record(code: string, header: RecordHeader, body: RecordBody): Rec {
  const [cls, value] = code.split(":") as [string, string | undefined];
  const discriminator = datexDiscriminator(cls);
  const { lead, supplement } = body;
  const impact: Rec = {
    ...(supplement?.capacity !== undefined ? { "sit:capacityRemaining": supplement.capacity } : {}),
    ...body.impact,
    ...(supplement?.delays !== undefined ? { "sit:delays": supplement.delays } : {}),
  };
  return {
    "@_xsi:type": `sit:${cls}`,
    "@_id": header.id,
    "@_version": header.version,
    "sit:situationRecordCreationTime": header.time,
    "sit:situationRecordVersionTime": header.time,
    "sit:probabilityOfOccurrence": header.probability,
    ...(lead?.severity ? { "sit:severity": lead.severity } : {}),
    ...(lead?.source ? { "sit:source": lead.source } : {}),
    "sit:validity": buildValidity(body.validity, header.time, body.geometry),
    ...(Object.keys(impact).length > 0 ? { "sit:impact": impact } : {}),
    ...(lead?.cause ? { "sit:cause": { "sit:causeType": lead.cause } } : {}),
    ...(lead?.comments.length ? { "sit:generalPublicComment": lead.comments.map(comment) } : {}),
    "sit:locationReference": body.location,
    ...(OPERATOR_ACTIONS.has(cls) && body.actionStatus !== undefined
      ? { "sit:operatorActionStatus": ACTION_STATUS[body.actionStatus] }
      : {}),
    ...(NETWORK_MANAGEMENT.has(cls)
      ? {
          "sit:complianceOption": COMPLIANCE[body.compliance ?? "unknown"] ?? COMPLIANCE["unknown"],
          ...(body.trafficDirection !== undefined
            ? { "sit:applicableForTrafficDirection": body.trafficDirection }
            : {}),
        }
      : {}),
    ...(ROADWORKS.has(cls) ? body.works : {}),
    ...(value && discriminator ? { [`sit:${discriminator}`]: value } : {}),
    ...body.detail,
    ...(cls === "AbnormalTraffic" && supplement?.queueLength !== undefined
      ? { "sit:queueLength": supplement.queueLength }
      : {}),
  };
}

/** The kernel's delay bands, delay types and roadworks duration classes, as DATEX writes them. */
const DELAY_BAND: Readonly<Record<string, string>> = {
  negligible: "negligible",
  up_to_ten_minutes: "upToTenMinutes",
  between_ten_minutes_and_thirty_minutes: "betweenTenMinutesAndThirtyMinutes",
  between_thirty_minutes_and_one_hour: "betweenThirtyMinutesAndOneHour",
  between_one_hour_and_three_hours: "betweenOneHourAndThreeHours",
  between_three_hours_and_six_hours: "betweenThreeHoursAndSixHours",
  longer_than_six_hours: "longerThanSixHours",
};
const DELAYS_TYPE: Readonly<Record<string, string>> = {
  delays: "delays",
  delays_of_uncertain_duration: "delaysOfUncertainDuration",
  long_delays: "longDelays",
  very_long_delays: "veryLongDelays",
};
const ROADWORKS_DURATION: Readonly<Record<string, string>> = {
  long_term: "longTerm",
  medium_term: "mediumTerm",
  short_term: "shortTerm",
};
/** snake_case → camelCase, which is how the kernel's informant types derive from DATEX's. */
const camelCase = (token: string) => token.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** What a delay effect adds to the leading record. */
interface DelaySupplement {
  /** `delays`, in schema order: band, description and length. */
  delays?: Rec;
  /** `capacityRemaining`, a percentage. */
  capacity?: number;
  /** `queueLength` in metres, which only an abnormal traffic record states. */
  queueLength?: number;
}

/** A delay effect as the DATEX elements that state it. */
function supplementOf(effect: Extract<Effect, { kind: "delay" }>): DelaySupplement {
  const delays: Rec = {
    ...(effect.delayBand !== undefined ? { "sit:delayBand": DELAY_BAND[effect.delayBand] } : {}),
    ...(effect.delayType !== undefined ? { "sit:delaysType": DELAYS_TYPE[effect.delayType] } : {}),
    ...(effect.delay !== undefined ? { "sit:delayTimeValue": effect.delay.value } : {}),
  };
  return {
    ...(Object.keys(delays).length > 0 ? { delays } : {}),
    ...(effect.capacityRemainingPct !== undefined ? { capacity: effect.capacityRemainingPct } : {}),
    ...(effect.queueLength !== undefined ? { queueLength: effect.queueLength.value } : {}),
  };
}

/**
 * The works' own elements of a roadworks nature record, in schema order:
 * duration class, scale, whether under traffic, whether urgent.
 */
function worksOf(details: Rec | undefined): Rec {
  if (details?.["kind"] !== "roadworks") return {};
  const durationClass = details["durationClass"];
  const scale = details["scale"];
  return {
    ...(typeof durationClass === "string" && ROADWORKS_DURATION[durationClass]
      ? { "sit:roadworksDurationClassification": ROADWORKS_DURATION[durationClass] }
      : {}),
    ...(typeof scale === "string" ? { "sit:roadworksScale": scale } : {}),
    ...(typeof details["underTraffic"] === "boolean"
      ? { "sit:underTraffic": details["underTraffic"] }
      : {}),
    ...(typeof details["urgent"] === "boolean" ? { "sit:urgentRoadworks": details["urgent"] } : {}),
  };
}

/** The situation's informant as DATEX `source`, in schema order. */
function sourceOf(provenance: Rec | undefined): Rec | undefined {
  const s = provenance?.["informationSource"] as InformationSource | undefined;
  if (s === undefined) return undefined;
  const out: Rec = {
    ...(s.country !== undefined ? { "com:sourceCountry": s.country.toLowerCase() } : {}),
    ...(s.id !== undefined ? { "com:sourceIdentification": s.id } : {}),
    ...(s.name !== undefined
      ? {
          "com:sourceName": {
            "com:values": {
              "com:value": s.name.map((t) => ({ "@_lang": t.lang, "#text": t.text })),
            },
          },
        }
      : {}),
    ...(s.type !== undefined ? { "com:sourceType": camelCase(s.type) } : {}),
    ...(s.reliable !== undefined ? { "com:reliable": s.reliable } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/** DATEX `DirectionEnum` values for a compass point. */
const COMPASS_BOUND: Readonly<Record<string, string>> = {
  N: "northBound",
  NE: "northEastBound",
  E: "eastBound",
  SE: "southEastBound",
  S: "southBound",
  SW: "southWestBound",
  W: "westBound",
  NW: "northWestBound",
};

/** DATEX `DirectionEnum` values an effect's direction keeps as its text. */
const DIRECTION_WORDS = new Set([
  "allDirections",
  "bothWays",
  "clockwise",
  "anticlockwise",
  "innerRing",
  "outerRing",
  "inboundTowardsTown",
  "outboundFromTown",
]);

/**
 * An effect's own direction as `applicableForTrafficDirection`: a compass
 * heading, or one of the axisless DATEX directions it keeps as its text. A
 * direction along a reference axis is not, as the export's point locations
 * carry no axis for it to align with.
 */
function trafficDirectionOf(effect: Effect): string | undefined {
  const d = effect.direction;
  if (d === undefined) return undefined;
  if (d.basis === "compass" && d.compass !== undefined) return COMPASS_BOUND[d.compass];
  if (d.basis === "text" && d.text !== undefined && DIRECTION_WORDS.has(d.text)) return d.text;
  return undefined;
}

/** The DATEX record a classification has of its own: subtype's, else type's. */
function natureRecordCode(c: SituationClass): string | undefined {
  const type = `${c.kind}.${c.type}`;
  const code = c.subtype ? DATEX2_RECORDS[`${type}.${c.subtype}`] : undefined;
  return (code ?? DATEX2_RECORDS[type]) || undefined;
}

/** What a nature record names beyond its discriminator: a fault's equipment. */
function natureDetail(c: SituationClass, code: string): Rec {
  if (!code.startsWith("EquipmentOrSystemFault")) return {};
  const equipment = DATEX2_FAULTY_EQUIPMENT[`${c.kind}.${c.type}.${c.subtype}`] ?? "other";
  return { "sit:faultyEquipmentOrSystemType": equipment };
}

/**
 * The situation's text as the leading record's public comments, in the order
 * the reader takes them back: the headline, then the description, then every
 * other public comment. Comments that are not for the public stay out, and
 * text that would take the place of a headline or description it is not
 * stays out with them.
 */
function publicCommentsOf(
  situation: Rec,
  diagnostics: ProjectionDiagnostics,
): { comments: Comment[] } {
  const headline = situation["headline"] as Text | undefined;
  const description = situation["description"] as Text | undefined;
  const comments = (situation["comments"] as { type?: string; text: Text }[] | undefined) ?? [];
  const out: Comment[] = headline?.length ? [{ text: headline }] : [];
  const omit = (path: string, reason: string) =>
    diagnostics.emit("field_not_exported", "field", "omitted", path, reason);
  // The description says what it is (`commentType`), so it reads back as one
  // even where it repeats the headline.
  if (description?.length) {
    if (out.length > 0) out.push({ text: description, type: "description" });
    else omit("/description", "Without a headline, the description would be read back as one.");
  }
  for (const [i, c] of comments.entries()) {
    if (c.type === "operator" || c.type === "internal")
      omit(`/comments/${i}`, "A comment that is not for the public is not published.");
    else if (out.length < 2)
      omit(
        `/comments/${i}`,
        "Without a headline and a description of their own, a comment would be read back as one of them.",
      );
    else out.push({ text: c.text });
  }
  return { comments: out };
}

type Relation = { ref: { class?: string; id?: string }; relation: string };

/** Whether DATEX states a relation: one to a situation that says only that it is related. */
const isRelatedSituation = (r: Relation) =>
  r.relation === "related" && r.ref.class === "situation" && typeof r.ref.id === "string";

/**
 * The situations a situation is related to, as DATEX `relatedSituation`
 * references to their ids in the publication. A relation of any other kind
 * has no DATEX form and is reported.
 */
export function relatedSituationsOf(situation: Rec, report?: ExportDiagnosticSink): Rec[] {
  const relations = (situation["relations"] as Relation[] | undefined) ?? [];
  for (const [i, r] of relations.entries())
    if (!isRelatedSituation(r))
      report?.({
        situationId: String(situation["id"]),
        code: "field_not_exported",
        scope: "field",
        disposition: "omitted",
        path: `/relations/${i}`,
        message: "DATEX relates situations without saying how; only a plain relation is written.",
      });
  return relations.filter(isRelatedSituation).map((r) => ({
    "sit:objectReference": { "@_targetClass": "sit:Situation", "@_id": r.ref.id },
  }));
}

/** The DATEX records of a situation at `at`; none when DATEX cannot tell it truthfully. */
export function datexRecordsOf(situation: Rec, at: Date, report?: ExportDiagnosticSink): Rec[] {
  const effects = projectionEffects(situation);
  const diagnostics = new ProjectionDiagnostics(situation, report);
  const root = situation["location"] as Rec;
  const placeOf = (effect: Effect) => ownPlace(situation, effect) ?? root;
  if (
    diagnostics.blocked("datex", {
      timing: (validity, effect) =>
        effect === undefined
          ? [
              root,
              ...situationEffects(situation).flatMap((e) => (e.validity ? [] : [placeOf(e)])),
            ].every((place) => datexStatesTiming(validity, place["geometry"]))
          : datexStatesTiming(validity, placeOf(effect)["geometry"]),
      place: datexStatesTablePlace,
    })
  )
    return [];
  // Relations travel on the situation; only the ones DATEX cannot state are reported here.
  relatedSituationsOf(situation, report);
  const id = situation["id"] as string;
  const version = String(situation["revision"] ?? 1);
  const validity = situation["validity"] as Validity;
  const provenance = situation["provenance"] as Rec;
  const freshness = situation["freshness"] as Rec;
  const time =
    (provenance["sourceUpdatedAt"] as string | undefined) ?? (freshness["fetchedAt"] as string);
  // The root place, built once for each count of lanes a record states with it.
  const rootLocations = new Map<number | undefined, Rec>();
  const rootLocation = (lanesTotal?: number) => {
    let built = rootLocations.get(lanesTotal);
    if (built === undefined) {
      built = buildLocation(root, diagnostics, "/location", undefined, "/location", lanesTotal);
      rootLocations.set(lanesTotal, built);
    }
    return built;
  };
  const probability = PROBABILITY[String(situation["certainty"])] ?? extended("unknown");

  // What the situation says as a whole travels on its leading record. A
  // record has one cause; any other is reported.
  const causes = (situation["causes"] as { type: string }[] | undefined) ?? [];
  const causeType = ownEntry(DATEX2_CAUSE_TYPES, causes[0]?.type) ?? undefined;
  for (const [i, c] of causes.entries())
    if (i > 0 || causeType === undefined)
      diagnostics.emit(
        "field_not_exported",
        "field",
        "omitted",
        `/causes/${i}`,
        `A DATEX record states one cause, of a cause type DATEX has: ${c.type} is not exported.`,
      );
  const lead = {
    severity: severityOf(situation["severity"] as Rec | undefined),
    source: sourceOf(provenance),
    ...(causeType ? { cause: causeType } : {}),
    ...publicCommentsOf(situation, diagnostics),
  };
  const usedIds = new Set([id]);
  const recordIdOf = (effect: Effect) => {
    // The assembler writes a grouped record's reference as `<record id>/<version>`
    // with an integer version; the record keeps the id, and the version is the
    // situation's revision. A second effect of one source record cannot share
    // its id, so it is named after the effect.
    const own = effect.sourceRecordRef?.replace(/\/\d+$/, "");
    const recordId = own !== undefined && !usedIds.has(own) ? own : `${id}#${effect.id}`;
    usedIds.add(recordId);
    return recordId;
  };
  const classification = situation as unknown as SituationClass;
  const natureCode = natureRecordCode(classification);
  // A classification must not recreate a filtered restriction at the root place.
  const natureRepresented = effects.some(
    ({ effect }) =>
      natureCode !== undefined &&
      (definesManagementNature(situation, effect) || effectCode(effect) === natureCode),
  );
  let folded: ProjectionEffect | undefined;
  let natureId = id;
  const pending: {
    code: string;
    header: RecordHeader;
    body: RecordBody;
    context: ProjectionEffect;
  }[] = [];
  for (const context of effects) {
    const { effect, validity: effectWindow } = context;
    if (effect.kind === "delay") continue;
    const projected = projectionStateAt(context, at, true);
    const { state } = projected;
    const path = diagnostics.effectPath(effect);
    if (state === "ended" || state === "unknown") {
      diagnostics.emit(
        state === "ended" ? "effect_ended" : "effect_time_unknown",
        "effect",
        "omitted",
        omittedPath(context, projected, path),
        `No management record is exported for this effect at the evaluation instant: ${state}.`,
        effect,
      );
      continue;
    }
    const code = effectCode(effect);
    if (code === undefined) {
      diagnostics.emit(
        "unsupported_effect",
        "effect",
        "omitted",
        `${path}/kind`,
        "This effect has no DATEX management record mapping in the current emitter.",
        effect,
      );
      continue;
    }
    const place = ownPlace(situation, effect);
    // Every record an effect has is network management, which states the
    // directions of traffic it applies to; one along a reference axis has
    // none it can state, unless it is its place's, which the place states.
    if (
      effect.direction !== undefined &&
      trafficDirectionOf(effect) === undefined &&
      !(sameJson(effect.direction, (place ?? root)["direction"]) && statesDirection(place ?? root))
    )
      diagnostics.emit(
        "direction_not_exported",
        "field",
        "omitted",
        `${path}/direction`,
        "This DATEX emitter does not export an effect direction along a reference axis.",
        effect,
      );
    if (
      effect.kind === "detour" &&
      effect.geometry !== undefined &&
      effect.geometry.type !== "LineString"
    )
      diagnostics.emit(
        "field_not_exported",
        "field",
        "omitted",
        `${path}/geometry`,
        "A diversion route is exported as one linear location; this route is not one line.",
        effect,
      );
    if (place === undefined && effect.location?.direction !== undefined)
      diagnostics.emit(
        "direction_not_exported",
        "field",
        "omitted",
        `${path}/location/direction`,
        "This DATEX emitter does not export effect location direction.",
        effect,
      );
    // Only one effect may supply the nature record: never combine independent
    // values, compliance, impact or validity into a synthetic restriction.
    if (
      (code === natureCode || closedByNature(effect, natureCode)) &&
      place === undefined &&
      folded === undefined
    ) {
      folded = context;
      // The nature record is the record the effect was read from, where it was.
      if (effect.sourceRecordRef !== undefined) natureId = recordIdOf(effect);
      continue;
    }
    const lanesTotal = effect.kind === "lane_restriction" ? effect.lanesTotal : undefined;
    pending.push({
      code,
      context,
      header: { id: recordIdOf(effect), version, time, probability },
      body: {
        validity: effectWindow,
        geometry: (place ?? root)["geometry"],
        location:
          place === undefined
            ? rootLocation(lanesTotal)
            : buildLocation(
                place,
                diagnostics,
                `${path}/location`,
                effect,
                effect.location?.direction === undefined ? "/location" : `${path}/location`,
                lanesTotal,
              ),
        impact: effectImpact(effect),
        compliance: effect.compliance,
        actionStatus: effect.actionStatus,
        trafficDirection: trafficDirectionOf(effect),
        detail: effectDetail(effect),
      },
    });
  }
  const hasNature = natureCode !== undefined && (!natureRepresented || folded !== undefined);
  if (natureCode === undefined)
    diagnostics.emit(
      "unsupported_nature",
      "field",
      "omitted",
      "/type",
      "This situation classification has no DATEX nature record mapping in the current emitter.",
    );
  const bodies = hasNature
    ? [
        {
          code: natureCode!,
          header: { id: natureId, version, time, probability },
          context: folded,
          body: {
            validity: folded?.validity ?? validity,
            geometry: root["geometry"],
            location: rootLocation(
              folded?.effect.kind === "lane_restriction" ? folded.effect.lanesTotal : undefined,
            ),
            impact: folded ? effectImpact(folded.effect) : {},
            compliance: folded?.effect.compliance,
            actionStatus: folded?.effect.actionStatus,
            trafficDirection: folded ? trafficDirectionOf(folded.effect) : undefined,
            works: worksOf(situation["details"] as Rec | undefined),
            detail: {
              ...natureDetail(classification, natureCode!),
              ...(folded ? effectDetail(folded.effect) : {}),
            },
          } as RecordBody,
        },
        ...pending,
      ]
    : pending;
  const leading = bodies[0];
  // A delay supplements the record of the source record it was read with,
  // else the leading record.
  const delays = new Map<(typeof bodies)[number], Extract<Effect, { kind: "delay" }>[]>();
  for (const context of effects.filter(({ effect }) => effect.kind === "delay")) {
    const { effect, validity: delayWindow } = context;
    const projected = projectionStateAt(context, at, true);
    const { state } = projected;
    const path = diagnostics.effectPath(effect);
    const sourceRecord = effect.sourceRecordRef?.replace(/\/\d+$/, "");
    const target = bodies.find((b) => b.header.id === sourceRecord) ?? leading;
    if (state === "ended" || state === "unknown") {
      diagnostics.emit(
        state === "ended" ? "effect_ended" : "effect_time_unknown",
        "effect",
        "omitted",
        omittedPath(context, projected, path),
        `This delay supplement is not exported at the evaluation instant: ${state}.`,
        effect,
      );
    } else if (
      !target ||
      !sameJson(
        ownPlace(situation, effect),
        target.context && ownPlace(situation, target.context.effect),
      ) ||
      !sameInterval(delayWindow, target.body.validity) ||
      delayWindow.status !== target.body.validity.status
    ) {
      diagnostics.emit(
        "field_not_exported",
        "field",
        "omitted",
        `${path}/delay`,
        "This delay cannot supplement its record: its place, interval or lifecycle differs, or no record is available.",
        effect,
      );
    } else if (effect.kind === "delay") {
      // Only an abnormal traffic record states the length of a queue.
      if (effect.queueLength !== undefined && !target.code.startsWith("AbnormalTraffic"))
        diagnostics.emit(
          "field_not_exported",
          "field",
          "omitted",
          `${path}/queueLength`,
          "Only an abnormal traffic record states a queue length; the record it supplements is not one.",
          effect,
        );
      delays.set(target, [...(delays.get(target) ?? []), effect]);
    }
  }
  // A record has only one delay slot. Never choose among conflicting observations.
  for (const [target, supplementing] of delays) {
    const supplements = supplementing.map((effect) => {
      const { queueLength, ...rest } = supplementOf(effect);
      return target.code.startsWith("AbnormalTraffic") ? { ...rest, queueLength } : rest;
    });
    if (new Set(supplements.map((s) => JSON.stringify(s))).size > 1) {
      for (const effect of supplementing)
        diagnostics.emit(
          "conflicting_effects",
          "field",
          "omitted",
          `${diagnostics.effectPath(effect)}/delay`,
          "Different delays cannot share a DATEX record's single supplement.",
          effect,
        );
    } else target.body.supplement = supplements[0];
  }
  if (leading) leading.body.lead = lead;
  return bodies.map(({ code, header, body }) => record(code, header, body));
}

/**
 * The place an effect holds at when it is not its situation's: its own
 * geometry with the situation's road references.
 */
function ownPlace(situation: Rec, effect: Effect): Rec | undefined {
  const own = effect.location as Rec | undefined;
  if (own?.["geometry"] == null) return undefined;
  return { ...(situation["location"] as Rec), ...own };
}

/**
 * The payload's `lang`, the default language of its text: the one language of
 * every headline and road name written, `mul` when they differ, `und` when
 * there is none. Each headline value still states its own.
 */
function publicationLang(situations: readonly Rec[]): string {
  const langs = new Set<string>();
  for (const situation of situations) {
    for (const t of (situation["headline"] as Text | undefined) ?? []) langs.add(t.lang);
    const places = [situation["location"], ...situationEffects(situation).map((e) => e.location)];
    for (const place of places as (Rec | undefined)[]) {
      for (const road of (place?.["roads"] as Rec[] | undefined) ?? []) {
        const name = roadName(road);
        if (name) langs.add(name.lang);
      }
    }
  }
  const [only, ...more] = langs;
  if (only === undefined) return "und";
  return more.length > 0 ? "mul" : only;
}

/**
 * Projects situations to a DATEX II v3 `SituationPublication` in an Exchange
 * 2020 snapshot-pull `messageContainer`, evaluated at `at`. `info.timestamp`
 * sets the publication and message time (else `at`); `info.attribution` the
 * national identifier. `country` is the feed-level publication-creator
 * country code (ISO 3166-1 α-2); the default `zz` is the user-assigned code
 * for an aggregate that spans countries.
 */
export function situationsToDatex(
  situations: readonly Rec[],
  at: Date = new Date(),
  info: FeedInfo = {},
  country = "zz",
): string {
  const time = info.timestamp ?? at.toISOString();
  const creator = {
    "com:country": country,
    "com:nationalIdentifier": info.attribution ?? "OpenConditions",
  };
  const exported = situations.flatMap((situation) => {
    const records = datexRecordsOf(situation, at);
    return records.length > 0 ? [{ situation, records }] : [];
  });
  const payload: Rec = {
    "@_xsi:type": "sit:SituationPublication",
    "@_lang": publicationLang(exported.map((e) => e.situation)),
    "@_modelBaseVersion": "3",
    "com:publicationTime": time,
    "com:publicationCreator": creator,
  };
  const related = (situation: Rec) => relatedSituationsOf(situation);
  payload["sit:situation"] = exported.map(({ situation, records }) => ({
    "@_id": situation["id"],
    "sit:headerInformation": {
      "com:confidentiality": "noRestriction",
      "com:informationStatus": "real",
    },
    "sit:situationRecord": records,
    ...(related(situation).length > 0 ? { "sit:relatedSituation": related(situation) } : {}),
  }));
  const doc = {
    messageContainer: {
      "@_xmlns": "http://datex2.eu/schema/3/messageContainer",
      "@_xmlns:com": "http://datex2.eu/schema/3/common",
      "@_xmlns:ex": "http://datex2.eu/schema/3/exchangeInformation",
      "@_xmlns:loc": "http://datex2.eu/schema/3/locationReferencing",
      "@_xmlns:sit": "http://datex2.eu/schema/3/situation",
      "@_xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@_modelBaseVersion": "3",
      payload,
      exchangeInformation: {
        "@_modelBaseVersion": "3",
        "ex:exchangeContext": {
          "ex:codedExchangeProtocol": "snapshotPull",
          "ex:exchangeSpecificationVersion": "2020.1",
          "ex:supplierOrCisRequester": { "ex:internationalIdentifier": creator },
        },
        "ex:dynamicInformation": {
          "ex:exchangeStatus": "online",
          "ex:messageGenerationTimestamp": time,
        },
      },
    },
  };
  return buildXmlDocument(doc);
}
