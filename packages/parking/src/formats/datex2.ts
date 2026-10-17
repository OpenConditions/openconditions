import {
  type DatexOpeningTimes,
  type DatexParkingRecord,
  type DatexParkingStatus,
  datexPublications,
  isXmlObject,
  localChildText,
  parseDatexParkingStatus,
  parseDatexParkingTable,
  parseXmlDocument,
  stripXmlNamespace,
  type XmlObject,
} from "@openconditions/datex2";
import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { MappingTarget } from "@openconditions/model";
import {
  DATEX2_PARKING_ACCESS,
  DATEX2_PARKING_PAYMENT,
  DATEX2_PARKING_RESERVATION,
  DATEX2_PARKING_SUPERVISION,
  DATEX2_PARKING_VEHICLE_TYPES,
  DATEX2_V2_PARKING,
  DATEX2_V3_2_PARKING_SITE_STATUSES,
  DATEX2_V3_FACILITIES,
  DATEX2_V3_PARKING,
  type ParkingLayout,
  type ParkingSiteType,
  type ParkingStatus,
  type ParkingUserGroup,
  type ParkingVehicleType,
  parkingCrosswalk,
} from "@openconditions/model-parking";
import type { ParkingCatalogFeed } from "../feed-schema.js";
import {
  type AreaInput,
  areaKey,
  occupancyDrafts,
  occupancyPctDraft,
  type ParkingTrend,
  type RateRow,
  type ReadingInput,
  rateDraft,
  type SiteInput,
  siteDraft,
  statusDraft,
  trendDraft,
  utcInstant,
} from "../site.js";

type Target = Extract<MappingTarget, "datex2_v2" | "datex2_v3">;

const targetOf = (version: 2 | 3): Target => (version === 3 ? "datex2_v3" : "datex2_v2");
const otherTarget = (t: Target): Target => (t === "datex2_v3" ? "datex2_v2" : "datex2_v3");

/** The DATEX version a document's publications are in; v2 when it has none. */
const versionOf = (doc: XmlObject): 2 | 3 => datexPublications(doc)[0]?.version ?? 2;

/**
 * Who issued the document's record ids: its publication creator's national
 * identifier (NDW's `NL-12`, CITA's `PCH`). The creator sits on the outer
 * publication, which a generic publication's body does not reach.
 */
function publisherOf(doc: XmlObject): string | undefined {
  let level: XmlObject[] = [doc];
  for (let depth = 0; depth < 4 && level.length > 0; depth++) {
    const next: XmlObject[] = [];
    for (const node of level) {
      for (const [key, value] of Object.entries(node)) {
        if (key.startsWith("@_")) continue;
        const children = (Array.isArray(value) ? value : [value]).filter(isXmlObject);
        if (stripXmlNamespace(key) === "publicationCreator") {
          const id = children.map((c) => localChildText(c, "nationalIdentifier")).find(Boolean);
          if (id) return id;
        }
        next.push(...children);
      }
    }
    level = next;
  }
  return undefined;
}

/**
 * The user groups DATEX names that are areas of their own. A bay for
 * registered disabled persons, wheelchair users or "persons with
 * deficiencies in their daily life" is a disabled bay.
 */
const USER_GROUPS: Readonly<Record<string, ParkingUserGroup>> = {
  disabled: "disabled",
  disabledWithPermit: "disabled",
  registeredDisabledUsers: "disabled",
  handicapped: "disabled",
  wheelchairUsers: "disabled",
  women: "women",
  families: "family",
  residents: "residents",
  residentsWithPermit: "residents",
  shortTermParker: "short_term",
  longTermParker: "long_term",
  carSharer: "car_sharing",
  allUsers: "any",
  customers: "customers",
  shoppers: "customers",
  hotelGuests: "customers",
};

/** v2 `parkingLayout` and v3 `structureType` codes that say how the site is built. */
const LAYOUTS: Readonly<Record<string, ParkingLayout>> = {
  "parkingLayout:multiStorey": "multi_storey",
  "parkingLayout:singleLevel": "single_level",
  "parkingLayout:underground": "underground",
  "parkingLayout:automatedParkingGarage": "automated",
  "parkingLayout:openSpace": "surface",
  "parkingLayout:field": "surface",
  "parkingLayout:covered": "covered",
  "parkingLayout:nested": "nested",
  "parkingLayout:unknown": "unknown",
  "parkingLayout:undergroundAndMultistorey": "underground_and_multi_storey",
  "structureType:offStreetSurface": "surface",
  // Dropped off at a transfer cabin and parked by machine.
  "usageScenario:dropOffMechanical": "automated",
};

/**
 * Vehicle types the crosswalk does not name: v2's `fourWheelDrive` (the
 * crosswalk spells it `fourWheelDriveVehicle`, which no DATEX version
 * does), the car-sized types and v2's `VehicleType2Enum`, whose goods
 * vehicles are vans or lorries and whose motorhome parks in a caravan bay. A
 * car with a trailer still parks as a car.
 */
const VEHICLE_TYPES: Readonly<Record<string, ParkingVehicleType>> = {
  ...DATEX2_PARKING_VEHICLE_TYPES,
  fourWheelDrive: "car",
  carOrLightVehicle: "car",
  carWithTrailer: "car",
  passengerCar: "car",
  smallCar: "car",
  largeCar: "car",
  lightGoodsVehicle: "car",
  heavyGoodsVehicle: "truck",
  heavyGoodsVehicleWithTrailer: "truck",
  motorhome: "caravan",
};

/**
 * The opening statuses of v2 and the record-based v3 parking schema, which
 * the crosswalk does not key: "closed because of some scheduled or
 * unscheduled event" is an abnormal closure. "The normal opening times are
 * in force, i.e. it is not explicit said if it's open right now" says
 * neither.
 */
const RECORD_OPENING_STATUSES: Readonly<Record<string, ParkingStatus>> = {
  "openingStatus:open": "open",
  "openingStatus:closed": "closed",
  "openingStatus:closedAbnormal": "closed_abnormally",
  "openingStatus:statusUnknown": "unknown",
};

/** A standard's values with the `_extended` every v3 enumeration ends with. */
const known = (...lists: readonly (readonly string[])[]): ReadonlySet<string> =>
  new Set([...lists.flat(), "_extended"]);

const V2 = DATEX2_V2_PARKING;
const V3 = DATEX2_V3_PARKING;

/**
 * Every value DATEX defines for each code the decoder prefixes, in v2.3, the
 * record-based v3 parking schema and v3.7. A code outside them is one the
 * parser cannot know the meaning of, and is counted as `unknown_value`.
 */
const STANDARD_CODES: Readonly<Record<string, ReadonlySet<string>>> = {
  usageScenario: known(V2.parkingUsageScenarios, V3.parkingUsageScenarios),
  parkingLayout: known(V2.parkingLayouts),
  urbanParkingSiteType: known(V2.urbanParkingSiteTypes),
  interUrbanParkingSiteLocation: known(V2.interUrbanParkingSiteLocations),
  structureType: known(V3.structureTypes),
  equipmentType: known(V2.equipmentTypes),
  serviceFacilityType: known(V2.serviceFacilityTypes),
  facilityType: known(Object.keys(DATEX2_V3_FACILITIES).map((k) => k.slice(k.indexOf(":") + 1))),
  parkingSiteStatus: known(V2.parkingSiteStatuses, DATEX2_V3_2_PARKING_SITE_STATUSES),
  openingStatus: known(V2.openingStatuses, V3.openingStatuses),
  overcrowdingStatus: known(V2.parkingSiteOvercrowdingStatuses),
  placeStatus: known(V2.parkingSiteOvercrowdingStatuses, V3.parkingPlaceStatuses),
  vacantSpaces: known(V2.parkingVacantSpaces, V3.parkingVacantSpaces),
  operationStatus: known(V3.operationStatuses),
  parkingOccupancyTrend: known(V2.parkingOccupancyTrends, V3.parkingOccupancyTrends),
  security: known(V2.parkingSecurity, V3.parkingSecurity),
  supervision: known(V2.parkingSupervisions, V3.parkingSupervisions),
  labelSecurityLevel: known(V2.labelSecurityLevels),
  vehicleType: known(V2.vehicleTypes, V2.vehicleTypes2, V3.vehicleTypes),
  userType: known(V2.userTypes),
  labelServiceLevel: known(V2.labelServiceLevels),
  reservation: known(V2.reservationTypes),
  accessCategory: known(V2.accessCategories),
  payment: known(V2.meansOfPayment),
};

/** How many of these codes (`prefix:value`, or bare under `prefix`) DATEX does not define. */
function unknownCodes(codes: readonly string[], prefix?: string): number {
  return codes.filter((code) => {
    const colon = prefix === undefined ? code.indexOf(":") : -1;
    const set = STANDARD_CODES[prefix ?? code.slice(0, colon)];
    return set !== undefined && !set.has(prefix === undefined ? code.slice(colon + 1) : code);
  }).length;
}

/** The codes of a table record DATEX does not define, and opening times it cannot read whole. */
function unknownRecordCodes(record: DatexParkingRecord): number {
  return (
    unknownCodes([...record.usage, ...record.layoutCodes, ...record.facilities]) +
    unknownCodes(record.security, "security") +
    unknownCodes(record.supervision === undefined ? [] : [record.supervision], "supervision") +
    unknownCodes(
      record.labelSecurityLevel === undefined ? [] : [record.labelSecurityLevel],
      "labelSecurityLevel",
    ) +
    unknownCodes(
      record.groups.flatMap((g) => g.vehicleTypes),
      "vehicleType",
    ) +
    unknownCodes(
      record.groups.flatMap((g) => g.userGroups),
      "userType",
    ) +
    unknownCodes(
      record.labelServiceLevel === undefined ? [] : [record.labelServiceLevel],
      "labelServiceLevel",
    ) +
    unknownCodes(record.reservation === undefined ? [] : [record.reservation], "reservation") +
    unknownCodes(
      record.accesses.flatMap((a) => a.categories),
      "accessCategory",
    ) +
    unknownCodes(record.payment, "payment") +
    Number(openingHoursOf(record.openingTimes) === "unreadable")
  );
}

/**
 * Usage scenarios that are usages of the model. A drop-off area is for
 * dropping off and picking up, as kiss and ride is.
 */
const USAGES: Readonly<Record<string, string>> = {
  "usageScenario:truckParking": "truck",
  "usageScenario:parkAndRide": "park_and_ride",
  "usageScenario:parkAndCycle": "park_and_cycle",
  "usageScenario:parkAndWalk": "park_and_walk",
  "usageScenario:kissAndRide": "kiss_and_ride",
  "usageScenario:dropOff": "kiss_and_ride",
  "usageScenario:liftshare": "carpool",
  "usageScenario:carSharing": "car_sharing",
  "usageScenario:dropOffWithValet": "valet",
  "usageScenario:eventParking": "event",
  "usageScenario:loadingBay": "loading",
  "usageScenario:overnightParking": "overnight",
};

/**
 * When several status codes map, the one that says most: a closure beats a
 * fill level, a fill level beats a plain "open".
 */
const STATUS_RANK: readonly ParkingStatus[] = [
  "closed_abnormally",
  "closed",
  "full",
  "almost_full",
  "spaces_available",
  "open",
  "unknown",
];

/** A code's mapping in the document's own version first, then the other's. */
function either<T>(target: Target, look: (t: Target) => T | undefined): T | undefined {
  return look(target) ?? look(otherTarget(target));
}

const unique = <T>(values: (T | undefined)[]): T[] => [
  ...new Set(values.filter((v): v is T => v !== undefined)),
];

/** One table group: the area it is, and whether its readings are that area's. */
interface GroupArea {
  area: AreaInput;
  /** False when an earlier group already is this area: its readings are not the area's. */
  owner: boolean;
}

interface TableSite {
  record: DatexParkingRecord;
  point: [number, number];
  groups: Map<string, GroupArea>;
}

/**
 * The areas of a record's space groups: one per (vehicle type, user group),
 * the first group of a pair winning. A group of zero spaces is no area; a
 * group without a count says only that the site has such spaces. A group for
 * vehicles the publisher characterises but as no parking vehicle type (NDW's
 * reefer-only bays) is no area: its spaces are not untyped ones.
 */
function groupAreas(record: DatexParkingRecord): Map<string, GroupArea> {
  const seen = new Set<string>();
  const out = new Map<string, GroupArea>();
  for (const group of record.groups) {
    if (group.spaces === 0) continue;
    const typed = group.vehicleTypes.map((v) => VEHICLE_TYPES[v]).find(Boolean);
    if (typed === undefined && group.characterised) continue;
    const vehicleType = typed ?? "any";
    const userGroup = group.userGroups.map((u) => USER_GROUPS[u]).find(Boolean) ?? "any";
    const area: AreaInput = {
      vehicleType,
      userGroup,
      ...(group.spaces === undefined ? {} : { capacity: group.spaces }),
      ...(group.maxStaySec === undefined || group.maxStaySec <= 0
        ? {}
        : { maxStay: { value: group.maxStaySec / 60, unit: "min" } }),
    };
    const key = areaKey(area);
    out.set(group.index, { area, owner: !seen.has(key) });
    seen.add(key);
  }
  return out;
}

const OSM_DAYS: Readonly<Record<string, number>> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};
const OSM_DAY_NAMES = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const SPEC_DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

/** Days as OSM writes them: runs as `Mo-Fr`, single days and pairs listed. */
function osmDays(indices: readonly number[]): string {
  const runs: [number, number][] = [];
  for (const i of [...indices].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last !== undefined && last[1] === i - 1) last[1] = i;
    else runs.push([i, i]);
  }
  return runs
    .map(([a, b]) =>
      a === b
        ? OSM_DAY_NAMES[a]
        : `${OSM_DAY_NAMES[a]}${b === a + 1 ? "," : "-"}${OSM_DAY_NAMES[b]}`,
    )
    .join(",");
}

/** A span's end as OSM writes it: midnight after its start is `24:00`. */
const osmEnd = (from: string, to: string) => (to === "00:00" && from !== "00:00" ? "24:00" : to);

type OpeningHoursRead =
  | { osm: string; spec?: { days: string[]; opens: string; closes: string }[] }
  | "unreadable"
  | undefined;

/**
 * A site's opening times in the OSM grammar, open rules before the closed
 * exceptions that override them, with the weekly spans spelt out where every
 * rule is an open one. A schedule with a part the rules do not hold, or a day
 * DATEX does not name, is unreadable: narrowed hours would say the site is
 * open or closed when the publisher did not.
 */
function openingHoursOf(times: DatexOpeningTimes | undefined): OpeningHoursRead {
  if (times === undefined) return undefined;
  if (times.unread.length > 0) return "unreadable";
  const rules = [...times.rules].sort((a, b) => Number(a.closed) - Number(b.closed));
  if (rules.some((r) => r.days.some((d) => !Object.hasOwn(OSM_DAYS, d)))) return "unreadable";
  const always = (r: (typeof rules)[number]) =>
    r.days.length === 0 && r.times.every((t) => t.from === "00:00" && t.to === "00:00");
  // Validity without periods, or one open period of every day and hour: always open.
  if (rules.length === 0 || (rules.length === 1 && !rules[0]!.closed && always(rules[0]!))) {
    return { osm: "24/7" };
  }
  const osm = rules
    .map((r) => {
      const days = r.days.length === 0 ? "" : osmDays(r.days.map((d) => OSM_DAYS[d]!));
      const spans = r.times.map((t) => `${t.from}-${osmEnd(t.from, t.to)}`).join(",");
      const selector = [days, spans].filter((part) => part !== "").join(" ");
      return `${selector === "" ? "Mo-Su" : selector}${r.closed ? " off" : ""}`;
    })
    .join("; ");
  const spec = rules.every((r) => !r.closed && r.times.length > 0)
    ? rules.flatMap((r) =>
        r.times.map((t) => ({
          days: r.days.length === 0 ? [...SPEC_DAYS] : r.days.map((d) => SPEC_DAYS[OSM_DAYS[d]!]!),
          opens: t.from,
          closes: osmEnd(t.from, t.to),
        })),
      )
    : undefined;
  return { osm, ...(spec === undefined ? {} : { spec }) };
}

const EU_LABEL = /^securityLevel(\d)$/;
const EU_SERVICE_LABEL = /^serviceLevel(\d)$/;

/** A table's lookup of a code, when the table holds a meaning for it. */
const meaning = <T>(table: Readonly<Record<string, T | null>>, code: string | undefined) =>
  code !== undefined && Object.hasOwn(table, code) ? (table[code] ?? undefined) : undefined;

function siteInput(
  record: DatexParkingRecord,
  point: [number, number],
  groups: Map<string, GroupArea>,
  target: Target,
  publisher: string | undefined,
): SiteInput {
  const codes = [...record.usage, ...record.layoutCodes];
  const type = codes
    .map((code) => either(target, (t) => parkingCrosswalk.feature(t, code)?.type))
    .find(Boolean) as ParkingSiteType | undefined;
  const layout = [...record.layoutCodes, ...record.usage]
    .map((code) => LAYOUTS[code])
    .find(Boolean);
  const name = record.names[0];
  const description = record.descriptions[0];
  const level = record.labelSecurityLevel?.match(EU_LABEL)?.[1];
  const service = record.labelServiceLevel?.match(EU_SERVICE_LABEL)?.[1];
  const reservation = meaning(DATEX2_PARKING_RESERVATION, record.reservation);
  const payment = unique(record.payment.map((code) => meaning(DATEX2_PARKING_PAYMENT, code)));
  const entrances = record.accesses.flatMap((access) =>
    unique(access.categories.flatMap((c) => meaning(DATEX2_PARKING_ACCESS, c) ?? [])).map(
      (kind) => ({ point: access.point, kind }),
    ),
  );
  const website = record.url ?? record.tariffUrl;
  const hours = openingHoursOf(record.openingTimes);
  const contact = (c: DatexParkingRecord["owner"]) =>
    c === undefined
      ? undefined
      : {
          ...(c.url === undefined ? {} : { website: c.url }),
          ...(c.phone === undefined ? {} : { phone: c.phone }),
          ...(c.email === undefined ? {} : { email: c.email }),
        };
  const supervision =
    record.supervision === undefined ? undefined : DATEX2_PARKING_SUPERVISION[record.supervision];
  return {
    stationId: record.id,
    point,
    ...(name === undefined ? {} : { name: name.value, lang: name.lang }),
    ...(description === undefined ? {} : { notes: description.value }),
    ...(website === undefined ? {} : { website }),
    ...(record.photoUrl === undefined
      ? {}
      : { images: [{ url: record.photoUrl, category: "site" as const }] }),
    ...(record.maxStaySec === undefined || record.maxStaySec <= 0
      ? {}
      : { maxStay: { value: record.maxStaySec / 60, unit: "min" } }),
    ...(reservation === undefined ? {} : { reservation }),
    ...(payment.length === 0 ? {} : { payment: payment as SiteInput["payment"] }),
    ...(entrances.length === 0 ? {} : { entrances }),
    externalIds: [
      {
        scheme: "datex:parking",
        id: record.id,
        ...(publisher === undefined ? {} : { authority: publisher }),
      },
    ],
    ...(type === undefined ? {} : { type }),
    ...(layout === undefined ? {} : { layout }),
    ...(record.operator === undefined
      ? {}
      : { operator: record.operator, operatorContact: contact(record.operatorContact) }),
    ...(record.owner?.name === undefined
      ? {}
      : { owner: record.owner.name, ownerContact: contact(record.owner) }),
    ...(hours === "unreadable"
      ? { openingHoursUnreadable: true }
      : hours === undefined
        ? {}
        : {
            openingHoursOsm: hours.osm,
            ...(hours.spec === undefined ? {} : { openingHoursSpec: hours.spec }),
          }),
    ...(record.address === undefined ? {} : { address: { text: record.address } }),
    ...(record.freeOfCharge === true ? { free: true } : {}),
    ...(record.totalSpaces === undefined ? {} : { capacityTotal: record.totalSpaces }),
    areas: [...groups.values()].filter((g) => g.owner).map((g) => g.area),
    amenities: unique(
      record.facilities.map((code) =>
        either(target, (t) => parkingCrosswalk.value("amenity", t, code)),
      ),
    ),
    usage: unique(record.usage.map((code) => USAGES[code])),
    securityFeatures: unique(
      record.security.map((code) =>
        either(target, (t) => parkingCrosswalk.value("parking_security", t, code)),
      ),
    ),
    ...(level === undefined ? {} : { securityRating: { scheme: "eu_label", level } }),
    ...(service === undefined ? {} : { serviceRating: { scheme: "eu_label", level: service } }),
    ...(supervision === undefined || supervision === null
      ? {}
      : { supervision: supervision as SiteInput["supervision"] }),
  };
}

/**
 * The record's charge bands as one rate, in the first band's currency. A
 * charge per interval is a time charge: its price per hour, billed in steps
 * of the interval. A charge without an interval is one flat price.
 */
function rateOf(
  feed: ParkingCatalogFeed,
  site: TableSite,
  lang: string | undefined,
  fetchedAt: string,
): RecordDraft | undefined {
  const { tariffs } = site.record;
  const currency = tariffs[0]?.currency;
  if (currency === undefined) return undefined;
  const rows: RateRow[] = tariffs
    .filter((t) => t.currency === currency)
    .map((t) =>
      t.intervalSec === undefined || t.intervalSec <= 0
        ? { amount: t.amount }
        : {
            amount: (t.amount * 3600) / t.intervalSec,
            component: "parking_time",
            stepSizeSec: Math.round(t.intervalSec),
          },
    );
  const text = tariffs.find((t) => t.name !== undefined)?.name;
  return rateDraft(feed, site.record.id, 1, {
    currency,
    rows,
    point: site.point,
    fetchedAt,
    ...(site.record.tariffUrl === undefined ? {} : { url: site.record.tariffUrl }),
    ...(text === undefined ? {} : { text }),
    ...(lang === undefined ? {} : { lang }),
  });
}

/**
 * A status's codes as one `parking.status`: by the crosswalk of the
 * document's version, else the other's (the record-based v3 schema publishes
 * v2's graded vacant spaces), else the record-based opening statuses. When
 * several map, the most telling wins.
 */
function statusOf(status: DatexParkingStatus, target: Target): ParkingStatus | undefined {
  const mapped = status.statusCodes
    .map(
      (code) =>
        either(target, (t) => parkingCrosswalk.value("parking_status", t, code)) ??
        RECORD_OPENING_STATUSES[code],
    )
    .filter((v): v is ParkingStatus => v !== undefined);
  return STATUS_RANK.find((s) => mapped.includes(s));
}

/**
 * The most spaces a site's groups can hold: the sum of their counts, when
 * every group is counted. Undefined when a group has no count.
 */
function groupSpaces(record: DatexParkingRecord): number | undefined {
  if (record.groups.length === 0) return undefined;
  let sum = 0;
  for (const group of record.groups) {
    if (group.spaces === undefined) return undefined;
    sum += group.spaces;
  }
  return sum;
}

function readingsOf(
  feed: ParkingCatalogFeed,
  site: TableSite,
  status: DatexParkingStatus,
  target: Target,
  ctx: ParseContext,
): RecordDraft[] {
  const at =
    status.at !== undefined && Number.isFinite(Date.parse(status.at))
      ? utcInstant(new Date(status.at))
      : ctx.fetchedAt;
  const reading: ReadingInput = { stationId: site.record.id, at, point: site.point };
  // The spaces the status says the site has now stand in for the table's.
  const capacity = status.capacity ?? site.record.totalSpaces;
  // Without a stated total, the groups' spaces bound the free count: a count
  // above them is impossible. They only bound it; nothing is derived from them.
  const bound = capacity === undefined ? groupSpaces(site.record) : undefined;
  const vacant =
    bound !== undefined && status.vacant !== undefined && status.vacant > bound
      ? undefined
      : status.vacant;
  const out: (RecordDraft | undefined)[] = [
    ...occupancyDrafts(
      feed,
      reading,
      {
        available: vacant,
        occupied: status.occupied,
        capacity,
      },
      ctx,
    ),
  ];
  if (status.occupancyPct !== undefined) {
    out.push(occupancyPctDraft(feed, { ...reading, pct: status.occupancyPct }, ctx));
  }
  const parkingStatus = statusOf(status, target);
  if (parkingStatus !== undefined) {
    out.push(statusDraft(feed, { ...reading, status: parkingStatus }, ctx));
  }
  const trendCode = status.trendCode;
  const trend =
    trendCode === undefined
      ? undefined
      : (either(target, (t) => parkingCrosswalk.value("trend", t, trendCode)) as
          | ParkingTrend
          | undefined);
  if (trend !== undefined) out.push(trendDraft(feed, { ...reading, trend }, ctx));

  for (const group of status.groups) {
    const owned = site.groups.get(group.index);
    if (owned === undefined || !owned.owner) continue;
    const area = { vehicleType: owned.area.vehicleType, userGroup: owned.area.userGroup };
    const groupReading = { ...reading, area };
    out.push(
      ...occupancyDrafts(
        feed,
        groupReading,
        {
          available: group.vacant,
          occupied: group.occupied,
          capacity: group.capacity ?? owned.area.capacity,
        },
        ctx,
      ),
    );
    if (group.occupancyPct !== undefined) {
      out.push(occupancyPctDraft(feed, { ...groupReading, pct: group.occupancyPct }, ctx));
    }
  }
  return out.filter((d): d is RecordDraft => d !== undefined);
}

/**
 * A DATEX II parking feed (v2 or v3): its `sites` table makes the sites, each
 * space group an area, its charge bands a rate; its `status` publication the
 * readings of the sites and of their groups, joined by record id. A group of
 * parking sites is no site: its sites are records of their own, and its
 * status is left out with it. A record without a placeable point, and a
 * status of a record the table gives no place, are counted as
 * `no_geometry`; a code DATEX does not define as `unknown_value`.
 */
export function parseDatex2(
  feed: ParkingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const options = { sourceId: feed.id };
  const sites = new Map<string, TableSite>();
  const groupsOfSites = new Set<string>();
  let unplaced = 0;
  let unknown = 0;
  for (const body of payloads["sites"] ?? []) {
    const doc = parseXmlDocument(body);
    const target = targetOf(versionOf(doc));
    const publisher = publisherOf(doc);
    for (const record of parseDatexParkingTable(doc, options)) {
      if (record.type === "GroupOfParkingSites") {
        groupsOfSites.add(record.id);
        continue;
      }
      unknown += unknownRecordCodes(record);
      if (record.point === undefined) {
        unplaced++;
        continue;
      }
      const groups = groupAreas(record);
      const site: TableSite = { record, point: record.point, groups };
      sites.set(record.id, site);
      const input = siteInput(record, record.point, groups, target, publisher);
      out.features.push(siteDraft(feed, input, ctx.fetchedAt));
      const rate = rateOf(feed, site, input.lang, ctx.fetchedAt);
      if (rate !== undefined) out.offers.push(rate);
    }
  }
  for (const body of payloads["status"] ?? []) {
    const doc = parseXmlDocument(body);
    const target = targetOf(versionOf(doc));
    for (const status of parseDatexParkingStatus(doc, options)) {
      if (groupsOfSites.has(status.recordId)) continue;
      unknown +=
        unknownCodes(status.statusCodes) +
        unknownCodes(status.trendCode === undefined ? [] : [status.trendCode]);
      const site = sites.get(status.recordId);
      if (site === undefined) {
        unplaced++;
        continue;
      }
      out.observations.push(...readingsOf(feed, site, status, target, ctx));
    }
  }
  recordSkipped(feed.id, "no_geometry", unplaced);
  recordSkipped(feed.id, "unknown_value", unknown);
  return out;
}
