import type { Confidence } from "@openconditions/core";
import { normaliseSeverity, scheduleTimezoneForGeometry } from "@openconditions/core";
import {
  multilingual as datexMultilingual,
  datexPublications,
  recordBody as datexRecordBody,
  datexRoot,
  detectReprojector,
  displayCoordinates,
  elementType,
  getXmlAttribute,
  getXmlChild,
  getXmlChildren,
  getXmlChildText,
  isXmlObject,
  parseLatLonList,
  parseXmlDocument,
  type Reprojector,
  recId,
  stripXmlNamespace,
  unnamedCoordinateLists,
  type XmlObject,
  xmlNodeToArray,
  xmlText,
} from "@openconditions/datex2";
import { isPlausibleWgs84, recordSkipped, reprojectorFor } from "@openconditions/ingest-framework";
import type {
  Effect,
  InformationSource,
  Issue,
  Schedule,
  Text,
  Validity,
} from "@openconditions/model";
import {
  DATEX2_DELAY_BANDS,
  DATEX2_DELAY_TYPES,
  DATEX2_ROADWORKS_DURATIONS,
  DATEX2_ROADWORKS_SCALES,
  DATEX2_SOURCE_TYPES,
  DATEX2_V2,
  DATEX2_V3,
  datexClassification,
  datexDiscriminator,
  parseRestrictionInstant,
  type RestrictionIssue,
  type RoadRestrictionDetailsV1,
  type RoadRestrictionFact,
  toRestrictionInstant,
} from "@openconditions/model-roads";
import type { Geometry } from "geojson";
import { zonedPeriods } from "./datex-periods.js";
import {
  type DatexRestrictionContext,
  datexApplicabilityVehicles,
  datexRestrictionDetails,
  isNonPublicComment,
  NON_PUBLIC_COMMENT_TYPES,
} from "./datex-restrictions.js";
import type { Restriction, RoadEvent, UnresolvedRoadEvent } from "./model.js";
import { buildLocalSchedule, type LocalSchedule } from "./schedule.js";
import { type CoarseType, coarseOf, coarseType } from "./situation/classes.js";
import { entryOf, UNDETERMINED } from "./situation/location.js";
import {
  canonicalSnapshotValue,
  compareSnapshotRank,
  type RoadSnapshotRecord,
  type RoadSnapshotReport,
  snapshotFingerprint,
} from "./snapshot.js";
import { resolveAlertC, tmcTables } from "./tmc/index.js";
import { resolveVild, type VildReference } from "./tmc/vild.js";
import type { SourceDescriptor } from "./types.js";

/** How one DATEX record's lifecycle reads. */
interface DatexLifecycle {
  status: RoadEvent["status"];
  /** The situation's lifecycle, where it says more than active or ended. */
  validityStatus?: Validity["status"];
  /** Present when the status does not establish that the record is in force. */
  statusIssue?: Issue;
}

/**
 * The lifecycle a DATEX `validityStatus` declares (`ValidityStatusEnum`: v2.3
 * `active | suspended | definedByValidityTimeSpec`, v3.7 adding `planned` and
 * `_extended`). `definedByValidityTimeSpec` holds the record to its time
 * specification and `active` declares it in force. `planned` and `suspended`
 * declare it not in force whatever its time specification says, and an
 * `_extended`, missing or unrecognised value does not say; those records stay
 * current, but their effects carry `unsupported_status`, as the restriction
 * contract's do, so none routes or exports as active. Publishers that end a
 * record with a token outside the enumeration (`cancelled`, `archived`,
 * `inactive`) have it ended.
 */
function datexLifecycle(validity: XmlObject): DatexLifecycle {
  const node = validity["validityStatus"];
  const raw = text(node);
  switch (raw) {
    case "active":
    case "definedByValidityTimeSpec":
      return { status: "active" };
    case "cancelled":
    case "archived":
    case "inactive":
      return { status: raw };
  }
  const extendedValue = isXmlObject(node) ? getXmlAttribute(node, "_extendedValue") : undefined;
  const statusIssue: Issue = {
    code: "unsupported_status",
    sourcePath: "situationRecord.validity.validityStatus",
    sourceTokens: {
      validityStatus: raw ?? null,
      ...(extendedValue !== undefined ? { extendedValue } : {}),
    },
  };
  if (raw === "suspended") return { status: "inactive", validityStatus: "suspended", statusIssue };
  if (raw === "planned") return { status: "active", validityStatus: "planned", statusIssue };
  return { status: "active", validityStatus: "unknown", statusIssue };
}

/**
 * The `ValidityStatusEnum` values of v2.3 and v3.7 that `datexLifecycle`
 * reads, and the tokens outside the enumeration that publishers end a record
 * with. `_extended`, whose meaning lives in an extension schema, is not read.
 */
const READ_VALIDITY_STATUSES = new Set([
  "active",
  "suspended",
  "definedByValidityTimeSpec",
  "planned",
  "cancelled",
  "archived",
  "inactive",
]);

/** The non-placeholder values of a vocabulary list of either DATEX version. */
const standardValues = (...lists: readonly (readonly string[])[]): ReadonlySet<string> =>
  new Set(lists.flat().filter((v) => v !== "_extended"));

const RECORD_CLASSES = standardValues(DATEX2_V3.recordClasses, DATEX2_V2.recordClasses);
const CAUSE_TYPES = standardValues(DATEX2_V3.causeTypes, DATEX2_V2.causeTypes);
const SEVERITIES = standardValues(DATEX2_V3.severities, DATEX2_V2.severities);
const PROBABILITIES = standardValues(DATEX2_V3.probabilities, DATEX2_V2.probabilities);

type DiscriminatorTable = Readonly<Record<string, { values: readonly string[] }>>;
const DISCRIMINATOR_VALUES = new Map<string, ReadonlySet<string>>(
  [
    ...new Set([
      ...Object.keys(DATEX2_V3.discriminators),
      ...Object.keys(DATEX2_V2.discriminators),
    ]),
  ].map((cls) => [
    cls,
    standardValues(
      (DATEX2_V3.discriminators as DiscriminatorTable)[cls]?.values ?? [],
      (DATEX2_V2.discriminators as DiscriminatorTable)[cls]?.values ?? [],
    ),
  ]),
);

const ACTION_STATUSES = standardValues(
  DATEX2_V3.operatorActionStatuses,
  DATEX2_V2.operatorActionStatuses,
);
const COMPLIANCE_OPTIONS = standardValues(DATEX2_V3.complianceOptions, DATEX2_V2.complianceOptions);
const CONSTRICTION_TYPES = standardValues(
  DATEX2_V3.trafficConstrictionTypes,
  DATEX2_V2.trafficConstrictionTypes,
);
const TRAFFIC_TYPES = standardValues(DATEX2_V3.trafficTypes, DATEX2_V2.trafficTypes);
const MOBILITY_TYPES = standardValues(DATEX2_V3.mobilityTypes, DATEX2_V2.mobilityTypes);
const DIRECTIONS = standardValues(DATEX2_V3.directions, DATEX2_V2.directions);
const DELAY_BANDS = standardValues(DATEX2_V3.delayBands, DATEX2_V2.delayBands);
const DELAYS_TYPES = standardValues(DATEX2_V3.delaysTypes, DATEX2_V2.delaysTypes);
const ROADWORKS_SCALES = standardValues(DATEX2_V3.roadworksScales, DATEX2_V2.roadworksScales);
const ROADWORKS_DURATIONS = standardValues(
  DATEX2_V3.roadworksDurations,
  DATEX2_V2.roadworksDurations,
);
const SOURCE_TYPES = standardValues(DATEX2_V3.sourceTypes, DATEX2_V2.sourceTypes);
const XS_BOOLEANS = new Set(["true", "false", "1", "0"]);

/** `OperatorActionStatusEnum` as the kernel's action statuses. */
const ACTION_STATUS: Readonly<Record<string, NonNullable<Effect["actionStatus"]>>> = {
  requested: "requested",
  approved: "approved",
  beingImplemented: "being_implemented",
  implemented: "implemented",
  rejected: "rejected",
  terminationRequested: "termination_requested",
  beingTerminated: "being_terminated",
};

/**
 * What a record says about the measure it states, beyond its type: the
 * operator action's status, whether the measure is mandatory or advisory, the
 * traffic it applies to, and record-level issues every effect carries.
 */
interface DatexMeasure {
  actionStatus?: Effect["actionStatus"];
  compliance?: Effect["compliance"];
  trafficTypes?: string[];
  trafficDirections?: string[];
  effectIssues: Issue[];
}

/**
 * An `OperatorAction`'s `operatorActionStatus` and a `NetworkManagement`'s
 * `complianceOption`, `applicableForTrafficType`,
 * `applicableForTrafficDirection` and `placesAtWhichApplicable`. An action
 * status outside the enumeration (or `_extended`) establishes nothing, so the
 * effects carry `unsupported_status` and never route; an unreadable
 * compliance is `unknown`. A measure that applies only at some
 * kinds of place within its location (in tunnels, on bridges) applies under a
 * condition no effect can carry: its effects are partial, never routed as if
 * the whole location were affected.
 */
function measureOf(rec: XmlObject): DatexMeasure {
  const effectIssues: Issue[] = [];
  const actionNode = rec["operatorActionStatus"];
  const action = text(actionNode);
  const actionStatus = entryOf(ACTION_STATUS, action);
  if (action !== undefined && actionStatus === undefined) {
    const extendedValue = isXmlObject(actionNode)
      ? getXmlAttribute(actionNode, "_extendedValue")
      : undefined;
    effectIssues.push({
      code: "unsupported_status",
      sourcePath: "situationRecord.operatorActionStatus",
      sourceTokens: {
        operatorActionStatus: action,
        ...(extendedValue !== undefined ? { extendedValue } : {}),
      },
    });
  }
  const declared = getXmlChildText(rec, "complianceOption");
  const compliance =
    declared === undefined
      ? undefined
      : declared === "mandatory" || declared === "advisory"
        ? declared
        : ("unknown" as const);
  const trafficTypes = xmlNodeToArray(rec["applicableForTrafficType"])
    .map(text)
    .filter((v): v is string => v !== undefined);
  const trafficDirections = xmlNodeToArray(rec["applicableForTrafficDirection"])
    .map(text)
    .filter((v): v is string => v !== undefined);
  const places = xmlNodeToArray(rec["placesAtWhichApplicable"])
    .map(text)
    .filter((v): v is string => v !== undefined);
  if (places.length > 0) {
    effectIssues.push({
      code: "compound_condition",
      sourcePath: "situationRecord.placesAtWhichApplicable",
      sourceTokens: { placesAtWhichApplicable: places },
    });
  }
  return {
    ...(actionStatus !== undefined ? { actionStatus } : {}),
    ...(compliance !== undefined ? { compliance } : {}),
    ...(trafficTypes.length > 0 ? { trafficTypes } : {}),
    ...(trafficDirections.length > 0 ? { trafficDirections } : {}),
    effectIssues,
  };
}

/**
 * What an unplanned event's `trafficConstrictionType` (v3 on the record, v2
 * in its `impact`) says about the road, by the enumeration's definitions: a
 * road "totally obstructed, for all vehicles in both directions" is closed; a
 * carriageway "totally obstructed in the specified direction" is closed as a
 * carriageway; lanes "totally obstructed" are closed lanes. A partial
 * obstruction leaves the road and its lanes passable and declares nothing.
 */
const CONSTRICTION: Readonly<
  Record<string, { roadState: NonNullable<RoadEvent["roadState"]>; scope?: "carriageway" }>
> = {
  roadBlocked: { roadState: "closed" },
  carriagewayBlocked: { roadState: "closed", scope: "carriageway" },
  lanesBlocked: { roadState: "some_lanes_closed" },
};

function constrictionOf(rec: XmlObject): string | undefined {
  return (
    getXmlChildText(rec, "trafficConstrictionType") ??
    getXmlChildText(getXmlChild(rec, "impact"), "trafficConstrictionType")
  );
}

/**
 * The work zone a roadworks record's `mobility` declares: works "moving" are
 * a moving work zone, "stationary" ones a static one; an unknown mobility
 * says neither.
 */
function workZoneTypeOf(rec: XmlObject): RoadEvent["workZoneType"] | undefined {
  switch (getXmlChildText(getXmlChild(rec, "mobility"), "mobilityType")) {
    case "mobile":
      return "moving";
    case "stationary":
      return "static";
    default:
      return undefined;
  }
}

/** The record's remaining capacity (`impact/capacityRemaining`), a percentage. */
function capacityRemainingOf(rec: XmlObject): number | undefined {
  const raw = getXmlChildText(getXmlChild(rec, "impact"), "capacityRemaining");
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
}

/** The record's `impact/delays`, where both versions describe a delay. */
const delaysNode = (rec: XmlObject) => getXmlChild(getXmlChild(rec, "impact"), "delays");

/**
 * The band and the description of the record's delay (`impact/delays`
 * `delayBand` and `delaysType`), each beside or instead of its length.
 */
function delayDescriptionOf(rec: XmlObject): Pick<RoadEvent, "delayBand" | "delayType"> {
  const delays = delaysNode(rec);
  const band = entryOf(DATEX2_DELAY_BANDS, getXmlChildText(delays, "delayBand"));
  const type = entryOf(DATEX2_DELAY_TYPES, getXmlChildText(delays, "delaysType"));
  return {
    ...(band !== undefined ? { delayBand: band as RoadEvent["delayBand"] } : {}),
    ...(type !== undefined ? { delayType: type as RoadEvent["delayType"] } : {}),
  };
}

/** An XML Schema boolean (`true`, `false`, `1`, `0`); undefined for anything else. */
function xsBoolean(raw: string | undefined): boolean | undefined {
  switch (raw) {
    case "true":
    case "1":
      return true;
    case "false":
    case "0":
      return false;
    default:
      return undefined;
  }
}

/** The works' duration class: v3's `roadworksDurationClassification`, v2.3's `roadworksDuration`. */
const roadworksDurationTokenOf = (rec: XmlObject) =>
  getXmlChildText(rec, "roadworksDurationClassification") ??
  getXmlChildText(rec, "roadworksDuration");

/**
 * What a roadworks record says of the works beyond their kind: their scale,
 * their duration class (v3 `roadworksDurationClassification`, v2.3
 * `roadworksDuration`), whether they are urgent and whether they are carried
 * out under traffic.
 */
function roadworksOf(rec: XmlObject): RoadEvent["roadworks"] {
  const scale = entryOf(DATEX2_ROADWORKS_SCALES, getXmlChildText(rec, "roadworksScale"));
  const durationClass = entryOf(DATEX2_ROADWORKS_DURATIONS, roadworksDurationTokenOf(rec));
  const urgent = xsBoolean(getXmlChildText(rec, "urgentRoadworks"));
  const underTraffic = xsBoolean(getXmlChildText(rec, "underTraffic"));
  const out = {
    ...(scale !== undefined ? { scale } : {}),
    ...(durationClass !== undefined ? { durationClass } : {}),
    ...(urgent !== undefined ? { urgent } : {}),
    ...(underTraffic !== undefined ? { underTraffic } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Who or what supplied the record's information (`source`): the kind of
 * informant, its name in every language given, the publisher's id of it, its
 * country and whether the publisher holds it reliable. A country is read when
 * it is a two-letter code; v2.3's `other` names none.
 */
function informationSourceOf(rec: XmlObject): InformationSource | undefined {
  const source = getXmlChild(rec, "source");
  if (source === undefined) return undefined;
  const type = entryOf(DATEX2_SOURCE_TYPES, getXmlChildText(source, "sourceType"));
  const name = multilingualText(getXmlChild(source, "sourceName"));
  const id = getXmlChildText(source, "sourceIdentification")?.trim();
  const country = getXmlChildText(source, "sourceCountry")?.trim();
  const reliable = xsBoolean(getXmlChildText(source, "reliable"));
  const out = {
    ...(type !== undefined ? { type: type as NonNullable<InformationSource["type"]> } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(id ? { id } : {}),
    ...(country !== undefined && /^[a-z]{2}$/i.test(country)
      ? { country: country.toUpperCase() }
      : {}),
    ...(reliable !== undefined ? { reliable } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The overall end a record states and has overrun: DATEX `overrunning` says
 * the activity "is still in progress, overrunning its planned duration", so an
 * end at or before the record's version time no longer bounds it and is kept
 * as the estimate it was. A later end is the current plan and stays the end.
 */
function overrunEndOf(
  validity: XmlObject,
  end: string | undefined,
  asOf: string | null,
): string | undefined {
  if (getXmlChildText(validity, "overrunning") !== "true" || end === undefined || asOf === null) {
    return undefined;
  }
  const endMs = Date.parse(end);
  return Number.isFinite(endMs) && endMs <= Date.parse(asOf) ? end : undefined;
}

/** DATEX model versions the situation parser reads. */
const READ_MODEL_VERSIONS = new Set([2, 3]);

/**
 * The DATEX model version a document declares: its `modelBaseVersion`, else
 * the major version of the DATEX namespace it binds (v1's
 * `http://datex2.eu/schema/1_0/1_0`); undefined when it declares neither.
 */
function datexModelVersion(input: string | Buffer): number | undefined {
  const head =
    typeof input === "string" ? input.slice(0, 8192) : input.subarray(0, 8192).toString("utf8");
  const declared = /\bmodelBaseVersion\s*=\s*["']\s*(\d+)/.exec(head)?.[1];
  if (declared !== undefined) return Number(declared);
  const namespace = /["']http:\/\/datex2\.eu\/schema\/(\d+)[/_]/.exec(head)?.[1];
  return namespace === undefined ? undefined : Number(namespace);
}

/**
 * How many enumerated values a kept record carries that the parser cannot
 * read: a discriminator, cause type, severity, probability, validity status,
 * operator action status, compliance, traffic constriction, traffic type or
 * direction, mobility, delay band or type, roadworks scale or duration,
 * source type or recurrence day or month outside both versions'
 * enumerations, or the `_extended` placeholder, whose meaning lives in an
 * extension schema the parser does not read, and a roadworks or source flag
 * that is no boolean. Each is published without; counting them keeps a
 * renamed or national value from reading as a quiet feed.
 */
function unreadValuesOf(rec: XmlObject, recordClass: string, severity: string): number {
  let unread = 0;
  const check = (value: string | undefined, known: ReadonlySet<string>) => {
    if (value !== undefined && !known.has(value)) unread++;
  };
  const discriminator = datexDiscriminator(recordClass);
  const known = DISCRIMINATOR_VALUES.get(recordClass);
  if (discriminator !== undefined && known !== undefined) {
    for (const value of xmlNodeToArray(rec[discriminator])) check(text(value), known);
  }
  for (const cause of getXmlChildren(rec, "cause")) {
    check(getXmlChildText(cause, "causeType"), CAUSE_TYPES);
  }
  for (const comment of getXmlChildren(rec, "generalPublicComment")) {
    check(getXmlChildText(comment, "commentType"), COMMENT_TYPES);
  }
  check(severity.trim() || undefined, SEVERITIES);
  check(getXmlChildText(rec, "probabilityOfOccurrence"), PROBABILITIES);
  check(text(getXmlChild(rec, "validity")?.["validityStatus"]), READ_VALIDITY_STATUSES);
  check(text(rec["operatorActionStatus"]), ACTION_STATUSES);
  check(getXmlChildText(rec, "complianceOption"), COMPLIANCE_OPTIONS);
  check(constrictionOf(rec), CONSTRICTION_TYPES);
  for (const value of xmlNodeToArray(rec["applicableForTrafficType"])) {
    check(text(value), TRAFFIC_TYPES);
  }
  for (const value of xmlNodeToArray(rec["applicableForTrafficDirection"])) {
    check(text(value), DIRECTIONS);
  }
  check(getXmlChildText(getXmlChild(rec, "mobility"), "mobilityType"), MOBILITY_TYPES);
  const delays = delaysNode(rec);
  check(getXmlChildText(delays, "delayBand"), DELAY_BANDS);
  check(getXmlChildText(delays, "delaysType"), DELAYS_TYPES);
  check(getXmlChildText(rec, "roadworksScale"), ROADWORKS_SCALES);
  check(roadworksDurationTokenOf(rec), ROADWORKS_DURATIONS);
  check(getXmlChildText(rec, "urgentRoadworks"), XS_BOOLEANS);
  check(getXmlChildText(rec, "underTraffic"), XS_BOOLEANS);
  const source = getXmlChild(rec, "source");
  check(getXmlChildText(source, "sourceType"), SOURCE_TYPES);
  check(getXmlChildText(source, "reliable"), XS_BOOLEANS);
  const timeSpec = getXmlChild(getXmlChild(rec, "validity"), "validityTimeSpecification");
  for (const period of [
    ...getXmlChildren(timeSpec, "validPeriod"),
    ...getXmlChildren(timeSpec, "exceptionPeriod"),
  ]) {
    for (const recurrence of getXmlChildren(period, "recurringDayWeekMonthPeriod")) {
      for (const day of xmlNodeToArray(recurrence["applicableDay"])) check(text(day), DAYS);
      for (const month of xmlNodeToArray(recurrence["applicableMonth"])) {
        check(text(month), MONTHS);
      }
    }
  }
  return unread;
}

/**
 * DATEX types whose coordinate members describe a path in source order.
 * `LinearByCoordinates` is intentionally excluded here: its `start` and
 * `end` members describe endpoints, while indexed `intermediate` members
 * promote the collection to an ordered polyline in the geometry walker.
 */
function isLinearPathType(type: string): boolean {
  return type === "Linear" || type.endsWith("LinearLocation");
}

function situationIdOf(situation: XmlObject): string | undefined {
  return (
    getXmlAttribute(situation, "id") ||
    getXmlChildText(situation, "idG") ||
    getXmlChildText(situation, "id")
  );
}

function text(node: unknown): string | undefined {
  return xmlText(node);
}

function multilingual(node: unknown, lang: string): string | undefined {
  if (!isXmlObject(node)) return undefined;

  const comment = getXmlChild(node, "comment") ?? node;
  const values = getXmlChild(comment, "values");

  if (values) {
    const valueNodes = xmlNodeToArray(values["value"]).filter(isXmlObject);
    const match = valueNodes.find(
      (v) => getXmlAttribute(v, "lang") === lang || getXmlAttribute(v, "lang")?.startsWith(lang),
    );
    if (match) return text(match);
    const first = valueNodes[0];
    if (first) return text(first);
  }

  return text(comment);
}

/**
 * A public comment's multilingual block (the `comment` it wraps, or the node
 * itself) in every language it carries, in document order.
 */
function multilingualText(node: unknown): Text | undefined {
  if (!isXmlObject(node)) return undefined;
  const out: Text = datexMultilingual(getXmlChild(node, "comment") ?? node).map(
    ({ lang, value }) => ({ lang, text: value }),
  );
  return out.length > 0 ? out : undefined;
}

/**
 * The coarse type of a DATEX record class where it is not its classification's:
 * a management record's coarse type is its measure (a lane closure, a
 * rerouting, a speed limit) whatever the classification its cause gives it, and
 * the established reading of the vehicle and obstruction classes stays. Every
 * other class reads its coarse type from its classification.
 */
const DATEX_COARSE: Readonly<Record<string, CoarseType>> = {
  Accident: coarseType("accident"),
  VehicleObstruction: coarseType("broken_down_vehicle"),
  GeneralObstruction: coarseType("obstruction"),
  InfrastructureDamageObstruction: { ...coarseType("hazard"), category: "incident" },
  EnvironmentalObstruction: { ...coarseType("hazard"), category: "incident" },
  RoadOrCarriagewayOrLaneManagement: coarseType("lane_closure"),
  ReroutingManagement: coarseType("detour"),
  SpeedManagement: coarseType("speed_restriction"),
  GeneralNetworkManagement: coarseType("other"),
  MaintenanceWorks: coarseType("roadworks"),
  ConstructionWorks: coarseType("roadworks"),
  AbnormalTraffic: coarseType("congestion"),
  PoorEnvironmentConditions: coarseType("weather"),
  PublicEvent: coarseType("public_event"),
  EquipmentOrSystemFault: coarseType("equipment_fault"),
};

function defaultHeadline(type: string): string {
  const labels: Record<string, string> = {
    accident: "Accident",
    congestion: "Traffic congestion",
    roadworks: "Road works",
    lane_closure: "Lane closure",
    road_closure: "Road closure",
    contraflow: "Contraflow",
    detour: "Detour",
    hazard: "Road hazard",
    weather: "Weather conditions",
    road_condition: "Road condition",
    obstruction: "Obstruction",
    broken_down_vehicle: "Broken down vehicle",
    public_event: "Public event",
    authority: "Police/checkpoint",
    speed_restriction: "Speed restriction",
    dimension_restriction: "Dimension restriction",
    equipment_fault: "Equipment fault",
    security: "Security incident",
    transit_disruption: "Transit disruption",
    other: "Traffic information",
  };
  return labels[type] ?? "Traffic information";
}

/**
 * Resolve a situationRecord's geometry by walking its location subtree for any
 * coordinate-bearing element — DATEX nests these at varying depths and shapes:
 *  - `pointByCoordinates > pointCoordinates` (latitude/longitude) → Point
 *  - GML `gmlPoint > pos` → Point; `gmlLineString > posList` → LineString
 *  - `ItineraryByIndexedLocations` / `locationContainedInItinerary` → ordered
 *    locations, each with its own GML or point coordinates
 * Multiple lines → MultiLineString. Explicitly ordered point itineraries,
 * point members of declared linear locations, and LinearByCoordinates members
 * with indexed intermediates become LineString; endpoint-only
 * LinearByCoordinates and generic point collections remain MultiPoint because
 * they may be endpoints rather than a traversable path. Records with no
 * coordinate geometry (Alert-C/TMC only) return null (decoded in Phase 2).
 */
function resolveGeometry(
  rec: XmlObject,
  reproject?: Reprojector | null,
  lonFirst = false,
): Geometry | null {
  return resolveGeometryFrom(
    getXmlChild(rec, "locationReference") ?? getXmlChild(rec, "groupOfLocations"),
    reproject,
    lonFirst,
  );
}

/** Walk a location subtree (locationReference, groupOfLocations, alternativeRoute,
 * …) for any coordinate-bearing element and assemble a GeoJSON geometry. */
function resolveGeometryFrom(
  locRef: XmlObject | undefined,
  reproject?: Reprojector | null,
  lonFirst = false,
): Geometry | null {
  if (!locRef) return null;

  const lines: [number, number][][] = [];
  const points: [number, number][] = [];
  const linearPathPoints: [number, number][] = [];
  const linearByCoordinatesPoints: Array<{
    point: [number, number];
    order: number;
    sequence: number;
  }> = [];
  const indexedItineraryPoints: Array<{ index: number; point: [number, number] }> = [];
  let hasOrderedItinerary = elementType(locRef) === "ItineraryByIndexedLocations";
  let hasLinearPath = isLinearPathType(elementType(locRef));
  let hasLinearByCoordinatesIntermediate = false;
  let linearByCoordinatesSequence = 0;

  const addLinearByCoordinatesPoint = (point: [number, number], order?: number): void => {
    linearByCoordinatesPoints.push({
      point,
      order: order ?? linearByCoordinatesSequence,
      sequence: linearByCoordinatesSequence++,
    });
  };

  const visit = (
    node: unknown,
    itineraryIndex?: number,
    linearPathContext = false,
    linearByCoordinatesContext = false,
    linearByCoordinatesOrder?: number,
  ): void => {
    if (Array.isArray(node)) {
      node.forEach((child) => {
        visit(
          child,
          itineraryIndex,
          linearPathContext,
          linearByCoordinatesContext,
          linearByCoordinatesOrder,
        );
      });
      return;
    }
    if (!isXmlObject(node)) return;
    const nodeType = elementType(node);
    const inLinearByCoordinates = linearByCoordinatesContext || nodeType === "LinearByCoordinates";
    const inLinearPath =
      !inLinearByCoordinates && (linearPathContext || isLinearPathType(nodeType));
    if (inLinearPath) hasLinearPath = true;
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("@_")) continue;
      const childName = stripXmlNamespace(key);
      if (childName === "locationContainedInItinerary") {
        hasOrderedItinerary = true;
        xmlNodeToArray(value)
          .filter(isXmlObject)
          .forEach((entry, entryPosition) => {
            const rawIndex = getXmlAttribute(entry, "index") ?? getXmlChildText(entry, "index");
            const parsedIndex = rawIndex === undefined ? entryPosition : Number(rawIndex);
            visit(
              entry,
              Number.isFinite(parsedIndex) ? parsedIndex : entryPosition,
              inLinearPath,
              inLinearByCoordinates,
              linearByCoordinatesOrder,
            );
          });
        continue;
      }
      if (childName === "linearByCoordinates") {
        visit(value, itineraryIndex, false, true);
        continue;
      }
      switch (childName) {
        case "posList":
          for (const node of xmlNodeToArray(value)) {
            const coords = parseLatLonList(xmlText(node), reproject, lonFirst);
            if (coords.length >= 2) lines.push(coords);
            else if (coords.length === 1) {
              points.push(coords[0]!);
              if (inLinearByCoordinates) {
                addLinearByCoordinatesPoint(coords[0]!, linearByCoordinatesOrder);
              }
              if (inLinearPath) linearPathPoints.push(coords[0]!);
              if (itineraryIndex !== undefined) {
                indexedItineraryPoints.push({ index: itineraryIndex, point: coords[0]! });
              }
            }
          }
          break;
        case "pos":
          for (const node of xmlNodeToArray(value)) {
            const coords = parseLatLonList(xmlText(node), reproject, lonFirst);
            if (coords[0]) {
              points.push(coords[0]);
              if (inLinearByCoordinates) {
                addLinearByCoordinatesPoint(coords[0], linearByCoordinatesOrder);
              }
              if (inLinearPath) linearPathPoints.push(coords[0]);
              if (itineraryIndex !== undefined) {
                indexedItineraryPoints.push({ index: itineraryIndex, point: coords[0] });
              }
            }
          }
          break;
        // `pointCoordinates` (DATEX v2/v3) and `coordinatesForDisplay`
        // (Trafikverket's representative point) both carry explicit
        // latitude/longitude child leaves — no axis-order ambiguity.
        case "pointCoordinates":
        case "coordinatesForDisplay":
          for (const node of xmlNodeToArray(value)) {
            const lat = Number(getXmlChildText(node, "latitude"));
            const lon = Number(getXmlChildText(node, "longitude"));
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            // Projected feeds (e.g. Flanders) carry grid easting/northing in the
            // longitude/latitude fields; reproject. WGS84 feeds pass through.
            const point = reproject ? reproject([lon, lat]) : ([lon, lat] as [number, number]);
            points.push(point);
            if (inLinearByCoordinates) {
              addLinearByCoordinatesPoint(point, linearByCoordinatesOrder);
            }
            if (inLinearPath) linearPathPoints.push(point);
            if (itineraryIndex !== undefined) {
              indexedItineraryPoints.push({ index: itineraryIndex, point });
            }
          }
          break;
        case "intermediate":
          for (const node of xmlNodeToArray(value)) {
            if (!inLinearByCoordinates) {
              visit(node, itineraryIndex, inLinearPath, false);
              continue;
            }
            hasLinearByCoordinatesIntermediate = true;
            const rawIndex = getXmlAttribute(node, "index") ?? getXmlChildText(node, "index");
            const parsedIndex = rawIndex === undefined ? 0 : Number(rawIndex);
            visit(
              node,
              itineraryIndex,
              false,
              true,
              Number.isFinite(parsedIndex) ? parsedIndex : 0,
            );
          }
          break;
        // A v2 `linearByCoordinates` puts latitude/longitude *directly* under
        // `start`/`end`, where v3 nests a `pointCoordinates` (handled above).
        // Without this a record whose only geometry is its two endpoints —
        // no intermediate points, no GML — resolves to nothing and is dropped.
        case "start":
        case "end": {
          const endpointOrder =
            childName === "start" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
          for (const node of xmlNodeToArray(value)) {
            const lat = Number(getXmlChildText(node, "latitude"));
            const lon = Number(getXmlChildText(node, "longitude"));
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
              const point = reproject ? reproject([lon, lat]) : ([lon, lat] as [number, number]);
              points.push(point);
              if (inLinearByCoordinates) {
                addLinearByCoordinatesPoint(point, linearByCoordinatesOrder ?? endpointOrder);
              }
              if (inLinearPath) linearPathPoints.push(point);
              if (itineraryIndex !== undefined) {
                indexedItineraryPoints.push({ index: itineraryIndex, point });
              }
            } else {
              // `start`/`end` also name non-coordinate things in DATEX; anything
              // that is not a coordinate pair keeps being walked as before.
              visit(
                node,
                itineraryIndex,
                inLinearPath,
                inLinearByCoordinates,
                linearByCoordinatesOrder ?? endpointOrder,
              );
            }
          }
          break;
        }
        default:
          visit(
            value,
            itineraryIndex,
            inLinearPath,
            inLinearByCoordinates,
            linearByCoordinatesOrder,
          );
      }
    }
  };
  visit(locRef);

  if (lines.length === 0 && points.length === 0) {
    // Last resorts, in order of how much they say. A coordinate list under an
    // unnamed element is still a real extent (Hamburg); a lone display point is
    // only a label position (Hessen, Schleswig-Holstein). Both run only when
    // nothing better was found, so neither can override real geometry.
    for (const coords of unnamedCoordinateLists(locRef, reproject, lonFirst)) lines.push(coords);
  }
  if (lines.length === 0 && points.length === 0) {
    for (const p of displayCoordinates(locRef, reproject)) points.push(p);
  }

  // A feed publishing a projected grid it never declared looks identical to one
  // publishing degrees until the numbers land in the database, where nothing can
  // recover them. Dropping the record makes that visible in the skip count
  // instead of placing it thousands of kilometres away.
  const usableLines = lines.filter((l) => l.every(isPlausibleWgs84));
  const usablePoints = points.filter(isPlausibleWgs84);

  if (usableLines.length === 1) return { type: "LineString", coordinates: usableLines[0]! };
  if (usableLines.length > 1) return { type: "MultiLineString", coordinates: usableLines };
  if (hasOrderedItinerary) {
    const ordered = indexedItineraryPoints
      .filter(({ point }) => isPlausibleWgs84(point))
      .sort((a, b) => a.index - b.index)
      .map(({ point }) => point);
    if (ordered.length === 1) return { type: "Point", coordinates: ordered[0]! };
    if (ordered.length > 1) return { type: "LineString", coordinates: ordered };
  }
  if (hasLinearByCoordinatesIntermediate) {
    const ordered = linearByCoordinatesPoints
      .filter(({ point }) => isPlausibleWgs84(point))
      .sort((a, b) => a.order - b.order || a.sequence - b.sequence)
      .map(({ point }) => point);
    if (ordered.length === 1) return { type: "Point", coordinates: ordered[0]! };
    if (ordered.length > 1) return { type: "LineString", coordinates: ordered };
  }
  if (hasLinearPath) {
    const ordered = linearPathPoints.filter(isPlausibleWgs84);
    if (ordered.length === 1) return { type: "Point", coordinates: ordered[0]! };
    if (ordered.length > 1) return { type: "LineString", coordinates: ordered };
  }
  if (usablePoints.length === 1) return { type: "Point", coordinates: usablePoints[0]! };
  if (usablePoints.length > 1) return { type: "MultiPoint", coordinates: usablePoints };
  return null;
}

/** The diversion route geometry from an `alternativeRoute`, when it is linear. */
function detourGeometryOf(
  rec: XmlObject,
  reproject?: Reprojector | null,
  lonFirst = false,
): RoadEvent["detourGeometry"] {
  const g = resolveGeometryFrom(getXmlChild(rec, "alternativeRoute"), reproject, lonFirst);
  return g && (g.type === "LineString" || g.type === "MultiLineString") ? g : undefined;
}

const DAYS = standardValues(DATEX2_V3.days, DATEX2_V2.days);
const MONTHS = standardValues(DATEX2_V3.months, DATEX2_V2.months);

/** `DayEnum` as iCal day codes. */
const ICAL_DAY: Readonly<Record<string, string>> = {
  monday: "MO",
  tuesday: "TU",
  wednesday: "WE",
  thursday: "TH",
  friday: "FR",
  saturday: "SA",
  sunday: "SU",
};

/** `MonthOfYearEnum` as month numbers. */
const MONTH: Readonly<Record<string, number>> = Object.fromEntries(
  DATEX2_V2.months.map((month, i) => [month, i + 1]),
);

/**
 * One DATEX `Period` as schedules: within its `startOfPeriod`/`endOfPeriod`,
 * on the days and months each `recurringDayWeekMonthPeriod` names, during each
 * `recurringTimePeriodOfDay`. Several days-of-week groups or times of day are
 * alternatives, so the period is one schedule per pairing. A group naming any
 * day or month outside the enumeration (or none it can read) is reported:
 * kept without it, the group would apply on fewer days than the source
 * says, or on every day.
 */
function periodSchedules(period: XmlObject, unsupported: Set<string>): LocalSchedule[] {
  const times = getXmlChildren(period, "recurringTimePeriodOfDay").map((tod) => ({
    startTime: getXmlChildText(tod, "startTimeOfPeriod"),
    endTime: getXmlChildText(tod, "endTimeOfPeriod"),
  }));
  const calendars = getXmlChildren(period, "recurringDayWeekMonthPeriod").map((group) => {
    const declared = (name: string) => xmlNodeToArray(group[name]).map(text);
    if (declared("applicableWeek").length > 0) unsupported.add("applicableWeek");
    const days = declared("applicableDay");
    const months = declared("applicableMonth");
    const byDay = days.flatMap((d) => entryOf(ICAL_DAY, d) ?? []);
    const byMonth = months.flatMap((m) => entryOf(MONTH, m) ?? []);
    if (byDay.length < days.length || byMonth.length < months.length) {
      unsupported.add("recurringDayWeekMonthPeriod");
    }
    return {
      ...(byDay.length > 0 ? { byDay } : {}),
      ...(byMonth.length > 0 ? { byMonth } : {}),
    };
  });
  const startDate = getXmlChildText(period, "startOfPeriod");
  const endDate = getXmlChildText(period, "endOfPeriod");
  const out: LocalSchedule[] = [];
  for (const time of times.length > 0 ? times : [{}]) {
    for (const calendar of calendars.length > 0 ? calendars : [{}]) {
      const win = buildLocalSchedule({ startDate, endDate, ...time, ...calendar });
      // A period with neither a date range, a time of day nor a calendar says nothing.
      if (win.startDate || win.endDate || win.startTime || win.byDay || win.byMonth) {
        out.push(win);
      }
    }
  }
  return out;
}

/** The time specification's members the schedule reading consumes. */
const SUPPORTED_TIME_SPEC_CHILDREN = new Set([
  "overallStartTime",
  "overallEndTime",
  "overallBidirectionalReference",
  "validPeriod",
  "exceptionPeriod",
]);
const SUPPORTED_PERIOD_CHILDREN = new Set([
  "startOfPeriod",
  "endOfPeriod",
  "periodName",
  "recurringTimePeriodOfDay",
  "recurringDayWeekMonthPeriod",
]);

/**
 * A DATEX `validityTimeSpecification` as schedules: its `validPeriod`s, in
 * which the record applies, and its `exceptionPeriod`s, in which it does not.
 * The overall start and end stay on validFrom/validTo. `unsupported` names
 * the members the schedules cannot carry (special days and public holidays,
 * weeks of the month, extensions): each changes when the record applies, so
 * the rest must not stand for the whole rule.
 */
function timeSpecOf(timeSpec: XmlObject | undefined): {
  periods?: LocalSchedule[];
  exceptions?: LocalSchedule[];
  unsupported: string[];
} {
  if (!timeSpec) return { unsupported: [] };
  const unsupported = new Set<string>();
  for (const key of Object.keys(timeSpec)) {
    if (key.startsWith("@_")) continue;
    const name = stripXmlNamespace(key);
    if (!SUPPORTED_TIME_SPEC_CHILDREN.has(name)) unsupported.add(name);
  }
  const read = (name: string) =>
    getXmlChildren(timeSpec, name).flatMap((period) => {
      for (const key of Object.keys(period)) {
        if (key.startsWith("@_")) continue;
        const member = stripXmlNamespace(key);
        if (!SUPPORTED_PERIOD_CHILDREN.has(member)) unsupported.add(member);
      }
      return periodSchedules(period, unsupported);
    });
  const periods = read("validPeriod");
  const exceptions = read("exceptionPeriod");
  return {
    ...(periods.length > 0 ? { periods } : {}),
    ...(exceptions.length > 0 ? { exceptions } : {}),
    unsupported: [...unsupported],
  };
}

/**
 * The restriction contract's recurrences: `validPeriod`s that genuinely
 * repeat, by a time of day or a calendar, as opposed to one that merely
 * restates the overall window, which the overall start and end already say.
 * The contract has no place for exception periods, so they stay unsupported.
 */
function restrictionScheduleOf(
  timeSpec: XmlObject | undefined,
  geometry: Geometry | null,
): { schedule?: Schedule[]; inexact: boolean } {
  if (!timeSpec) return { inexact: false };
  const recurring = getXmlChildren(timeSpec, "validPeriod").some(
    (period) =>
      getXmlChildren(period, "recurringTimePeriodOfDay").length > 0 ||
      getXmlChildren(period, "recurringDayWeekMonthPeriod").length > 0,
  );
  if (!recurring || !geometry) return { inexact: false };
  const timezone = scheduleTimezoneForGeometry(geometry);
  if (!timezone) return { inexact: false };
  const { schedules, inexact } = zonedPeriods(timeSpecOf(timeSpec).periods, timezone, {
    start: text(timeSpec["overallStartTime"]),
    end: text(timeSpec["overallEndTime"]),
  });
  return { ...(schedules ? { schedule: schedules } : {}), inexact };
}

function directionOf(rec: XmlObject): string | undefined {
  const locRef = getXmlChild(rec, "locationReference");
  if (!locRef) return undefined;

  const pointByCoords = getXmlChild(locRef, "pointByCoordinates");
  if (pointByCoords) {
    const bearing = text(pointByCoords["bearing"]);
    if (bearing) return bearing;
  }

  const alertCDir = getXmlChild(getXmlChild(locRef, "alertCPoint"), "alertCDirection");
  return text(alertCDir?.["alertCDirectionCoded"]);
}

const ALERT_C_DIRECTIONS: Record<string, "positive" | "negative" | "both"> = {
  positive: "positive",
  negative: "negative",
  both: "both",
  bothWays: "both",
};

/** One Alert-C reference block found in a selected location alternative. */
interface AlertCDirectionRef {
  value: "positive" | "negative" | "both" | "unknown";
  directionCoded: string | null;
  affectedDirection: string | null;
  refs: Record<string, unknown>;
}

/**
 * The record's own location alternatives. A DATEX itinerary lists them under
 * `locationContainedInItinerary`; any other location reference is a single
 * alternative. Reading these explicitly keeps direction tied to the location
 * that declared it, instead of the first direction token found anywhere.
 */
function locationAlternatives(locRef: XmlObject): XmlObject[] {
  const itinerary = getXmlChildren(locRef, "locationContainedInItinerary");
  if (itinerary.length === 0) return [locRef];
  return itinerary.map((entry) => getXmlChild(entry, "location") ?? entry);
}

function alertCDirectionIn(location: XmlObject): AlertCDirectionRef | null {
  const block = getXmlChild(location, "alertCLinear") ?? getXmlChild(location, "alertCPoint");
  if (!block) return null;
  const direction = getXmlChild(block, "alertCDirection");
  // An empty element states no direction.
  const filled = (value: string | undefined) => (value?.trim() ? value : null);
  const directionCoded = filled(getXmlChildText(direction, "alertCDirectionCoded"));
  const affectedDirection = filled(getXmlChildText(direction, "alertCAffectedDirection"));
  const refs: Record<string, unknown> = { scheme: "alert_c" };
  const put = (key: string, value: string | undefined) => {
    if (value !== undefined) refs[key] = value;
  };
  put("countryCode", getXmlChildText(block, "alertCLocationCountryCode"));
  // Table number and version are separate source fields; concatenating them
  // would invent an identifier the publisher never issued.
  put("tableNumber", getXmlChildText(block, "alertCLocationTableNumber"));
  put("tableVersion", getXmlChildText(block, "alertCLocationTableVersion"));
  put(
    "primaryLocation",
    getXmlChildText(
      getXmlChild(getXmlChild(block, "alertCMethod4PrimaryPointLocation"), "alertCLocation"),
      "specificLocation",
    ),
  );
  put(
    "secondaryLocation",
    getXmlChildText(
      getXmlChild(getXmlChild(block, "alertCMethod4SecondaryPointLocation"), "alertCLocation"),
      "specificLocation",
    ),
  );
  if (directionCoded !== null) refs["directionCoded"] = directionCoded;
  if (affectedDirection !== null) refs["affectedDirection"] = affectedDirection;
  return {
    value:
      directionCoded === null
        ? "unknown"
        : (entryOf(ALERT_C_DIRECTIONS, directionCoded) ?? "unknown"),
    directionCoded,
    affectedDirection,
    refs,
  };
}

/**
 * Source direction for restriction facts, read from the record's own selected
 * location alternatives. The value stays in its declared reference scheme: an
 * Alert-C `positive` is not an OSM forward orientation, and mapping it to one
 * would need the location table this parser does not consult.
 */
function restrictionDirectionOf(rec: XmlObject): {
  direction: RoadRestrictionFact["direction"];
  sourceLocationRefs: Record<string, unknown>;
  issues: RestrictionIssue[];
} {
  const unknown = {
    direction: { basis: "unknown" as const, value: "unknown" as const, description: null },
    sourceLocationRefs: {} as Record<string, unknown>,
    issues: [] as RestrictionIssue[],
  };
  const locRef = getXmlChild(rec, "locationReference") ?? getXmlChild(rec, "groupOfLocations");
  if (!locRef) return unknown;

  const found = locationAlternatives(locRef)
    .map(alertCDirectionIn)
    .filter((entry): entry is AlertCDirectionRef => entry !== null);
  if (found.length === 0) {
    const openlr = collectOpenLr(rec);
    if (openlr === undefined) return unknown;
    return { ...unknown, sourceLocationRefs: { scheme: "openlr", openlr } };
  }

  const refs = found[0]!.refs;
  const declared = found.filter((entry) => entry.directionCoded !== null);
  const distinct = new Set(declared.map((entry) => entry.value));
  if (distinct.size > 1) {
    return {
      direction: { basis: "alert_c", value: "unknown", description: null },
      sourceLocationRefs: refs,
      issues: [
        {
          code: "conflicting_direction",
          factId: null,
          sourcePath: "situationRecord.locationReference",
          sourceTokens: {
            directionCoded: declared.map((entry) => entry.directionCoded),
          },
        },
      ],
    };
  }

  const chosen = declared[0] ?? found[0]!;
  return {
    direction: {
      basis: "alert_c",
      value: chosen.value,
      description: chosen.affectedDirection,
    },
    sourceLocationRefs: refs,
    issues: [],
  };
}

function roadsOf(rec: XmlObject): import("./model.js").RoadRef[] {
  // v2 feeds (e.g. Straßen.NRW) put the location under `groupOfLocations` and
  // nest the road under `roadInformation`, not directly on `locationReference`.
  const locRef = getXmlChild(rec, "locationReference") ?? getXmlChild(rec, "groupOfLocations");
  if (!locRef) return [];
  const pointLoc = getXmlChild(locRef, "pointLocation");

  // roadName/roadNumber may be a plain leaf or a multilingual object, and may sit
  // a few levels down (roadInformation > roadNumber / roadDirection). DATEX v3
  // names a road only in supplementaryPositionalDescription/roadInformation (a
  // plain string, where DGT and CITA put it, and where our own export writes it)
  // or on a linearElement (multilingual); a name there outranks a direction.
  // Only a multilingual name says which language it is in; it keeps every one.
  const names =
    plainName(getXmlChildText(locRef, "roadName")) ??
    multilingualText(getXmlChild(locRef, "roadName")) ??
    plainName(getXmlChildText(pointLoc, "roadName")) ??
    plainName(
      descendantsNamed(locRef, "roadInformation")
        .map((info) => getXmlChildText(info, "roadName"))
        .find((name) => name !== undefined),
    ) ??
    descendantsNamed(locRef, "linearElement")
      .map((element) => multilingualText(getXmlChild(element, "roadName")))
      .find((name) => name !== undefined) ??
    multilingualText(findFirst(locRef, "roadDirection"));
  const roadRef =
    getXmlChildText(locRef, "roadNumber") ??
    getXmlChildText(pointLoc, "roadNumber") ??
    collectLeaf(locRef, "roadNumber")[0];

  const [primary] = names ?? [];
  if (!primary && !roadRef) return [];
  return [
    {
      ...(primary ? { name: primary.text } : {}),
      ...(primary && primary.lang !== UNDETERMINED ? { nameLang: primary.lang } : {}),
      ...(names && names.length > 1 ? { names } : {}),
      ref: roadRef,
    },
  ];
}

/** A road name given as a plain string, in no stated language. */
function plainName(name: string | undefined): Text | undefined {
  const trimmed = name?.trim();
  return trimmed ? [{ lang: UNDETERMINED, text: trimmed }] : undefined;
}

/**
 * The state of the road a `RoadOrCarriagewayOrLaneManagementTypeEnum` value
 * declares, by the enumeration's own definitions. Values that manage lanes
 * without closing or opening the road (`narrowLanes`, `hardShoulderRunning…`,
 * `keepToTheLeft`) declare none. `contraflow` ("two-way traffic is temporarily
 * sharing a single carriageway") is not alternating single-lane working; the
 * record is typed a contraflow instead.
 */
const ROAD_STATES: Readonly<Record<string, RoadEvent["roadState"]>> = {
  // "The road is closed to vehicles with the specified characteristics or all."
  roadClosed: "closed",
  // "Carriageway closures are in operation at the specified location."
  carriagewayClosures: "closed",
  // Closed for the duration of the winter, every night, or intermittently for
  // short durations; a schedule the record carries narrows when.
  closedPermanentlyForTheWinter: "closed",
  overnightClosures: "closed",
  intermittentShortTermClosures: "closed",
  // "Traffic is being directed back down the opposite carriageway."
  turnAroundInOperation: "closed",
  laneClosures: "some_lanes_closed",
  // "Do not use the specified lane(s) or carriageway(s)."
  doNotUseSpecifiedLanesOrCarriageways: "some_lanes_closed",
  // "Traffic is being controlled to move in alternate single lines."
  singleAlternateLineTraffic: "single_lane_alternating",
  // "The road has been cleared of earlier reported problems."
  roadCleared: "open",
};

function roadStateOf(rec: XmlObject): RoadEvent["roadState"] | undefined {
  const raw = getXmlChildText(rec, "roadOrCarriagewayOrLaneManagementType");
  return entryOf(ROAD_STATES, raw);
}

/**
 * The record's lane counts. `numberOfLanesRestricted` counts the normally
 * usable lanes "restricted either fully or partially": a narrowed or shifted
 * lane is restricted and still open, so the count is not of closed lanes and
 * never reads as one. `numberOfOperationalLanes` counts the lanes that remain
 * fully operational. The lane total is the `originalNumberOfLanes`, else the
 * restricted and operational lanes together. The counts live under `impact`
 * (older feeds put them on the record).
 */
function lanesOf(rec: XmlObject): RoadEvent["lanesAffected"] | undefined {
  const impact = getXmlChild(rec, "impact");
  const count = (name: string): number | undefined => {
    const raw = getXmlChildText(impact, name) ?? getXmlChildText(rec, name);
    const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  };
  const restricted = count("numberOfLanesRestricted");
  const operational = count("numberOfOperationalLanes");
  // v2.3 states the original lane count in the impact, v3 on the location's carriageway.
  const declared = leafNumber(rec, "originalNumberOfLanes");
  const original =
    declared !== undefined && Number.isSafeInteger(declared) && declared >= 0
      ? declared
      : undefined;
  const total =
    original !== undefined && original > 0
      ? original
      : restricted !== undefined && operational !== undefined && restricted + operational > 0
        ? restricted + operational
        : undefined;
  const lanes = {
    ...(total !== undefined ? { total } : {}),
    ...(restricted !== undefined ? { restricted } : {}),
    ...(operational !== undefined ? { operational } : {}),
  };
  return Object.keys(lanes).length > 0 ? lanes : undefined;
}

/**
 * The most specific source sub-classification for the record. The cause's
 * causeType wins when present (e.g. "roadMaintenance"); otherwise the record's
 * own typed discriminator is used — each DATEX situationRecord subclass carries
 * its own (accidentType, obstructionType, generalNetworkManagementType for
 * movable-bridge openings, abnormalTrafficType for congestion detail,
 * speedManagementType, …), then the discriminator the record class declares in
 * either DATEX version. Without this, those records fell back to the generic
 * record class name and lost their specific kind.
 */
function subtypeOf(rec: XmlObject, recordClass: string): string | undefined {
  const discriminator = datexDiscriminator(recordClass);
  // `_extended` names no kind: its meaning lives in an extension schema.
  return [
    getXmlChildText(getXmlChild(rec, "cause"), "causeType"),
    ...[
      "accidentType",
      "obstructionType",
      "environmentalObstructionType",
      "vehicleObstructionType",
      "generalNetworkManagementType",
      "abnormalTrafficType",
      "speedManagementType",
      ...(discriminator === undefined ? [] : [discriminator]),
    ].map((name) => getXmlChildText(rec, name)),
  ].find((value) => value !== undefined && value !== "_extended");
}

/** Human cause text (DATEX `cause/causeDescription`), a multilingual block. */
function causeDescriptionOf(rec: XmlObject): string | undefined {
  return multilingual(getXmlChild(getXmlChild(rec, "cause"), "causeDescription"), "en");
}

/**
 * All `<generalPublicComment>` entries on the record as `{ type, text }`. `type`
 * is the DATEX `commentExtension/commentExtended/commentType2` discriminator —
 * publishers like Straßen.NRW (Mobilithek) carry SEVERAL comments per record,
 * each a distinct field: e.g. `roadworksName` (the title), `roadworksType` (what
 * the work is), `routeRecommendation` (the diversion). `text` is the best
 * language match (preferred lang, else the first value), so non-English feeds
 * still resolve. Handles both a single element and a repeated array — the latter
 * is what broke the old single-node `multilingual()` lookup (it returned the
 * default headline for every multi-comment record).
 *
 * Without that extension, the comment's own `commentType` (v2 and v3) names
 * what it is where it says: a description, the works' name. A comment the
 * publisher marks as an internal or data-processing note is not for the
 * public; nothing downstream withholds a comment, so it is not read at all.
 */
function publicComments(rec: XmlObject, lang = "en"): PublicComment[] {
  const out: PublicComment[] = [];
  for (const gpc of getXmlChildren(rec, "generalPublicComment")) {
    const declared = getXmlChildText(gpc, "commentType");
    if (isNonPublicComment(gpc)) continue;
    const t = multilingual(gpc, lang);
    const all = multilingualText(gpc);
    if (!t || !all) continue;
    const type =
      getXmlChildText(
        getXmlChild(getXmlChild(gpc, "commentExtension"), "commentExtended"),
        "commentType2",
      ) ?? entryOf(COMMENT_ROLES, declared);
    out.push(type ? { type, text: t, all } : { text: t, all });
  }
  return out;
}

/**
 * DATEX `commentType` values (v2 and v3) as the role the headline and
 * description choice reads; the other public ones are plain comments.
 */
const COMMENT_ROLES: Readonly<Record<string, string>> = {
  description: "description",
  roadworksName: "roadworksName",
};
/** Every `commentType` this reader knows, public or not. */
const COMMENT_TYPES = new Set([
  "description",
  "roadworksName",
  "locationDescriptor",
  "warning",
  "other",
  "abnormalLoadMovementNote",
  ...NON_PUBLIC_COMMENT_TYPES,
]);

/** One `generalPublicComment`: its best-language text, and every language it carries. */
interface PublicComment {
  type?: string;
  text: string;
  all: Text;
}

function speedLimitOf(rec: XmlObject): number | undefined {
  const raw = getXmlChildText(rec, "temporarySpeedLimit");
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function detourOf(rec: XmlObject): string | undefined {
  const node = getXmlChild(rec, "reroutingItineraryDescription");
  return (
    multilingual(node, "en") ??
    getXmlChildText(rec, "reroutingItineraryDescription") ??
    getXmlChildText(rec, "reroutingManagementType")
  );
}

/** The record's creation reference and the situations its situation names as related. */
function relatedRefsOf(rec: XmlObject, situations: readonly string[] = []): string[] | undefined {
  const ref = getXmlChildText(rec, "situationRecordCreationReference");
  const out = [...new Set([...(ref ? [ref] : []), ...situations])];
  return out.length > 0 ? out : undefined;
}

function confidenceOf(rec: XmlObject): Confidence | undefined {
  switch (getXmlChildText(rec, "probabilityOfOccurrence")?.toLowerCase()) {
    case "certain":
      return "observed";
    case "probable":
      return "likely";
    case "riskof":
      return "possible";
    case "improbable":
      return "unknown";
    default:
      return undefined;
  }
}

/** First descendant element (anywhere in the subtree) with the given local name. */
function findFirst(node: unknown, localName: string): XmlObject | undefined {
  if (Array.isArray(node)) {
    for (const x of node) {
      const f = findFirst(x, localName);
      if (f) return f;
    }
    return undefined;
  }
  if (!isXmlObject(node)) return undefined;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    if (stripXmlNamespace(key) === localName && isXmlObject(value)) return value;
    const f = findFirst(value, localName);
    if (f) return f;
  }
  return undefined;
}

/** All descendant elements (anywhere in the subtree) with the given local name, in document order. */
function descendantsNamed(node: unknown, localName: string, out: XmlObject[] = []): XmlObject[] {
  if (Array.isArray(node)) {
    for (const x of node) descendantsNamed(x, localName, out);
    return out;
  }
  if (!isXmlObject(node)) return out;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    if (stripXmlNamespace(key) === localName) {
      out.push(...xmlNodeToArray(value).filter(isXmlObject));
    }
    descendantsNamed(value, localName, out);
  }
  return out;
}

/** All leaf text values (anywhere in the subtree) of elements with the given local name. */
function collectLeaf(node: unknown, localName: string, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const x of node) collectLeaf(x, localName, out);
    return out;
  }
  if (!isXmlObject(node)) return out;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    if (stripXmlNamespace(key) === localName) {
      const t = xmlText(value);
      if (t) out.push(t);
    }
    collectLeaf(value, localName, out);
  }
  return out;
}

/**
 * Vehicles a measure applies to. Only the record's own applicability role
 * counts: vehicles obstructing the road or involved in an accident are
 * participants, and publishing them here would state that a closure applies to
 * the breakdown truck that caused it.
 */
function vehiclesAffectedOf(rec: XmlObject): string[] | undefined {
  return datexApplicabilityVehicles(rec);
}

/** Objects that directly carry a named value, so sibling comparator tokens stay associated with it. */
function valueContexts(node: unknown, localName: string, out: XmlObject[] = []): XmlObject[] {
  if (Array.isArray(node)) {
    for (const item of node) valueContexts(item, localName, out);
    return out;
  }
  if (!isXmlObject(node)) return out;
  if (Object.keys(node).some((key) => stripXmlNamespace(key) === localName)) out.push(node);
  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith("@_")) valueContexts(value, localName, out);
  }
  return out;
}

/**
 * DATEX sources whose applicability has been verified against a real capture
 * and may therefore publish normalized restriction evidence. A source is added
 * here only with its own reviewed records, units and comparator semantics —
 * never because the generic parser happens to recognize a similarly named leaf.
 */
const RESTRICTION_CONTRACT_SOURCES = new Set(["nl-ndw-events"]);

function restrictionDetailsFor(
  rec: XmlObject,
  src: SourceDescriptor,
  context: DatexRestrictionContext,
): RoadRestrictionDetailsV1 | undefined {
  if (!RESTRICTION_CONTRACT_SOURCES.has(src.id)) return undefined;
  return datexRestrictionDetails(rec, src, context);
}

/**
 * The legacy numeric `restrictions` array for a verified source, derived from
 * the normalized facts so it can never carry a dimension whose unit was not
 * established. An unsupported predicate stays absent here and visible as an
 * issue on the envelope.
 */
function legacyRestrictionsOf(
  details: RoadRestrictionDetailsV1 | undefined,
): Restriction[] | undefined {
  if (!details) return undefined;
  const out: Restriction[] = [];
  for (const fact of details.facts) {
    if (fact.kind !== "dimension") continue;
    out.push({
      type: fact.dimension === "gross_weight" ? "weight" : fact.dimension,
      value: fact.value,
      unit: fact.unit,
      operator: fact.operator,
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Dimension/weight restrictions (vehicleHeight/Width/Length, gross weight). */
function dimensionRestrictionsOf(rec: XmlObject): Restriction[] | undefined {
  const out: Restriction[] = [];
  const dim = (name: string, type: string, unit: string) => {
    for (const context of valueContexts(rec, name)) {
      const raw = collectLeaf(context, name)[0];
      const n = raw != null ? Number(raw) : NaN;
      if (!Number.isFinite(n)) continue;
      const operator = collectLeaf(context, "comparisonOperator")[0];
      out.push({
        type,
        value: n,
        unit,
        ...(operator ? { operator } : {}),
        raw: { value: raw, ...(operator ? { comparisonOperator: operator } : {}) },
      });
    }
  };
  dim("vehicleHeight", "height", "m");
  dim("vehicleWidth", "width", "m");
  dim("vehicleLength", "length", "m");
  // DATEX II defines grossVehicleWeight in tonnes (its `Tonnes` type).
  dim("grossVehicleWeight", "weight", "t");
  return out.length > 0 ? out : undefined;
}

function leafNumber(rec: XmlObject, name: string): number | undefined {
  const raw = collectLeaf(rec, name)[0];
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Extracts an OpenLR base64 string from the record's locationReference, if
 * present. Tries several common element names used by DATEX II v2 and v3.
 */
function collectOpenLr(rec: XmlObject): string | undefined {
  const locRef = getXmlChild(rec, "locationReference");

  if (locRef) {
    const candidates = ["openlrBinary", "base64", "openLRBinary"];
    for (const name of candidates) {
      const val = getXmlChildText(locRef, name);
      if (val) return val;
    }
  }

  return getXmlChildText(rec, "openlrBinary") ?? undefined;
}

/** The location code under a primary/secondary point-location wrapper. */
function specificLocationOf(wrapper: XmlObject | undefined, strict = false): number | undefined {
  const raw = getXmlChildText(getXmlChild(wrapper, "alertCLocation"), "specificLocation");
  if (!raw || (strict && !/^\d+$/.test(raw))) return undefined;
  const code = parseInt(raw, 10);
  // 0 is the format's "no location" placeholder — some publishers emit an
  // otherwise-empty Alert-C block rather than omitting it.
  return Number.isSafeInteger(code) && code > 0 ? code : undefined;
}

/** Presence, including empty/malformed elements, matters for VILD refusal. */
function hasElement(node: unknown, name: string): boolean {
  if (Array.isArray(node)) return node.some((child) => hasElement(child, name));
  if (!isXmlObject(node)) return false;
  return Object.entries(node).some(
    ([key, child]) =>
      !key.startsWith("@_") && (stripXmlNamespace(key) === name || hasElement(child, name)),
  );
}

/**
 * The full Alert-C reference on a record, if it carries one.
 *
 * v2 publishers (the German state feeds) nest the location under
 * `groupOfLocations` while v3 uses `locationReference`; both are searched
 * because the German feeds are precisely the ones this exists to resolve.
 */
function alertCBlockOf(rec: XmlObject): XmlObject | undefined {
  const locRef = getXmlChild(rec, "locationReference") ?? getXmlChild(rec, "groupOfLocations");
  if (!locRef) return undefined;
  // Either a nested `alertCPoint`/`alertCLinear` element, or — where the
  // location element is itself declared an Alert-C type — the same fields
  // inline on it, with no wrapper. Both are valid DATEX and publishers differ.
  const inline = /^AlertC/i.test(stripXmlNamespace(getXmlAttribute(locRef, "type") ?? ""));
  return (
    findFirst(locRef, "alertCPoint") ??
    findFirst(locRef, "alertCLinear") ??
    (inline ? locRef : undefined)
  );
}

function alertCRefOf(rec: XmlObject): VildReference | undefined {
  const alertC = alertCBlockOf(rec);
  if (!alertC) return undefined;

  // A missing/placeholder primary is reported as `no-reference` by the resolver
  // rather than bailing here: "the record has no Alert-C block at all" and "it
  // has one but names no location" call for different fixes, and collapsing
  // them into one silent absence is what hid this loss in the first place.
  const country = getXmlChildText(alertC, "alertCLocationCountryCode");
  const strict = country?.trim() === "8";
  const primary = specificLocationOf(
    findFirst(alertC, "alertCMethod4PrimaryPointLocation") ??
      findFirst(alertC, "alertCMethod2PrimaryPointLocation"),
    strict,
  );

  const secondary = specificLocationOf(
    findFirst(alertC, "alertCMethod4SecondaryPointLocation") ??
      findFirst(alertC, "alertCMethod2SecondaryPointLocation"),
    strict,
  );

  return {
    type: stripXmlNamespace(getXmlAttribute(alertC, "type") ?? ""),
    hasOffsets: hasElement(alertC, "offsetDistance"),
    hasSecondary:
      hasElement(alertC, "alertCMethod2SecondaryPointLocation") ||
      hasElement(alertC, "alertCMethod4SecondaryPointLocation"),
    ...(getXmlChildText(alertC, "alertCLocationCountryCode")
      ? { country: getXmlChildText(alertC, "alertCLocationCountryCode") }
      : {}),
    ...(getXmlChildText(alertC, "alertCLocationTableNumber")
      ? { table: getXmlChildText(alertC, "alertCLocationTableNumber") }
      : {}),
    ...(getXmlChildText(alertC, "alertCLocationTableVersion")
      ? { version: getXmlChildText(alertC, "alertCLocationTableVersion") }
      : {}),
    ...(primary !== undefined ? { primary } : {}),
    ...(secondary !== undefined ? { secondary } : {}),
  };
}

/**
 * A compact description of how a record says where it is: the location
 * element's declared type plus its child element names. Emitted only for
 * records we failed to place, to name the referencing scheme that lost them.
 */
function locationShapeOf(rec: XmlObject): string {
  const locRef = getXmlChild(rec, "locationReference") ?? getXmlChild(rec, "groupOfLocations");
  if (!locRef) return "(no location element)";
  const type = getXmlAttribute(locRef, "type");
  const children = Object.keys(locRef)
    .filter((k) => !k.startsWith("@_"))
    .map((k) => {
      // One level in, because the child's own name rarely says whether the
      // record is placeable — `linearWithinLinearElement` could hold a road
      // reference or coordinates, and only its contents distinguish them.
      const inner = locRef[k];
      const grandchildren = isXmlObject(inner)
        ? Object.keys(inner)
            .filter((g) => !g.startsWith("@_"))
            .map(stripXmlNamespace)
            .sort()
        : [];
      return grandchildren.length > 0
        ? `${stripXmlNamespace(k)}>${grandchildren.join(",")}`
        : stripXmlNamespace(k);
    })
    .sort();
  // Plus the leaf names anywhere beneath, which is what actually says whether
  // a record is placeable: a wrapper called `any` or `extension` reveals
  // nothing, while the leaves it holds name the referencing scheme.
  const leaves = new Set<string>();
  const collect = (n: unknown, depth: number): void => {
    if (depth > 6 || leaves.size > 12) return;
    if (Array.isArray(n)) {
      n.forEach((x) => {
        collect(x, depth);
      });
      return;
    }
    if (!isXmlObject(n)) return;
    for (const [k, v] of Object.entries(n)) {
      if (k.startsWith("@_")) continue;
      if (isXmlObject(v) || Array.isArray(v)) collect(v, depth + 1);
      else leaves.add(stripXmlNamespace(k));
    }
  };
  collect(locRef, 0);

  const head = `${type ? `${stripXmlNamespace(type)}:` : ""}${children.join("+") || "(empty)"}`;
  if (leaves.size === 0) return head;

  // Where the leaves are as opaque as the wrappers (`any` inside `any`), names
  // alone cannot say what the referencing scheme is. A short excerpt of the
  // values can, and it is the difference between another guess and a fix.
  const opaque = [...leaves].every((l) => /^(any|value|extension|content)$/i.test(l));
  const detail = opaque ? ` ≈${JSON.stringify(locRef).slice(0, 160)}` : "";
  return `${head}{${[...leaves].sort().join(",")}}${detail}`;
}

/** Alert-C `alertCDirectionCoded` as the TMC direction bit. */
const ALERT_C_DIRECTION_BITS: Readonly<Record<string, 0 | 1>> = { positive: 0, negative: 1 };
/** `alertCAffectedDirection` values that say which way is affected; `unknown` says none. */
const ALERT_C_AFFECTED = new Set(["aligned", "opposite", "both"]);

/** The distance of a method-4 point from its location, in metres. */
function offsetOf(wrapper: XmlObject | undefined): number | undefined {
  const node = getXmlChild(wrapper, "offsetDistance");
  const raw = getXmlChildText(node, "offsetDistance") ?? text(node);
  const metres = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(metres) && metres >= 0 ? metres : undefined;
}

/**
 * Alert-C/TMC reference: country, table and primary location, and where the
 * record states them, its secondary location, coded and affected direction,
 * method and the method-4 offsets, kept beside any coordinates.
 */
function tmcOf(rec: XmlObject): NonNullable<RoadEvent["externalRefs"]>["tmc"] | undefined {
  const ref = alertCRefOf(rec);
  if (!ref?.country || !ref.table || ref.primary === undefined) return undefined;
  if (!/^\d+(?:\.\d+)?$/.test(ref.table)) return undefined;
  const table = Number(ref.table);
  // Alert-C table numbers are small whole numbers; past the safe integers a
  // number is no table, and it would not survive being written back.
  if (!Number.isSafeInteger(Math.trunc(table))) return undefined;
  const version = Number.isInteger(table)
    ? ref.version
    : [ref.table, ref.version].filter(Boolean).join(".");
  const block = alertCBlockOf(rec);
  const coded = getXmlChildText(getXmlChild(block, "alertCDirection"), "alertCDirectionCoded");
  const affected = getXmlChildText(
    getXmlChild(block, "alertCDirection"),
    "alertCAffectedDirection",
  );
  const method = /Method([24])/.exec(ref.type ?? "")?.[1];
  const primaryOffset = offsetOf(findFirst(block, "alertCMethod4PrimaryPointLocation"));
  const secondaryOffset = offsetOf(findFirst(block, "alertCMethod4SecondaryPointLocation"));
  const direction = entryOf(ALERT_C_DIRECTION_BITS, coded);
  return {
    country: ref.country,
    table,
    ...(version ? { version } : {}),
    code: ref.primary,
    ...(ref.secondary !== undefined ? { secondary: ref.secondary } : {}),
    ...(direction !== undefined ? { direction } : {}),
    ...(affected !== undefined && ALERT_C_AFFECTED.has(affected)
      ? { affectedDirection: affected as "aligned" | "opposite" | "both" | "unknown" }
      : {}),
    ...(method !== undefined ? { method: Number(method) as 2 | 4 } : {}),
    ...(primaryOffset !== undefined ? { primaryOffsetM: primaryOffset } : {}),
    ...(secondaryOffset !== undefined ? { secondaryOffsetM: secondaryOffset } : {}),
  };
}

/** Provider external location code (NDW's `externalReferencing`, e.g. RIS-index). */
function externalLocationOf(rec: XmlObject): { system: string; code: string } | undefined {
  const er = getXmlChild(getXmlChild(rec, "locationReference"), "externalReferencing");
  const system = getXmlChildText(er, "externalReferencingSystem");
  const code = getXmlChildText(er, "externalLocationCode");
  return system && code ? { system, code } : undefined;
}

function externalRefsOf(rec: XmlObject): RoadEvent["externalRefs"] {
  const tmc = tmcOf(rec);
  const external = externalLocationOf(rec);
  if (!tmc && !external) return undefined;
  return { ...(tmc ? { tmc } : {}), ...(external ? { external } : {}) };
}

interface SituationRecord {
  rec: XmlObject;
  situationSeverity: string;
  publicationTime?: string;
  situationId?: string;
  relatedSituations?: string[];
}

function listSituationRecords(doc: XmlObject): SituationRecord[] {
  const root = datexRoot(doc);
  let publication: XmlObject | undefined = datexPublications(doc)[0]?.body;

  if (!publication) {
    for (const [key, value] of Object.entries(root)) {
      if (key.startsWith("@_")) continue;
      const stripped = stripXmlNamespace(key);
      if (
        stripped.endsWith("Publication") ||
        stripped === "payload" ||
        stripped === "payloadPublication"
      ) {
        const candidate = xmlNodeToArray(value).find(isXmlObject);
        if (candidate && ("situation" in candidate || "publicationTime" in candidate)) {
          publication = candidate;
          break;
        }
      }
    }
  }

  // National Highways (England) and similar emit the publication AS the document
  // root (e.g. <D2Payload> carrying <feedType>SituationPublication</feedType>)
  // with <situation> children directly inside it — no nested payload /
  // ...Publication wrapper for the loops above to match. As a last resort, accept
  // any root child object that directly holds situations.
  if (!publication) {
    for (const [key, value] of Object.entries(root)) {
      if (key.startsWith("@_")) continue;
      const candidate = xmlNodeToArray(value).find(isXmlObject);
      if (candidate && "situation" in candidate) {
        publication = candidate;
        break;
      }
    }
  }

  if (!publication) return [];

  const publicationTime = getXmlChildText(publication, "publicationTime");
  const situations = getXmlChildren(publication, "situation");
  return situations.flatMap((sit) => {
    const sitSeverity = text(sit["overallSeverity"]) ?? "";
    const situationId = situationIdOf(sit);
    const relatedSituations = relatedSituationsOf(sit);
    return getXmlChildren(sit, "situationRecord").map((rec) => ({
      rec,
      situationSeverity: sitSeverity,
      publicationTime,
      ...(situationId ? { situationId } : {}),
      ...(relatedSituations.length > 0 ? { relatedSituations } : {}),
    }));
  });
}

/**
 * The situations a situation names as related (`relatedSituation`): v3 refers
 * to each by its `objectReference`, v2 by the reference's own `id`.
 */
function relatedSituationsOf(sit: XmlObject): string[] {
  return getXmlChildren(sit, "relatedSituation").flatMap((related) => {
    const id =
      getXmlAttribute(getXmlChild(related, "objectReference"), "id") ??
      getXmlAttribute(related, "id");
    return id?.trim() ? [id.trim()] : [];
  });
}

/** Field names that mark a node as the situationRecord body (not a wrapper). */
const RECORD_BODY_MARKERS = [
  "situationRecordVersionTime",
  "situationRecordCreationTime",
  "locationReference",
  "validity",
];

/**
 * The effective situationRecord body and its class name. National Highways and
 * others use the v3 substitution group (`<situationRecord><sit{Class}>…`) with no
 * xsi:type; there the real body — and the only locationReference the geometry
 * walk can reach — is one level down, and the wrapper name carries the class
 * (`sitRoadOrCarriagewayOrLaneManagement` → `RoadOrCarriagewayOrLaneManagement`).
 */
function recordBody(rawRec: XmlObject): { body: XmlObject; className?: string } {
  return datexRecordBody(rawRec, { markers: RECORD_BODY_MARKERS, classPrefix: "sit" });
}

/**
 * Parse a DATEX II SituationPublication XML document (v2 or v3) and return
 * an array of RoadEvent or UnresolvedRoadEvent observations.
 *
 * Records with coordinate geometry are returned as RoadEvent (geometry
 * present). Records with an OpenLR binary location but no coordinate geometry
 * are returned as UnresolvedRoadEvent (geometry absent, externalRefs.openlr
 * set); the ingest resolve stage will either fill geometry or drop them.
 * Records with neither geometry nor OpenLR are skipped entirely.
 *
 * Unresolved markers bypass deduplication (which requires coordinate geometry)
 * and are appended after the deduped set.
 */
interface DatexParseResult {
  withGeom: RoadEvent[];
  unresolved: UnresolvedRoadEvent[];
  records: RoadSnapshotRecord[];
  errors: RoadSnapshotReport["errors"];
  inputCount: number;
}

function parseDatexInternal(
  input: string | Buffer,
  src: SourceDescriptor,
  strictMetadata = false,
): DatexParseResult {
  const doc = parseXmlDocument(input, {
    removeNSPrefix: true,
    ignoreAttributes: false,
    isArray: (n) => n === "situation" || n === "situationRecord" || n === "value",
  });

  // Feeds whose GML geometry is a projected national grid (e.g. Flanders
  // EPSG:31370) declare it via srsName; reproject those to WGS84. A feed that
  // uses a grid but declares nothing can say so on its descriptor instead.
  const reproject = detectReprojector(input) ?? reprojectorFor(src.srsName);
  // Some publishers emit GML posList in "lon lat" order (e.g. Trafikverket),
  // opposite the DATEX/WGS84 "lat lon" default.
  const lonFirst = src.posListLonLat ?? false;

  const sourceRecords = listSituationRecords(doc);
  const withGeom: RoadEvent[] = [];
  const unresolved: UnresolvedRoadEvent[] = [];
  const records: RoadSnapshotRecord[] = [];
  const errors: RoadSnapshotReport["errors"] = [];

  // A DATEX version this parser was not written against (v1, or a future
  // major) shares element names with v2 and v3 but not their meaning. Its
  // records are counted, not read; a complete snapshot of one is refused
  // rather than read as the publisher withdrawing everything.
  const modelVersion = datexModelVersion(input);
  if (modelVersion !== undefined && !READ_MODEL_VERSIONS.has(modelVersion)) {
    recordSkipped(src.id, "unsupported_version", sourceRecords.length);
    if (strictMetadata) {
      errors.push({ code: "unsupported_version", id: null, sourcePath: "modelBaseVersion" });
    }
    return { withGeom, unresolved, records, errors, inputCount: sourceRecords.length };
  }
  let skippedAlertCOnly = 0;
  let resolvedFromTmc = 0;
  const unresolvedReasons = new Map<string, number>();
  // How records we could not place describe their location. A count alone says
  // a publisher is being lost but not what to build; the shape names the
  // referencing scheme we do not yet read.
  const unreadableShapes = new Map<string, number>();
  /** Table editions publishers named that we do not hold. */
  const mismatchVersions = new Map<string, number>();

  for (const {
    rec: rawRec,
    situationSeverity,
    situationId,
    publicationTime,
    relatedSituations,
  } of sourceRecords) {
    const { body: rec, className } = recordBody(rawRec);
    const recordId = recId(rec);
    const prefixedId = `${src.id}:${recordId}`;
    // Publishers place the record version either in a child element or, as NDW
    // does, in the `version` attribute of situationRecord itself.
    const rawRecordVersion =
      getXmlChildText(rec, "situationRecordVersion") ?? getXmlAttribute(rec, "version");
    const sourceVersion = rawRecordVersion === undefined ? NaN : Number(rawRecordVersion);
    const version =
      rawRecordVersion?.trim() !== "" && Number.isSafeInteger(sourceVersion) && sourceVersion >= 0
        ? sourceVersion
        : null;
    const rawVersionTime = text(rec["situationRecordVersionTime"]) ?? null;
    const versionTime =
      rawVersionTime !== null && parseRestrictionInstant(rawVersionTime) !== null
        ? rawVersionTime
        : null;
    if (!recordId) {
      errors.push({ code: "missing_identity", id: null, sourcePath: "situationRecord" });
      recordSkipped(src.id, "malformed");
      continue;
    }

    const validity = getXmlChild(rec, "validity") ?? {};
    const timeSpec = getXmlChild(validity, "validityTimeSpecification");
    const lifecycle = datexLifecycle(validity);
    const status = lifecycle.status;
    const dataUpdatedAt = versionTime ?? toRestrictionInstant(publicationTime);
    if (strictMetadata) {
      const invalidField = [
        ["situationRecordVersionTime", rawVersionTime],
        ["publicationTime", publicationTime],
        [
          "validity.validityTimeSpecification.overallStartTime",
          text(timeSpec?.["overallStartTime"]),
        ],
        ["validity.validityTimeSpecification.overallEndTime", text(timeSpec?.["overallEndTime"])],
      ].find(([, value]) => value != null && parseRestrictionInstant(value) === null);
      const start = parseRestrictionInstant(text(timeSpec?.["overallStartTime"]));
      const end = parseRestrictionInstant(text(timeSpec?.["overallEndTime"]));
      const error =
        rawRecordVersion !== undefined && version === null
          ? { code: "invalid_version", sourcePath: "situationRecord.version" }
          : invalidField
            ? { code: "invalid_timestamp", sourcePath: `situationRecord.${invalidField[0]}` }
            : dataUpdatedAt === null
              ? { code: "missing_update_time", sourcePath: "situationRecord" }
              : start !== null && end !== null && end < start
                ? {
                    code: "invalid_window",
                    sourcePath: "situationRecord.validity.validityTimeSpecification",
                  }
                : null;
      if (error) {
        errors.push({ ...error, id: prefixedId });
        continue;
      }
      if (status !== "active") {
        records.push({
          id: prefixedId,
          version,
          versionTime,
          fingerprint: canonicalSnapshotValue({ id: prefixedId, status, version, versionTime }),
          disposition: "terminal",
        });
        continue;
      }
    }

    // The record class says what the record is. Without one (`SituationRecord`
    // is abstract) the record breaks the schema; one neither version defines
    // is a type this parser cannot read. Either is dropped and counted, never
    // published as an unclassified "other". In a complete snapshot it is held
    // like an unplaceable record, so its situation is not ended.
    const recType = elementType(rec) || className || "";
    if (!RECORD_CLASSES.has(recType)) {
      recordSkipped(src.id, recType === "" ? "malformed" : "unknown_type");
      records.push({
        id: prefixedId,
        version,
        versionTime,
        fingerprint: canonicalSnapshotValue(rec),
        disposition: "unlocatable",
        ...(situationId ? { situationId } : {}),
      });
      continue;
    }

    const roads = roadsOf(rec);
    let geometry = resolveGeometry(rec, reproject, lonFirst);
    let locationTable: RoadEvent["locationTable"];

    // A record with no coordinates may still say where it is, by Alert-C code.
    // Some publishers encode every record that way and would otherwise
    // contribute nothing at all.
    if (!geometry) {
      const ref = alertCRefOf(rec);
      // The road the record itself names, so a code from another table edition
      // can be checked against it rather than trusted.
      const road = roads[0];
      const resolution =
        ref?.country?.trim() === "8"
          ? resolveVild(ref)
          : ref
            ? resolveAlertC(
                { ...ref, ...(road?.ref || road?.name ? { road: road.ref ?? road.name } : {}) },
                tmcTables(),
              )
            : // Not an Alert-C record at all — it locates itself some other way (or
              // not at all). Counted like any other reason so no dropped record is
              // left in a silent bucket that reads as "nothing to explain".
              ({ ok: false, reason: "no-alertc" } as const);

      if (resolution.ok) {
        geometry = resolution.geometry;
        locationTable =
          "locationTable" in resolution
            ? resolution.locationTable
            : {
                ref: `TMC ${resolution.table.cid}/${resolution.table.tabcd}`,
                version: resolution.table.version,
                // Records placed from another edition are marked, because their codes
                // were vouched for by a road match rather than by the edition itself.
                ...(resolution.viaRoadMatch ? { viaRoadMatch: true } : {}),
                ...(resolution.table.attribution
                  ? { attribution: resolution.table.attribution }
                  : {}),
                ...(resolution.table.license ? { license: resolution.table.license } : {}),
              };
        resolvedFromTmc++;
      } else {
        unresolvedReasons.set(
          resolution.reason,
          (unresolvedReasons.get(resolution.reason) ?? 0) + 1,
        );
        if (resolution.reason === "no-alertc") {
          const shape = locationShapeOf(rec);
          unreadableShapes.set(shape, (unreadableShapes.get(shape) ?? 0) + 1);
        }
        if (resolution.reason === "version-mismatch" && ref?.version) {
          // Which edition the publisher actually names. Without it, "mismatch"
          // says only that ours is not theirs — not whether theirs is obtainable.
          mismatchVersions.set(ref.version, (mismatchVersions.get(ref.version) ?? 0) + 1);
        }
      }
    }

    const openlr = !geometry ? collectOpenLr(rec) : undefined;

    if (!geometry && !openlr) {
      skippedAlertCOnly++;
      // A valid record we cannot place is accounted for, never fabricated at a
      // centroid and never mistaken for a withdrawal upstream.
      records.push({
        id: prefixedId,
        version,
        versionTime,
        fingerprint: canonicalSnapshotValue(rec),
        disposition: "unlocatable",
        ...(situationId ? { situationId } : {}),
      });
      continue;
    }

    const discriminator = datexDiscriminator(recType);
    const classification = datexClassification(
      recType,
      discriminator === undefined
        ? []
        : xmlNodeToArray(rec[discriminator])
            .map(text)
            .filter((v): v is string => v !== undefined),
      getXmlChildren(rec, "cause")
        .map((cause) => getXmlChildText(cause, "causeType"))
        .filter((v): v is string => v !== undefined),
    );
    // A management record that declares a full road closure is a closure, even
    // when the publisher's record id or headline names something narrower; one
    // that declares two-way traffic sharing a carriageway is a contraflow.
    const managementType = getXmlChildText(rec, "roadOrCarriagewayOrLaneManagementType");
    const { type, category, isPlanned } =
      managementType === "roadClosed"
        ? coarseType("road_closure")
        : managementType === "contraflow"
          ? coarseType("contraflow")
          : (entryOf(DATEX_COARSE, recType) ?? coarseOf(classification));
    // A management type declares the road's state; an unplanned event's
    // constriction says it where no management type does.
    const declaredState = roadStateOf(rec);
    const constriction =
      declaredState === undefined ? entryOf(CONSTRICTION, constrictionOf(rec)) : undefined;
    const closureScope =
      managementType === "carriagewayClosures" ? "carriageway" : constriction?.scope;
    const measure = measureOf(rec);
    const informationSource = informationSourceOf(rec);

    const severity =
      situationSeverity || text(rec["overallSeverity"]) || text(rec["severity"]) || "";
    const normalised = normaliseSeverity(severity, { format: "datex2" });
    // A safety-related message with no declared severity is at least medium.
    const safetyRelated = getXmlChildText(rec, "safetyRelatedMessage") === "true";
    const severityFields =
      normalised.severity === "unknown" && safetyRelated
        ? {
            severity: "unknown" as const,
            severitySource: "derived" as const,
            severityFloor: "medium" as const,
          }
        : normalised;

    const comments = publicComments(rec, "en");
    const typed = (re: RegExp) => comments.find((c) => c.type && re.test(c.type));
    const commentByType = (re: RegExp): string | undefined => typed(re)?.text;
    const fallbackComment = getXmlChild(rec, "comment");
    const fallbackAll = multilingualText(fallbackComment);
    const causeNode = getXmlChild(getXmlChild(rec, "cause"), "causeDescription");
    const causeAll = multilingualText(causeNode);
    const causeDesc = causeDescriptionOf(rec);
    // Prefer a name/title-typed comment as the headline; the work-type or any
    // other comment as the description; a route/diversion comment as the detour.
    // A comment that only says it is a description still leads, in document
    // order, where nothing names the situation.
    const headlineComment =
      typed(/name|title|head/i) ??
      comments.find((c) => !c.type || c.type === "description") ??
      comments[0];
    const sourceHeadline =
      headlineComment?.text ?? multilingual(fallbackComment, "en") ?? causeDesc;
    const headlineAll =
      headlineComment?.all ?? (multilingual(fallbackComment, "en") ? fallbackAll : causeAll);
    const headlineText = sourceHeadline ?? defaultHeadline(type);
    const descriptionComment =
      comments.find(
        (c) =>
          c !== headlineComment && c.type !== undefined && /type|description|desc/i.test(c.type),
      ) ?? comments.find((c) => c !== headlineComment && c.text !== headlineText);
    const descriptionText =
      descriptionComment?.text ?? multilingual(fallbackComment, "en") ?? causeDesc;
    const descriptionAll =
      descriptionComment?.all ?? (multilingual(fallbackComment, "en") ? fallbackAll : causeAll);
    const detourComment = typed(/route|recommend|divers|detour|umleit/i);
    // Every comment the headline and description did not take stays a comment.
    const otherComments = comments
      .filter((c) => c !== headlineComment && c !== descriptionComment)
      .map((c) => ({
        type: c === detourComment ? ("detour" as const) : ("public" as const),
        text: c.all,
      }));

    const sourceDirection = restrictionDirectionOf(rec);
    const calendar = timeSpecOf(timeSpec);
    const timeZone = geometry ? scheduleTimezoneForGeometry(geometry) : null;
    const rawEnd = text(timeSpec?.["overallEndTime"]);
    const overall = { start: text(timeSpec?.["overallStartTime"]), end: rawEnd };
    const periods = zonedPeriods(calendar.periods, timeZone, overall);
    const exceptions = zonedPeriods(calendar.exceptions, timeZone, overall);
    const scheduleIssues: Issue[] =
      periods.inexact || exceptions.inexact
        ? [
            {
              // A bound inside an occurrence cuts it short; no local date says so.
              code: "unsupported_schedule",
              sourcePath: "situationRecord.validity.validityTimeSpecification",
              sourceTokens: { boundWithinOccurrence: true },
            },
          ]
        : calendar.unsupported.length > 0
          ? [
              {
                code: "unsupported_schedule",
                sourcePath: "situationRecord.validity.validityTimeSpecification",
                sourceTokens: { unsupportedFields: calendar.unsupported },
              },
            ]
          : (calendar.periods || calendar.exceptions) && !timeZone
            ? [
                {
                  // Local recurrences cannot be placed in time without the
                  // zone of where they apply.
                  code: "unsupported_schedule",
                  sourcePath: "situationRecord.validity.validityTimeSpecification",
                  sourceTokens: { unresolvedTimeZone: true },
                },
              ]
            : [];
    // The restriction contract has no place for exception periods.
    const droppedScheduleFields = [
      ...calendar.unsupported,
      ...(getXmlChildren(timeSpec, "exceptionPeriod").length > 0 ? ["exceptionPeriod"] : []),
    ];
    const restriction = restrictionScheduleOf(timeSpec, geometry);
    if (restriction.inexact) droppedScheduleFields.push("validPeriod");
    const restrictionSchedule = restriction.schedule;
    const overrunEnd = overrunEndOf(validity, rawEnd, versionTime ?? dataUpdatedAt);
    const effectIssues = [...measure.effectIssues, ...scheduleIssues];
    const restrictionDetails = restrictionDetailsFor(rec, src, {
      recordId,
      recordVersion: rawRecordVersion ?? null,
      sourceUpdatedAt: versionTime,
      validFrom: text(timeSpec?.["overallStartTime"]) ?? null,
      validTo: overrunEnd === undefined ? (rawEnd ?? null) : null,
      direction: sourceDirection.direction,
      locationDescription: roads[0]?.name ?? roads[0]?.ref ?? null,
      sourceLocationRefs: sourceDirection.sourceLocationRefs,
      ...(restrictionSchedule ? { schedule: restrictionSchedule } : {}),
      issues: [
        ...sourceDirection.issues,
        ...(droppedScheduleFields.length > 0
          ? [
              {
                code: "unsupported_schedule" as const,
                factId: null,
                sourcePath: "situationRecord.validity.validityTimeSpecification",
                sourceTokens: { unsupportedFields: droppedScheduleFields },
              },
            ]
          : []),
      ],
    });

    const shared = {
      id: `${src.id}:${recId(rec)}`,
      source: src.id,
      sourceFormat: "datex2" as const,
      domain: "roads" as const,
      kind: "event" as const,
      situation: {
        ...(classification !== undefined ? { classification } : {}),
        ...(versionTime !== null ? { sourceUpdatedAt: versionTime } : {}),
        ...(sourceHeadline === undefined ? { headlineFromSource: false as const } : {}),
        ...(sourceHeadline !== undefined && headlineAll ? { headline: headlineAll } : {}),
        ...(descriptionText !== undefined && descriptionAll ? { description: descriptionAll } : {}),
        ...(otherComments.length > 0 ? { comments: otherComments } : {}),
        ...(severity.trim() ? { severityRaw: severity.trim() } : {}),
        ...(lifecycle.validityStatus !== undefined
          ? { validityStatus: lifecycle.validityStatus }
          : {}),
        ...(lifecycle.statusIssue !== undefined ? { statusIssue: lifecycle.statusIssue } : {}),
        ...(measure.actionStatus !== undefined ? { actionStatus: measure.actionStatus } : {}),
        ...(effectIssues.length > 0 ? { effectIssues } : {}),
        ...(measure.compliance !== undefined ? { compliance: measure.compliance } : {}),
        ...(measure.trafficTypes !== undefined ? { trafficTypes: measure.trafficTypes } : {}),
        ...(measure.trafficDirections !== undefined
          ? { trafficDirections: measure.trafficDirections }
          : {}),
        ...(informationSource !== undefined ? { informationSource } : {}),
        ...(closureScope !== undefined ? { closureScope } : {}),
        ...(overrunEnd !== undefined ? { estimatedEnd: overrunEnd } : {}),
      },
      ...(situationId ? { situationId } : {}),
      type,
      subtype: subtypeOf(rec, recType) ?? recType,
      category,
      isPlanned,
      ...severityFields,
      confidence: confidenceOf(rec),
      status,
      direction: directionOf(rec),
      roads,
      roadState: declaredState ?? constriction?.roadState,
      lanesAffected: lanesOf(rec),
      speedLimitKph: speedLimitOf(rec),
      restrictions: RESTRICTION_CONTRACT_SOURCES.has(src.id)
        ? legacyRestrictionsOf(restrictionDetails)
        : dimensionRestrictionsOf(rec),
      vehiclesAffected: vehiclesAffectedOf(rec),
      ...(restrictionDetails ? { restrictionDetails } : {}),
      detour: commentByType(/route|recommend|divers|detour|umleit/i) ?? detourOf(rec),
      detourGeometry: detourGeometryOf(rec, reproject, lonFirst),
      delaySeconds: leafNumber(rec, "delayTimeValue"),
      ...delayDescriptionOf(rec),
      queueLengthMeters: leafNumber(rec, "queueLength"),
      capacityRemainingPct: capacityRemainingOf(rec),
      workZoneType: workZoneTypeOf(rec),
      roadworks: roadworksOf(rec),
      relatedIds: relatedRefsOf(rec, relatedSituations),
      sourceRaw: {
        ...rec,
        ...(versionTime === null && dataUpdatedAt !== null
          ? { observationTimestampBasis: { sourcePath: "publicationTime", value: dataUpdatedAt } }
          : {}),
      },
      headline: headlineText,
      description: descriptionText,
      validFrom: text(timeSpec?.["overallStartTime"]) ?? null,
      validTo: overrunEnd === undefined ? (rawEnd ?? null) : null,
      origin: {
        kind: "feed" as const,
        attribution: {
          provider: src.attribution,
          license: src.license,
          url: src.licenseUrl,
        },
      },
      dataUpdatedAt: dataUpdatedAt ?? new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      isStale: false,
    };

    const observation: RoadEvent | UnresolvedRoadEvent = geometry
      ? {
          ...shared,
          geometry,
          // Local schedule times are stamped with the zone of the closure's
          // location (resolved from geometry), so the recurrence is unambiguous.
          schedule: periods.schedules,
          scheduleExceptions: exceptions.schedules,
          externalRefs: externalRefsOf(rec),
          ...(locationTable ? { locationTable } : {}),
          ...(locationTable?.ref === "VILD" ? { fuzziness: "low_res" as const } : {}),
        }
      : {
          ...shared,
          geometry: undefined,
          // openlr is defined here because we checked !geometry && !openlr above.
          externalRefs: { ...externalRefsOf(rec), openlr: openlr! },
        };
    if (geometry) withGeom.push(observation as RoadEvent);
    else unresolved.push(observation as UnresolvedRoadEvent);
    recordSkipped(src.id, "unknown_value", unreadValuesOf(rec, recType, severity));
    records.push({
      id: prefixedId,
      version,
      versionTime,
      fingerprint: snapshotFingerprint(observation),
      disposition: "accepted",
      event: observation,
    });
  }

  if (resolvedFromTmc > 0) {
    console.debug(`[datex] ${src.id}: placed ${resolvedFromTmc} record(s) via TMC location table`);
  }

  if (skippedAlertCOnly > 0) {
    // The reason matters as much as the count: "no table for this country" is a
    // licensing problem, "version-mismatch" means our table is the wrong
    // edition, and "unknown-code" means the publisher referenced something the
    // table does not contain. Collapsing them into one number would hide which.
    const versions = [...mismatchVersions]
      .sort((a, b) => b[1] - a[1])
      .map(([v, n]) => `${v}×${n}`)
      .join(",");
    const reasons = [...unresolvedReasons]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) =>
        reason === "version-mismatch" && versions
          ? `${reason}=${n}(theirs:${versions})`
          : `${reason}=${n}`,
      )
      .join(" ");
    const shapes = [...unreadableShapes]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([shape, n]) => `${shape}×${n}`)
      .join(" ");
    console.debug(
      `[datex] ${src.id}: skipped ${skippedAlertCOnly} record(s) with no usable geometry` +
        (reasons ? ` (${reasons})` : "") +
        (shapes ? ` [${shapes}]` : ""),
    );
    // Also counted per source, so the loss is measurable in GET /feeds/status
    // rather than visible only in a debug log line.
    recordSkipped(src.id, "no_geometry", skippedAlertCOnly);
  }

  // Unresolved OpenLR markers (no geometry yet) are appended after the located
  // set and resolved to geometry by the ingest resolve stage.
  return { withGeom, unresolved, records, errors, inputCount: sourceRecords.length };
}

/**
 * Parse a DATEX II SituationPublication and return its observations.
 *
 * Records are collapsed by their own `situationRecord` identity, not by
 * proximity: two distinct records in one situation are two facts, and merging
 * co-located ones would silently drop a published record.
 */
export function parseDatexSituations(
  input: string | Buffer,
  src: SourceDescriptor,
): (RoadEvent | UnresolvedRoadEvent)[] {
  const parsed = parseDatexInternal(input, src);
  return collapseByIdentity<RoadEvent | UnresolvedRoadEvent>(
    [...parsed.withGeom, ...parsed.unresolved],
    parsed.records,
  );
}

/**
 * Keep one event per source identity, preserving first-seen order so existing
 * consumers see a stable sequence. The retained revision is the highest-ranked
 * one the reporting path would also select.
 */
function collapseByIdentity<T extends { id: string }>(
  events: T[],
  records: RoadSnapshotRecord[],
): T[] {
  const best = new Map<string, RoadSnapshotRecord>();
  for (const record of records) {
    const existing = best.get(record.id);
    if (existing === undefined || compareSnapshotRank(record, existing) > 0) {
      best.set(record.id, record);
    }
  }
  const emitted = new Set<string>();
  const out: T[] = [];
  for (const event of events) {
    if (emitted.has(event.id)) continue;
    const winner = best.get(event.id);
    emitted.add(event.id);
    if (winner?.event) out.push(winner.event as unknown as T);
  }
  return out;
}

/**
 * Account for every record of one DATEX partition, reporting rather than
 * suppressing errors.
 */
export function parseDatexSnapshot(
  input: string | Buffer,
  src: SourceDescriptor,
): RoadSnapshotReport {
  try {
    const parsed = parseDatexInternal(input, src, true);
    return { inputCount: parsed.inputCount, records: parsed.records, errors: parsed.errors };
  } catch (err) {
    console.warn(`[datex] ${src.id}: unreadable snapshot envelope:`, err);
    return {
      inputCount: 0,
      records: [],
      errors: [{ code: "invalid_envelope", id: null, sourcePath: "$" }],
    };
  }
}
