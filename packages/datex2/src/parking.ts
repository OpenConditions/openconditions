import { type DatexPublication, datexPublications } from "./publication.js";
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
 * The v2 (2.3) and v3 (3.0–3.6) parking schemas share their element names, so
 * one reader serves both; v3.7's facility hierarchy (`parkingStatusInformation`)
 * is read for status. Codes keep the enumeration they come from as a prefix
 * (`parkingSiteStatus:full`) where the parking crosswalks are keyed that way,
 * and stay bare where they are not (vehicle types, security, supervision).
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
}

export interface DatexParkingTariff {
  /** ISO 4217, upper case. */
  currency: string;
  amount: number;
  intervalSec?: number;
  name?: string;
}

export interface DatexParkingRecord {
  id: string;
  version?: string;
  type: string;
  names: { lang: string; value: string }[];
  point?: [number, number];
  address?: string;
  operator?: string;
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
  freeOfCharge?: boolean;
  tariffs: DatexParkingTariff[];
}

export interface DatexParkingGroupStatus {
  index: string;
  vacant?: number;
  occupied?: number;
  occupancyPct?: number;
}

export interface DatexParkingStatus {
  recordId: string;
  at?: string;
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
    return {
      index: localAttribute(wrapper, "groupIndex") ?? String(position),
      vehicleTypes: unique(leaves(body, ["vehicleType", "vehicleType2"], ["prohibitedParking"])),
      userGroups: unique(leaves(body, ["applicableForUser"], ["prohibitedParking"])),
      characterised: hasElement(body, "vehicleCharacteristics", ["prohibitedParking"]),
      ...(spaces === undefined ? {} : { spaces }),
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

function parkingRecord(rec: XmlObject): DatexParkingRecord | undefined {
  const id = localAttribute(rec, "id");
  if (!id) return undefined;
  const version = localAttribute(rec, "version");
  const point = pointOf(localChild(rec, "parkingLocation"));
  const address = addressOf(localChild(rec, "parkingSiteAddress"));
  const operator = firstText(localChild(localChild(rec, "operator"), "contactOrganisationName"));
  const totalSpaces = nonNegative(localChildText(rec, "parkingNumberOfSpaces"));
  const standards = localChild(rec, "parkingStandardsAndSecurity");
  const supervision = localChildText(standards, "parkingSupervision");
  const labelSecurityLevel = localChildText(standards, "labelSecurityLevel");
  const payment = localChild(rec, "tariffsAndPayment");
  const freeOfCharge = bool(localChildText(payment, "freeOfCharge"));
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
    ...(point === undefined ? {} : { point }),
    ...(address === undefined ? {} : { address }),
    ...(operator === undefined ? {} : { operator }),
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
    ...(freeOfCharge === undefined ? {} : { freeOfCharge }),
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
export function parseDatexParkingTable(doc: XmlObject): DatexParkingRecord[] {
  return datexPublications(doc)
    .filter((p) => isPublication(p, "ParkingTablePublication"))
    .flatMap((p) => localChildren(p.body, "parkingTable"))
    .flatMap((table) => localChildren(table, "parkingRecord"))
    .map(parkingRecord)
    .filter((r): r is DatexParkingRecord => r !== undefined);
}

interface Counts {
  vacant?: number;
  occupied?: number;
  occupancyPct?: number;
}

function counts(occupancy: XmlObject | undefined, v37: boolean): Counts {
  const name = (v2: string, v3: string) => (v37 ? v3 : v2);
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
    ...(vacant === undefined ? {} : { vacant }),
    ...(occupied === undefined ? {} : { occupied }),
    ...(occupancyPct === undefined ? {} : { occupancyPct }),
  };
}

function trendOf(occupancy: XmlObject | undefined, v37: boolean): { trendCode?: string } {
  const trend = localChildText(occupancy, v37 ? "occupancyTrend" : "parkingOccupancyTrend");
  return trend === undefined ? {} : { trendCode: `parkingOccupancyTrend:${trend}` };
}

/** A v2/v3.0–3.6 `parkingRecordStatus`. */
function recordStatus(status: XmlObject, version: 2 | 3): DatexParkingStatus | undefined {
  const recordId = localAttribute(localChild(status, "parkingRecordReference"), "id");
  if (!recordId) return undefined;
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
function mergeStatusInformation(entries: XmlObject[]): DatexParkingStatus[] {
  const byId = new Map<string, DatexParkingStatus>();
  for (const info of entries) {
    const recordId = localAttribute(localChild(info, "reference"), "id");
    if (!recordId) continue;
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
export function parseDatexParkingStatus(doc: XmlObject): DatexParkingStatus[] {
  return datexPublications(doc)
    .filter((p) => isPublication(p, "ParkingStatusPublication"))
    .flatMap((p) => [
      ...localChildren(p.body, "parkingRecordStatus")
        .map((s) => recordStatus(s, p.version))
        .filter((s): s is DatexParkingStatus => s !== undefined),
      ...mergeStatusInformation(localChildren(p.body, "parkingStatusInformation")),
    ]);
}
