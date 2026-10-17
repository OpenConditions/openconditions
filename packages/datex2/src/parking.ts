import { type DatexPublication, datexPublications } from "./publication.js";
import { type DatexDecodeOptions, skipped } from "./skips.js";
import {
  elementType,
  localAttribute,
  localChild,
  localChildren,
  localChildText,
  localChildTexts,
  multilingual,
  pointOf,
} from "./values.js";
import { isXmlObject, stripXmlNamespace, type XmlObject } from "./xml.js";

/**
 * DATEX II parking table and status publications, decoded to plain records.
 *
 * The v2.3 parking model and the record-based v3 parking schema (the one
 * published with v3.2, which declares itself 3.1) share their element names,
 * so one reader serves both. From v3.3 on, a parking table holds a facility
 * hierarchy (`hierarchyElementGeneral`) instead of parking records; those
 * tables are not read, and each of their elements is counted as
 * `unsupported_version` under the options' feed. Their status
 * (`parkingStatusInformation`) is read. Codes keep the enumeration they come
 * from as a prefix (`parkingSiteStatus:full`) where the parking crosswalks
 * are keyed that way, and stay bare where they are not (vehicle types,
 * security, supervision). A record or status that names no record id is
 * counted as `malformed`.
 */

export interface DatexParkingGroup {
  index: string;
  vehicleTypes: string[];
  userGroups: string[];
  /**
   * Whether the group is for vehicles the publisher characterises
   * (`vehicleCharacteristics`): by type, or by something else such as their
   * load. A group that does not is untyped spaces.
   */
  characterised: boolean;
  spaces?: number;
  /** The longest stay in the group's spaces, in seconds. */
  maxStaySec?: number;
}

export interface DatexParkingTariff {
  /** ISO 4217, upper case. */
  currency: string;
  amount: number;
  intervalSec?: number;
  name?: string;
}

/**
 * One rule of a site's opening times: on these days (every day without),
 * during these spans of the day (the whole day without), open or, for an
 * exception period, closed.
 */
export interface DatexOpeningRule {
  /** `DayEnum` names (`monday`). */
  days: string[];
  /** `HH:MM`, local to the site. */
  times: { from: string; to: string }[];
  closed: boolean;
}

/**
 * A site's opening times as rules, and the parts of the schedule the rules do
 * not hold (week or month recurrences, dated periods, an end, a suspension,
 * extensions): a schedule with any of them is not whole.
 */
export interface DatexOpeningTimes {
  rules: DatexOpeningRule[];
  unread: string[];
}

/**
 * An organisation a record names (its operator, its owner), with the contact
 * details the publisher agrees to publish: only where its
 * `publishingAgreement` is explicitly true.
 */
export interface DatexParkingContact {
  name?: string;
  phone?: string;
  email?: string;
  url?: string;
}

/** A way into or out of a site, where the publisher places it. */
export interface DatexParkingAccess {
  /** `AccessCategoryEnum` codes, bare. */
  categories: string[];
  point: [number, number];
}

export interface DatexParkingRecord {
  id: string;
  version?: string;
  type: string;
  names: { lang: string; value: string }[];
  descriptions: { lang: string; value: string }[];
  point?: [number, number];
  address?: string;
  operator?: string;
  operatorContact?: DatexParkingContact;
  owner?: DatexParkingContact;
  /** The site's own web page and photo. */
  url?: string;
  photoUrl?: string;
  /** The longest stay at the site, in seconds. */
  maxStaySec?: number;
  /** A `ReservationTypeEnum` code, bare. */
  reservation?: string;
  openingTimes?: DatexOpeningTimes;
  accesses: DatexParkingAccess[];
  /** `usageScenario:<code>`. */
  usage: string[];
  /** `parkingLayout:`, `urbanParkingSiteType:`, `interUrbanParkingSiteLocation:`, `structureType:` codes. */
  layoutCodes: string[];
  groups: DatexParkingGroup[];
  totalSpaces?: number;
  /** `equipmentType:*`, `serviceFacilityType:*` or `facilityType:*`. */
  facilities: string[];
  security: string[];
  supervision?: string;
  labelSecurityLevel?: string;
  labelServiceLevel?: string;
  freeOfCharge?: boolean;
  /** `MeansOfPaymentEnum` codes, bare. */
  payment: string[];
  /** The page of the site's tariffs and payment. */
  tariffUrl?: string;
  tariffs: DatexParkingTariff[];
}

export interface DatexParkingGroupStatus {
  index: string;
  capacity?: number;
  vacant?: number;
  occupied?: number;
  occupancyPct?: number;
}

export interface DatexParkingStatus {
  recordId: string;
  at?: string;
  /** The spaces the site has now, where they differ from its table's. */
  capacity?: number;
  vacant?: number;
  occupied?: number;
  occupancyPct?: number;
  statusCodes: string[];
  trendCode?: string;
  groups: DatexParkingGroupStatus[];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** A count or percentage as published; negative or non-numeric is no value. */
function nonNegative(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function bool(raw: string | undefined): boolean | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

function firstText(node: unknown): string | undefined {
  return multilingual(node)[0]?.value;
}

/** Text leaves with these local names anywhere in a subtree, skipping `skip` subtrees. */
function leaves(node: unknown, names: readonly string[], skip: readonly string[] = []): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!isXmlObject(n)) return;
    for (const [key, value] of Object.entries(n)) {
      if (key.startsWith("@_")) continue;
      const name = stripXmlNamespace(key);
      if (skip.includes(name)) continue;
      if (names.includes(name)) out.push(...localChildTexts(n, name));
      else walk(value);
    }
  };
  walk(node);
  return out;
}

/** Whether an element of this local name is anywhere in a subtree, skipping `skip` subtrees. */
function hasElement(node: unknown, name: string, skip: readonly string[] = []): boolean {
  if (Array.isArray(node)) return node.some((n) => hasElement(n, name, skip));
  if (!isXmlObject(node)) return false;
  return Object.entries(node).some(([key, value]) => {
    if (key.startsWith("@_")) return false;
    const local = stripXmlNamespace(key);
    if (skip.includes(local)) return false;
    return local === name || hasElement(value, name, skip);
  });
}

function prefixed(prefix: string, values: string[]): string[] {
  return values.map((v) => `${prefix}:${v}`);
}

function addressOf(contact: XmlObject | undefined): string | undefined {
  if (!contact) return undefined;
  const street = [
    localChildText(contact, "contactDetailsStreet"),
    localChildText(contact, "contactDetailsHouseNumber"),
  ]
    .filter(Boolean)
    .join(" ");
  const city = [
    localChildText(contact, "contactDetailsPostcode"),
    firstText(localChild(contact, "contactDetailsCity")) ??
      localChildText(contact, "contactDetailsCity"),
  ]
    .filter(Boolean)
    .join(" ");
  const parts = [street, city].filter((p) => p !== "");
  if (parts.length > 0) return parts.join(", ");
  return firstText(localChild(contact, "contactDetailsAddress"));
}

/** The body of an indexed wrapper (`<x index="1"><x xsi:type="…">…</x></x>`), else the node. */
function indexedBody(wrapper: XmlObject, inner: string): XmlObject {
  return localChild(wrapper, inner) ?? wrapper;
}

function groupsOf(rec: XmlObject): DatexParkingGroup[] {
  return localChildren(rec, "groupOfParkingSpaces").map((wrapper, position) => {
    const body = localChild(wrapper, "parkingSpaceBasics") ?? wrapper;
    const spaces = nonNegative(localChildText(body, "parkingNumberOfSpaces"));
    const maxStaySec = nonNegative(localChildText(body, "maximumParkingDuration"));
    return {
      index: localAttribute(wrapper, "groupIndex") ?? String(position),
      vehicleTypes: unique(leaves(body, ["vehicleType", "vehicleType2"], ["prohibitedParking"])),
      userGroups: unique(leaves(body, ["applicableForUser"], ["prohibitedParking"])),
      characterised: hasElement(body, "vehicleCharacteristics", ["prohibitedParking"]),
      ...(spaces === undefined ? {} : { spaces }),
      ...(maxStaySec === undefined ? {} : { maxStaySec }),
    };
  });
}

function facilitiesOf(rec: XmlObject): string[] {
  const out: string[] = [];
  for (const wrapper of localChildren(rec, "parkingEquipmentOrServiceFacility")) {
    const body = indexedBody(wrapper, "parkingEquipmentOrServiceFacility");
    // The publisher says it is there but out of use: not something the site offers.
    if (localChildText(body, "availability") === "notAvailable") continue;
    out.push(...prefixed("equipmentType", localChildTexts(body, "equipmentType")));
    out.push(...prefixed("serviceFacilityType", localChildTexts(body, "serviceFacilityType")));
  }
  out.push(...prefixed("facilityType", localChildTexts(rec, "facilityType")));
  return unique(out);
}

/** Whether a publishing agreement says yes, in either of xsd:boolean's spellings. */
const agreed = (raw: string | undefined) => raw !== undefined && /^(?:true|1)$/.test(raw.trim());

/**
 * The first contact of these elements. Its telephone, e-mail and web page
 * are a contact's details, published only where its `publishingAgreement`
 * is explicitly true: absent, false or unreadable, they are left out. An
 * operator's organisation name is the operator's, not a contact's, and is
 * kept; an owner may be a private person, so an owner's name, too, needs
 * the agreement.
 */
function contactOf(
  contacts: XmlObject[],
  role: "operator" | "owner",
): DatexParkingContact | undefined {
  const contact = contacts[0];
  if (contact === undefined) return undefined;
  const published = agreed(localChildText(contact, "publishingAgreement"));
  const organisation = firstText(localChild(contact, "contactOrganisationName"));
  const name = role === "operator" || published ? organisation : undefined;
  const phone = published ? localChildText(contact, "contactDetailsTelephoneNumber") : undefined;
  const email = published ? localChildText(contact, "contactDetailsEMail") : undefined;
  const url = published ? localChildText(contact, "urlLinkAddress") : undefined;
  const out = {
    ...(name === undefined ? {} : { name }),
    ...(phone === undefined ? {} : { phone }),
    ...(email === undefined ? {} : { email }),
    ...(url === undefined ? {} : { url }),
  };
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The element names of a node's children, attributes left out. */
const childNames = (node: XmlObject): string[] =>
  Object.keys(node)
    .filter((key) => !key.startsWith("@_"))
    .map(stripXmlNamespace);

const OPENING_SPEC_CHILDREN = new Set(["overallStartTime", "validPeriod", "exceptionPeriod"]);
const OPENING_PERIOD_CHILDREN = new Set([
  "periodName",
  "recurringTimePeriodOfDay",
  "recurringDayWeekMonthPeriod",
]);

/** `HH:MM` of a DATEX time (`08:00:00`), when it is one. */
function clock(raw: string | undefined): string | undefined {
  const [, hours, minutes] = raw?.match(/^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/) ?? [];
  return hours === undefined || minutes === undefined || Number(hours) > 24 || Number(minutes) > 59
    ? undefined
    : `${hours}:${minutes}`;
}

/** One period of a schedule as a rule, noting what of it the rule cannot hold. */
function openingRule(period: XmlObject, closed: boolean, unread: Set<string>): DatexOpeningRule {
  for (const name of childNames(period)) {
    if (!OPENING_PERIOD_CHILDREN.has(name)) unread.add(name);
  }
  const days: string[] = [];
  for (const recurrence of localChildren(period, "recurringDayWeekMonthPeriod")) {
    for (const name of childNames(recurrence)) if (name !== "applicableDay") unread.add(name);
    days.push(...localChildTexts(recurrence, "applicableDay"));
  }
  const times: DatexOpeningRule["times"] = [];
  for (const span of localChildren(period, "recurringTimePeriodOfDay")) {
    for (const name of childNames(span)) {
      if (name !== "startTimeOfPeriod" && name !== "endTimeOfPeriod") unread.add(name);
    }
    const from = clock(localChildText(span, "startTimeOfPeriod"));
    const to = clock(localChildText(span, "endTimeOfPeriod"));
    if (from === undefined || to === undefined) unread.add("recurringTimePeriodOfDay");
    else times.push({ from, to });
  }
  return { days: unique(days), times, closed };
}

/**
 * A site's `openingTimes`. Times said to be unknown or not specified are
 * none; a validity suspended, a schedule that ends, and every part a rule
 * cannot hold are noted as unread.
 */
function openingTimesOf(rec: XmlObject): DatexOpeningTimes | undefined {
  const times = localChild(rec, "openingTimes");
  if (times === undefined) return undefined;
  if (
    bool(localChildText(times, "openingTimesUnknown")) === true ||
    bool(localChildText(times, "openingTimesNotSpecified")) === true
  ) {
    return undefined;
  }
  const unread = new Set<string>();
  for (const name of childNames(times)) {
    if (!["openingTimesUnknown", "openingTimesNotSpecified", "validity"].includes(name)) {
      unread.add(name);
    }
  }
  const validity = localChild(times, "validity");
  const spec = localChild(validity, "validityTimeSpecification");
  if (validity === undefined || spec === undefined) return undefined;
  for (const name of childNames(validity)) {
    if (name !== "validityStatus" && name !== "validityTimeSpecification") unread.add(name);
  }
  if (localChildText(validity, "validityStatus") === "suspended") unread.add("validityStatus");
  for (const name of childNames(spec)) if (!OPENING_SPEC_CHILDREN.has(name)) unread.add(name);
  const rules = [
    ...localChildren(spec, "validPeriod").map((p) => openingRule(p, false, unread)),
    ...localChildren(spec, "exceptionPeriod").map((p) => openingRule(p, true, unread)),
  ];
  return { rules, unread: [...unread] };
}

/** The site's ways in and out that the publisher places at a point. */
function accessesOf(rec: XmlObject): DatexParkingAccess[] {
  return localChildren(rec, "parkingAccess").flatMap((access) => {
    const point = pointOf(localChild(access, "location"));
    const categories = unique(localChildTexts(access, "accessCategory"));
    return point === undefined || categories.length === 0 ? [] : [{ categories, point }];
  });
}

function tariffsOf(payment: XmlObject | undefined): DatexParkingTariff[] {
  const out: DatexParkingTariff[] = [];
  for (const band of localChildren(payment, "chargeBand")) {
    const currency = localChildText(band, "chargeCurrency")?.toUpperCase();
    if (!currency) continue;
    const name = firstText(localChild(band, "chargeBandName"));
    for (const charge of localChildren(band, "charge")) {
      const amount = nonNegative(localChildText(charge, "charge"));
      if (amount === undefined) continue;
      const intervalSec = nonNegative(localChildText(charge, "chargeInterval"));
      out.push({
        currency,
        amount,
        ...(intervalSec === undefined ? {} : { intervalSec }),
        ...(name === undefined ? {} : { name }),
      });
    }
  }
  return out;
}

function parkingRecord(
  rec: XmlObject,
  options: DatexDecodeOptions,
): DatexParkingRecord | undefined {
  const id = localAttribute(rec, "id");
  if (!id) {
    skipped(options, "malformed");
    return undefined;
  }
  const version = localAttribute(rec, "version");
  const point = pointOf(localChild(rec, "parkingLocation"));
  const address = addressOf(localChild(rec, "parkingSiteAddress"));
  const operatorContact = contactOf(localChildren(rec, "operator"), "operator");
  const operator = operatorContact?.name;
  const owner = contactOf(localChildren(rec, "owner"), "owner");
  const totalSpaces = nonNegative(localChildText(rec, "parkingNumberOfSpaces"));
  const standards = localChild(rec, "parkingStandardsAndSecurity");
  const supervision = localChildText(standards, "parkingSupervision");
  const labelSecurityLevel = localChildText(standards, "labelSecurityLevel");
  const labelServiceLevel = localChildText(standards, "labelServiceLevel");
  const payment = localChild(rec, "tariffsAndPayment");
  const freeOfCharge = bool(localChildText(payment, "freeOfCharge"));
  const url = localChildText(rec, "urlLinkAddress");
  const tariffUrl = localChildText(payment, "urlLinkAddress");
  const photoUrl = localChildText(rec, "photoUrl");
  const maxStaySec = nonNegative(localChildText(rec, "maximumParkingDuration"));
  const reservation = localChildText(rec, "parkingReservation");
  const openingTimes = openingTimesOf(rec);
  // v2 and v3 wrap each scenario twice under an index; a bare leaf is read as well.
  const usage = [
    ...localChildTexts(rec, "parkingUsageScenario"),
    ...localChildren(rec, "parkingUsageScenario").flatMap((wrapper) =>
      localChildTexts(indexedBody(wrapper, "parkingUsageScenario"), "parkingUsageScenario"),
    ),
  ];
  return {
    id,
    ...(version === undefined ? {} : { version }),
    type: elementType(rec),
    names: multilingual(localChild(rec, "parkingName")),
    descriptions: multilingual(localChild(rec, "parkingDescription")),
    ...(point === undefined ? {} : { point }),
    ...(address === undefined ? {} : { address }),
    ...(operator === undefined ? {} : { operator }),
    ...(operatorContact === undefined ? {} : { operatorContact }),
    ...(owner === undefined ? {} : { owner }),
    ...(url === undefined ? {} : { url }),
    ...(photoUrl === undefined ? {} : { photoUrl }),
    ...(maxStaySec === undefined ? {} : { maxStaySec }),
    ...(reservation === undefined ? {} : { reservation }),
    ...(openingTimes === undefined ? {} : { openingTimes }),
    accesses: accessesOf(rec),
    usage: prefixed("usageScenario", unique(usage)),
    layoutCodes: [
      "parkingLayout",
      "urbanParkingSiteType",
      "interUrbanParkingSiteLocation",
      "structureType",
    ].flatMap((name) => prefixed(name, localChildTexts(rec, name))),
    groups: groupsOf(rec),
    ...(totalSpaces === undefined ? {} : { totalSpaces }),
    facilities: facilitiesOf(rec),
    security: unique(localChildTexts(standards, "parkingSecurity")),
    ...(supervision === undefined ? {} : { supervision }),
    ...(labelSecurityLevel === undefined ? {} : { labelSecurityLevel }),
    ...(labelServiceLevel === undefined ? {} : { labelServiceLevel }),
    ...(freeOfCharge === undefined ? {} : { freeOfCharge }),
    payment: unique(localChildTexts(payment, "acceptedMeansOfPayment")),
    ...(tariffUrl === undefined ? {} : { tariffUrl }),
    tariffs: tariffsOf(payment),
  };
}

/**
 * Whether a publication is of this class. A publication that declares no class
 * (the schema requires one; some exports omit it) is read by its content, so
 * it is taken as either and the readers find what is there.
 */
function isPublication(p: DatexPublication, type: string): boolean {
  return p.type === type || p.type === "";
}

/** Every parking record in the document's parking table publications, v2 or v3. */
export function parseDatexParkingTable(
  doc: XmlObject,
  options: DatexDecodeOptions = {},
): DatexParkingRecord[] {
  const tables = datexPublications(doc)
    .filter((p) => isPublication(p, "ParkingTablePublication"))
    .flatMap((p) => localChildren(p.body, "parkingTable"));
  skipped(
    options,
    "unsupported_version",
    tables.reduce((n, table) => n + localChildren(table, "hierarchyElementGeneral").length, 0),
  );
  // A group of parking sites may hold its sites in place of naming them.
  return tables
    .flatMap((table) => localChildren(table, "parkingRecord"))
    .flatMap((r) => [r, ...localChildren(r, "parkingSite")])
    .map((r) => parkingRecord(r, options))
    .filter((r): r is DatexParkingRecord => r !== undefined);
}

interface Counts {
  capacity?: number;
  vacant?: number;
  occupied?: number;
  occupancyPct?: number;
}

function counts(occupancy: XmlObject | undefined, v37: boolean): Counts {
  const name = (v2: string, v3: string) => (v37 ? v3 : v2);
  const capacity = nonNegative(
    localChildText(occupancy, name("parkingNumberOfSpacesOverride", "numberOfSpacesOverride")),
  );
  const vacant = nonNegative(
    localChildText(occupancy, name("parkingNumberOfVacantSpaces", "numberOfVacantSpaces")),
  );
  const occupied = nonNegative(
    localChildText(occupancy, name("parkingNumberOfOccupiedSpaces", "numberOfOccupiedSpaces")),
  );
  const occupancyPct = nonNegative(
    localChildText(occupancy, name("parkingOccupancy", "occupancy")),
  );
  return {
    ...(capacity === undefined ? {} : { capacity }),
    ...(vacant === undefined ? {} : { vacant }),
    ...(occupied === undefined ? {} : { occupied }),
    ...(occupancyPct === undefined ? {} : { occupancyPct }),
  };
}

function trendOf(occupancy: XmlObject | undefined, v37: boolean): { trendCode?: string } {
  const trend = localChildText(occupancy, v37 ? "occupancyTrend" : "parkingOccupancyTrend");
  return trend === undefined ? {} : { trendCode: `parkingOccupancyTrend:${trend}` };
}

/** A v2 or record-based v3 `parkingRecordStatus`. */
function recordStatus(
  status: XmlObject,
  version: 2 | 3,
  options: DatexDecodeOptions,
): DatexParkingStatus | undefined {
  const recordId = localAttribute(localChild(status, "parkingRecordReference"), "id");
  if (!recordId) {
    skipped(options, "malformed");
    return undefined;
  }
  const at = localChildText(status, "parkingStatusOriginTime");
  const occupancy = localChild(status, "parkingOccupancy");
  const graded = localChildText(occupancy, "parkingNumberOfVacantSpacesGraded");
  // v3 folded the overcrowding status into its place status, and the crosswalk follows.
  const overcrowding = version === 2 ? "overcrowdingStatus" : "placeStatus";
  const statusCodes = [
    ...prefixed("parkingSiteStatus", localChildTexts(status, "parkingSiteStatus")),
    ...prefixed("openingStatus", localChildTexts(status, "parkingSiteOpeningStatus")),
    ...prefixed(overcrowding, localChildTexts(status, "parkingSiteOvercrowdingStatus")),
    ...(graded === undefined ? [] : [`vacantSpaces:${graded}`]),
  ];
  const groups = localChildren(status, "groupOfParkingSpacesStatus").map((wrapper, position) => ({
    index: localAttribute(wrapper, "groupIndex") ?? String(position),
    ...counts(indexedBody(wrapper, "groupOfParkingSpacesStatus"), false),
  }));
  return {
    recordId,
    ...(at === undefined ? {} : { at }),
    ...counts(occupancy, false),
    statusCodes,
    ...trendOf(occupancy, false),
    groups,
  };
}

/**
 * v3.7 splits a facility's status over several `parkingStatusInformation`
 * entries (a place status, an access status, …) that share its reference;
 * they merge into one status, first value wins.
 */
function mergeStatusInformation(
  entries: XmlObject[],
  options: DatexDecodeOptions,
): DatexParkingStatus[] {
  const byId = new Map<string, DatexParkingStatus>();
  for (const info of entries) {
    const recordId = localAttribute(localChild(info, "reference"), "id");
    if (!recordId) {
      skipped(options, "malformed");
      continue;
    }
    const occupancy = localChild(info, "occupancy");
    const at = localChildText(info, "lastUpdated");
    const placeStatus = elementType(info) === "PlaceStatus" ? localChildTexts(info, "status") : [];
    const next: DatexParkingStatus = {
      recordId,
      ...(at === undefined ? {} : { at }),
      ...counts(occupancy, true),
      statusCodes: [
        ...prefixed("openingStatus", localChildTexts(info, "openingStatus")),
        ...prefixed(
          "operationStatus",
          localChildTexts(localChild(info, "operatingPatternStatus"), "operationStatus"),
        ),
        ...prefixed("placeStatus", placeStatus),
      ],
      ...trendOf(occupancy, true),
      groups: [],
    };
    const seen = byId.get(recordId);
    byId.set(
      recordId,
      seen
        ? { ...next, ...seen, statusCodes: unique([...seen.statusCodes, ...next.statusCodes]) }
        : next,
    );
  }
  return [...byId.values()];
}

/** Every record status in the document's parking status publications, v2 or v3. */
export function parseDatexParkingStatus(
  doc: XmlObject,
  options: DatexDecodeOptions = {},
): DatexParkingStatus[] {
  return datexPublications(doc)
    .filter((p) => isPublication(p, "ParkingStatusPublication"))
    .flatMap((p) => [
      ...localChildren(p.body, "parkingRecordStatus")
        .map((s) => recordStatus(s, p.version, options))
        .filter((s): s is DatexParkingStatus => s !== undefined),
      ...mergeStatusInformation(localChildren(p.body, "parkingStatusInformation"), options),
    ]);
}
