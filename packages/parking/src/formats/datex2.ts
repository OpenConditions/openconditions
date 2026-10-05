import {
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
} from "@openconditions/ingest-framework";
import type { MappingTarget } from "@openconditions/model";
import {
  DATEX2_PARKING_SUPERVISION,
  DATEX2_PARKING_VEHICLE_TYPES,
  type ParkingLayout,
  type ParkingSiteType,
  type ParkingStatus,
  type ParkingUserGroup,
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

/** The user groups DATEX names that are areas of their own. */
const USER_GROUPS: Readonly<Record<string, ParkingUserGroup>> = {
  disabled: "disabled",
  disabledWithPermit: "disabled",
  women: "women",
  families: "family",
  residents: "residents",
  residentsWithPermit: "residents",
  shortTermParker: "short_term",
  longTermParker: "long_term",
  carSharer: "car_sharing",
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
  "structureType:offStreetSurface": "surface",
};

/** Usage scenarios that are usages of the model. */
const USAGES: Readonly<Record<string, string>> = {
  "usageScenario:truckParking": "truck",
  "usageScenario:parkAndRide": "park_and_ride",
  "usageScenario:liftshare": "carpool",
  "usageScenario:eventParking": "event",
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
    const typed = group.vehicleTypes.map((v) => DATEX2_PARKING_VEHICLE_TYPES[v]).find(Boolean);
    if (typed === undefined && group.characterised) continue;
    const vehicleType = typed ?? "any";
    const userGroup = group.userGroups.map((u) => USER_GROUPS[u]).find(Boolean) ?? "any";
    const area: AreaInput = {
      vehicleType,
      userGroup,
      ...(group.spaces === undefined ? {} : { capacity: group.spaces }),
    };
    const key = areaKey(area);
    out.set(group.index, { area, owner: !seen.has(key) });
    seen.add(key);
  }
  return out;
}

const EU_LABEL = /^securityLevel(\d)$/;

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
  const layout = record.layoutCodes.map((code) => LAYOUTS[code]).find(Boolean);
  const name = record.names[0];
  const level = record.labelSecurityLevel?.match(EU_LABEL)?.[1];
  const supervision =
    record.supervision === undefined ? undefined : DATEX2_PARKING_SUPERVISION[record.supervision];
  return {
    stationId: record.id,
    point,
    ...(name === undefined ? {} : { name: name.value, lang: name.lang }),
    externalIds: [
      {
        scheme: "datex:parking",
        id: record.id,
        ...(publisher === undefined ? {} : { authority: publisher }),
      },
    ],
    ...(type === undefined ? {} : { type }),
    ...(layout === undefined ? {} : { layout }),
    ...(record.operator === undefined ? {} : { operator: record.operator }),
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
    ...(text === undefined ? {} : { text }),
    ...(lang === undefined ? {} : { lang }),
  });
}

/**
 * A status's codes as one `parking.status`. A code its version's crosswalk
 * has no key for (v3's graded vacant spaces, v2's opening status) says
 * nothing; when several map, the most telling wins.
 */
function statusOf(status: DatexParkingStatus, target: Target): ParkingStatus | undefined {
  const mapped = status.statusCodes
    .map((code) => parkingCrosswalk.value("parking_status", target, code))
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
  // Without a stated total, the groups' spaces bound the free count: a count
  // above them is impossible. They only bound it; nothing is derived from them.
  const bound = site.record.totalSpaces === undefined ? groupSpaces(site.record) : undefined;
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
        capacity: site.record.totalSpaces,
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
  const trend =
    status.trendCode === undefined
      ? undefined
      : (parkingCrosswalk.value("trend", target, status.trendCode) as ParkingTrend | undefined);
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
        { available: group.vacant, occupied: group.occupied, capacity: owned.area.capacity },
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
 * readings of the sites and of their groups, joined by record id. A status
 * of a record the table does not hold is dropped; a record without a
 * placeable point is rejected.
 */
export function parseDatex2(
  feed: ParkingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const sites = new Map<string, TableSite>();
  let rejected = 0;
  for (const body of payloads["sites"] ?? []) {
    const doc = parseXmlDocument(body);
    const target = targetOf(versionOf(doc));
    const publisher = publisherOf(doc);
    for (const record of parseDatexParkingTable(doc)) {
      if (record.point === undefined) {
        rejected++;
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
    for (const status of parseDatexParkingStatus(doc)) {
      const site = sites.get(status.recordId);
      if (site === undefined) continue;
      out.observations.push(...readingsOf(feed, site, status, target, ctx));
    }
  }
  out.rejected = rejected;
  return out;
}
