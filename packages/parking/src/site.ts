import type { CatalogFeed, ParseContext, RecordDraft } from "@openconditions/ingest-framework";
import {
  type AUDIENCES,
  type ExternalId,
  type IMAGE_CATEGORIES,
  type LIFECYCLES,
  observationId,
  type PAYMENT_METHODS,
  type Quantity,
  zonedWallClockToInstant,
} from "@openconditions/model";
import {
  type PARKING_KERB_POSITIONS,
  type PARKING_ORIENTATIONS,
  PARKING_PROPERTIES,
  PARKING_USAGES,
  type ParkingLayout,
  ParkingOutlineGeometry,
  type ParkingSiteType,
  type ParkingStatus,
  type ParkingSupervision,
  type ParkingUserGroup,
  type ParkingVehicleType,
} from "@openconditions/model-parking";

/** What a parking record takes from its feed. */
export type ParkingFeed = Pick<
  CatalogFeed,
  "id" | "format" | "attribution" | "license" | "licenseUrl" | "accessMode" | "onDemand" | "region"
>;

/** Which way occupancy is moving, in the kernel's trend vocabulary. */
export type ParkingTrend = "filling" | "clearing" | "steady";

/**
 * One part of a site laid out for a vehicle type and user group. Without a
 * capacity the area says only that the site has such spaces.
 */
export interface AreaInput {
  vehicleType: ParkingVehicleType;
  userGroup: ParkingUserGroup;
  capacity?: number;
  /** When the area is kept for its user group and its maximum stay holds, in the OSM `opening_hours` grammar. */
  hoursOsm?: string;
  maxStay?: Quantity;
}

export interface SiteAddress {
  street?: string;
  houseNumber?: string;
  postalCode?: string;
  city?: string;
  text?: string;
  /** ISO 3166-1 alpha-2, where the source names it; else the feed's region. */
  country?: string;
}

export interface SiteInput {
  /** The source's own id of the site. */
  stationId: string;
  /**
   * Who issued `stationId`: the feed (default), or `<feedId>/<source uid>` for
   * an aggregator that names its upstream source, so two upstream sources of
   * one aggregator may still link.
   */
  providerAuthority?: string;
  /**
   * False when the site carries no `provider` id: its source's ids are
   * external ids already (`osm:way`), and a provider id would keep the node,
   * way and relation of one car park from linking.
   */
  providerId?: false;
  /** `[lon, lat]`. */
  point: [number, number];
  name?: string;
  /** The language of the source's texts (BCP 47); `und` when unknown. */
  lang?: string;
  /** Ids beside the provider id that linking matches on (`osm:way`, `datex:parking`). */
  externalIds?: ExternalId[];
  type?: ParkingSiteType;
  layout?: ParkingLayout;
  lifecycle?: (typeof LIFECYCLES)[number];
  operator?: string;
  website?: string;
  address?: SiteAddress;
  /** Opening hours in the OSM `opening_hours` grammar. */
  openingHoursOsm?: string;
  /** Opening hours as the publisher wrote them. */
  openingHoursText?: string;
  /** Who may park, only as the source states it. */
  audience?: (typeof AUDIENCES)[number];
  /** True when the source says parking is free of charge. */
  free?: boolean;
  capacityTotal?: number;
  heightLimitM?: number;
  areas?: AreaInput[];
  tariffText?: string;
  notes?: string;
  amenities?: string[];
  usage?: string[];
  /** An audited lorry-park rating, in the awarding scheme's own words. */
  securityRating?: { scheme: "esporg" | "eu_label"; level: string };
  /** `parking_security` values. */
  securityFeatures?: string[];
  supervision?: ParkingSupervision;
  /** The upstream publishers an aggregator took the site from. */
  upstream?: import("@openconditions/model").MergedSource["upstream"];
  /** Pictures of the site, http(s) only. */
  images?: { url: string; category: (typeof IMAGE_CATEGORIES)[number] }[];
  /** How a visitor can pay; `free` follows from `free` already. */
  payment?: (typeof PAYMENT_METHODS)[number][];
  widthLimitM?: number;
  /** The longest a vehicle may stay, for everyone at all hours. */
  maxStay?: Quantity;
  /** Whether a space can be booked ahead. */
  reservation?: boolean;
  /** The least and the most spaces the source estimates, where it does not count them. */
  capacityRange?: { min?: number; max?: number };
  bays?: {
    orientation?: (typeof PARKING_ORIENTATIONS)[number];
    position?: (typeof PARKING_KERB_POSITIONS)[number];
    side?: "left" | "right";
  };
  /** The site's area or line of bays, `[lon, lat]` GeoJSON; left out when it is no valid shape. */
  outline?: { geometry: unknown; line?: "road_centre" | "bays_centre" };
  /** The public transport stops a park-and-ride site serves. */
  stops?: ExternalId[];
  /** Administrative codes of where the site is (`ars`, `nuts`, …). */
  geocodes?: { scheme: string; code: string }[];
  /** Where the site is, in words: the place it is at or serves. */
  areaDescription?: string;
  /** An audited service rating of a lorry park. */
  serviceRating?: { scheme: "eu_label"; level: string };
  entrances?: {
    point: [number, number];
    kind: "vehicle_entrance" | "vehicle_exit" | "pedestrian";
  }[];
}

/** A reading of a site, or of one of its areas. */
export interface ReadingInput {
  /** The upstream publishers that supplied this reading. */
  upstream?: SiteInput["upstream"];
  stationId: string;
  area?: { vehicleType: ParkingVehicleType; userGroup: ParkingUserGroup };
  /** When the source measured it (ISO instant). */
  at: string;
  /** The site's `[lon, lat]`, where the reading is located; unlocated without it. */
  point?: [number, number];
  /**
   * How long the reading stays current, when the source's kind of reading
   * sets it (an estimate); else `max(30 min, two poll cadences)`.
   */
  validForSec?: number;
}

/** What a reading takes from the poll. */
export type ReadingContext = Pick<ParseContext, "fetchedAt" | "cadenceSec">;

/** Every reading stays current for at least half an hour. */
const MIN_VALIDITY_SEC = 1800;

/** A count a source can mean: a whole number of spaces, zero or more. */
export function validCount(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0;
}

/** An instant in UTC at second precision, as the drafts carry it. */
export function utcInstant(at: Date): string {
  return at.toISOString().replace(/\.000Z$/, "Z");
}

const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(\.\d+)?$/;

/**
 * The UTC instant of a publisher's timestamp. A time with an offset (`Z`,
 * `+01:00`, or `+0100` as some feeds write it) is taken as given; a time
 * without one is wall-clock time in the publisher's `timeZone`, fractional
 * seconds kept. A space may stand for the `T`. Undefined when unreadable.
 */
export function instantIn(timeZone: string, value: unknown): string | undefined {
  const t = typeof value === "string" ? value.trim() : "";
  const iso = t
    .replace(/^(\d{4}-\d{2}-\d{2}) (?=\d)/, "$1T")
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(iso)) {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? utcInstant(new Date(ms)) : undefined;
  }
  const m = iso.match(WALL_CLOCK);
  const at = m?.[1] === undefined ? null : zonedWallClockToInstant(timeZone, m[1]);
  if (at === null) return undefined;
  const fraction = m?.[2] === undefined ? 0 : Math.round(Number(`0${m[2]}`) * 1000);
  return utcInstant(new Date(at.getTime() + fraction));
}

/** The key of an area component: `<vehicleType>:<userGroup>`. */
export function areaKey(area: { vehicleType: string; userGroup: string }): string {
  return `${area.vehicleType}:${area.userGroup}`;
}

/** The id of a site's feature. */
export function siteId(feed: Pick<ParkingFeed, "id">, stationId: string): string {
  return `oc:feature:${feed.id}:${stationId}`;
}

/** The country a feed's region names; none for `eu` and `global`. */
function countryOf(feed: ParkingFeed): string | undefined {
  return /^[a-z]{2}$/.test(feed.region) && feed.region !== "eu"
    ? feed.region.toUpperCase()
    : undefined;
}

/**
 * When an on-demand feed's answer fetched at `fetchedAt` stops being current:
 * `onDemand.ttlSec` later. Undefined for a bulk feed, whose next poll replaces
 * the answer.
 */
function freshness(feed: ParkingFeed, fetchedAt: string): Record<string, unknown> {
  const ttlSec = feed.onDemand?.ttlSec;
  if (ttlSec === undefined) return { fetchedAt };
  return { fetchedAt, expiresAt: utcInstant(new Date(Date.parse(fetchedAt) + ttlSec * 1000)) };
}

function provenance(
  feed: ParkingFeed,
  recordId: string,
  upstream?: SiteInput["upstream"],
): Record<string, unknown> {
  return {
    origin: "feed",
    sourceId: feed.id,
    sourceFormat: feed.format,
    accessMode: feed.accessMode ?? "bulk",
    recordId,
    attribution: {
      provider: feed.attribution,
      license: feed.license,
      ...(feed.licenseUrl === undefined ? {} : { licenseUrl: feed.licenseUrl }),
    },
    ...(upstream === undefined || upstream.length === 0
      ? {}
      : { upstream: structuredClone(upstream) }),
    privacy: { class: "authoritative" },
  };
}

function pointLocation(point: [number, number]): Record<string, unknown> {
  return {
    geometry: { type: "Point", coordinates: [point[0], point[1]] },
    extent: "point",
    geometryOrigin: "source",
    fuzziness: "exact",
  };
}

const UNLOCATED = { geometry: null, extent: "none", geometryOrigin: "none", fuzziness: "exact" };

const clean = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text ? text : undefined;
};

/** A web page the model can hold: http(s) only, a bare `www.` host taken as https. */
function webUrl(value: string | undefined): string | undefined {
  const text = clean(value);
  if (text === undefined) return undefined;
  const url = /^www\./i.test(text) ? `https://${text}` : text;
  if (!URL.canParse(url)) return undefined;
  const { protocol } = new URL(url);
  return protocol === "http:" || protocol === "https:" ? url : undefined;
}

function addressOf(input: SiteInput, country: string | undefined) {
  if (country === undefined || input.address === undefined) return undefined;
  const parts = {
    street: clean(input.address.street),
    houseNumber: clean(input.address.houseNumber),
    postalCode: clean(input.address.postalCode),
    city: clean(input.address.city),
    text: clean(input.address.text),
  };
  const written = Object.fromEntries(Object.entries(parts).filter(([, v]) => v !== undefined));
  return Object.keys(written).length === 0 ? undefined : { ...written, country };
}

/** Opening hours in the OSM grammar, flagged when they are round the clock. */
function openingHours(osm: string | undefined) {
  const text = clean(osm);
  if (text === undefined) return undefined;
  return { osm: text, ...(text === "24/7" ? { twentyFourSeven: true } : {}) };
}

/** A quantity the model can hold: a finite value above zero. */
const positive = (q: Quantity | undefined) =>
  q !== undefined && Number.isFinite(q.value) && q.value > 0 ? { ...q } : undefined;

/** One component per (vehicleType, userGroup), the first of a repeated pair winning. */
function areaComponents(areas: readonly AreaInput[] | undefined) {
  const seen = new Set<string>();
  const out: RecordDraft[] = [];
  for (const area of areas ?? []) {
    const key = areaKey(area);
    if (seen.has(key)) continue;
    seen.add(key);
    const hours = openingHours(area.hoursOsm);
    const maxStay = positive(area.maxStay);
    out.push({
      key,
      kind: "parking_area",
      details: {
        kind: "parking_area",
        v: 1,
        vehicleType: area.vehicleType,
        userGroup: area.userGroup,
        ...(validCount(area.capacity) ? { capacity: area.capacity } : {}),
        ...(hours === undefined ? {} : { hours }),
        ...(maxStay === undefined ? {} : { maxStay }),
      },
    });
  }
  return out;
}

/** A site's outline, when its geometry is one of the shapes the model holds. */
function outlineOf(outline: SiteInput["outline"]) {
  const g = outline?.geometry as { type?: unknown; coordinates?: unknown } | undefined;
  if (g === undefined || g === null || typeof g !== "object") return undefined;
  const parsed = ParkingOutlineGeometry.safeParse({ type: g.type, coordinates: g.coordinates });
  if (!parsed.success) return undefined;
  const lines = parsed.data.type === "LineString" || parsed.data.type === "MultiLineString";
  return {
    geometry: parsed.data,
    ...(lines && outline?.line !== undefined ? { line: outline.line } : {}),
  };
}

/** The keys of an object whose value is set. */
const defined = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

const USAGES: ReadonlySet<string> = new Set(PARKING_USAGES);

/**
 * A `parking_site` feature. It carries its provider id unless the input
 * says otherwise, so two sites of one source never link; a site without a
 * stated type is `off_street`.
 */
export function siteDraft(feed: ParkingFeed, input: SiteInput, fetchedAt: string): RecordDraft {
  const lang = input.lang ?? "und";
  const text = (value: string | undefined) => {
    const t = clean(value);
    return t === undefined ? undefined : [{ lang, text: t }];
  };
  const stated = clean(input.address?.country)?.toUpperCase();
  const country = stated !== undefined && /^[A-Z]{2}$/.test(stated) ? stated : countryOf(feed);
  const address = addressOf(input, country);
  const components = areaComponents(input.areas);
  const name = text(input.name);
  const operator = text(input.operator);
  const description = text(input.notes);
  const hours = openingHours(input.openingHoursOsm);
  const payment = [
    ...new Set([...(input.free === true ? ["free"] : []), ...(input.payment ?? [])]),
  ];
  const access =
    input.audience !== undefined || payment.length > 0
      ? {
          audience: input.audience ?? "unknown",
          ...(payment.length === 0 ? {} : { payment }),
        }
      : undefined;
  const images = (input.images ?? []).flatMap((image) => {
    const url = webUrl(image.url);
    return url === undefined ? [] : [{ url, category: image.category }];
  });
  const geocodes = (input.geocodes ?? []).filter((g) => clean(g.code) !== undefined);
  const areaDescription = text(input.areaDescription);
  const admin =
    country === undefined
      ? undefined
      : {
          country,
          ...(geocodes.length === 0
            ? {}
            : { geocodes: geocodes.map((g) => ({ scheme: g.scheme, code: g.code.trim() })) }),
        };
  const widthLimitM = input.widthLimitM;
  const maxStay = positive(input.maxStay);
  const range = defined({
    min: validCount(input.capacityRange?.min) ? input.capacityRange.min : undefined,
    max: validCount(input.capacityRange?.max) ? input.capacityRange.max : undefined,
  });
  const bays = defined({ ...input.bays });
  const outline = outlineOf(input.outline);
  const stops = (input.stops ?? []).map((e) => ({ ...e }));
  const entrances = (input.entrances ?? []).map((e) => ({
    point: { type: "Point", coordinates: [e.point[0], e.point[1]] },
    kind: e.kind,
  }));
  const amenities = (input.amenities ?? []).filter((a) => a.trim() !== "");
  const usage = (input.usage ?? []).filter((u) => USAGES.has(u));
  const website = webUrl(input.website);
  const tariffText = text(input.tariffText);
  const openingHoursText = text(input.openingHoursText);
  const heightLimitM = input.heightLimitM;
  const securityFeatures = [...new Set(input.securityFeatures ?? [])];
  return {
    id: siteId(feed, input.stationId),
    class: "feature",
    kind: "parking_site",
    type: input.type ?? "off_street",
    temporality: "static",
    lifecycle: input.lifecycle ?? "operational",
    location: {
      ...pointLocation(input.point),
      ...(address === undefined ? {} : { address }),
      ...(admin === undefined ? {} : { admin }),
      ...(areaDescription === undefined ? {} : { areaDescription }),
    },
    provenance: provenance(feed, input.stationId, input.upstream),
    freshness: freshness(feed, fetchedAt),
    externalIds: [
      ...(input.providerId === false
        ? []
        : [
            {
              scheme: "provider",
              id: input.stationId,
              authority: input.providerAuthority ?? feed.id,
            },
          ]),
      ...(input.externalIds ?? []).map((e) => ({ ...e })),
    ],
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(operator === undefined ? {} : { operator: { role: "operator", name: operator } }),
    ...(hours === undefined ? {} : { openingHours: hours }),
    ...(access === undefined ? {} : { access }),
    ...(amenities.length === 0 ? {} : { amenities }),
    ...(images.length === 0 ? {} : { images }),
    ...(components.length === 0 ? {} : { components }),
    details: {
      kind: "parking_site",
      v: 1,
      ...(input.layout === undefined ? {} : { layout: input.layout }),
      ...(validCount(input.capacityTotal) ? { capacityTotal: input.capacityTotal } : {}),
      ...(Object.keys(range).length === 0 ? {} : { capacityRange: range }),
      ...(heightLimitM !== undefined && Number.isFinite(heightLimitM) && heightLimitM > 0
        ? { heightLimit: { value: heightLimitM, unit: "m" } }
        : {}),
      ...(widthLimitM !== undefined && Number.isFinite(widthLimitM) && widthLimitM > 0
        ? { widthLimit: { value: widthLimitM, unit: "m" } }
        : {}),
      ...(input.securityRating === undefined
        ? {}
        : { securityRating: { ...input.securityRating } }),
      ...(input.serviceRating === undefined ? {} : { serviceRating: { ...input.serviceRating } }),
      ...(securityFeatures.length === 0 ? {} : { securityFeatures }),
      ...(input.supervision === undefined ? {} : { supervision: input.supervision }),
      ...(entrances.length === 0 ? {} : { entrances }),
      ...(maxStay === undefined ? {} : { maxStay }),
      ...(input.reservation === undefined ? {} : { reservation: input.reservation }),
      ...(Object.keys(bays).length === 0 ? {} : { bays }),
      ...(outline === undefined ? {} : { outline }),
      ...(stops.length === 0 ? {} : { stops }),
      ...(usage.length === 0 ? {} : { usage: [...new Set(usage)] }),
      ...(website === undefined ? {} : { website }),
      ...(tariffText === undefined ? {} : { tariffText }),
      ...(openingHoursText === undefined ? {} : { openingHoursText }),
    },
  };
}

/** The properties written only when their result changes. */
const CHANGE_ONLY = new Set(
  PARKING_PROPERTIES.filter((p) => p.retention?.changeOnly).map((p) => p.code),
);

/**
 * A reading of the site or one of its areas, current until
 * `max(30 min, two poll cadences)` after it was measured. A polled feed's
 * reading of a change-only property (a count, a status, a trend) states no
 * validity: it is written when it changes and holds while the feed polls,
 * which the read computes from the source's last successful poll. Undefined
 * when the measuring time is unreadable.
 */
function readingDraft(
  feed: ParkingFeed,
  r: ReadingInput,
  property: string,
  result: RecordDraft,
  ctx: ReadingContext,
): RecordDraft | undefined {
  const at = Date.parse(r.at);
  if (!Number.isFinite(at)) return undefined;
  const polled = (feed.accessMode ?? "bulk") === "bulk" && CHANGE_ONLY.has(property);
  const validitySec = r.validForSec ?? Math.max(MIN_VALIDITY_SEC, 2 * (ctx.cadenceSec ?? 0));
  const draft = {
    class: "observation",
    kind: "observation",
    property,
    temporality: "live",
    location: r.point === undefined ? { ...UNLOCATED } : pointLocation(r.point),
    provenance: provenance(feed, r.stationId, r.upstream),
    freshness: freshness(feed, ctx.fetchedAt),
    subject: {
      kind: "feature",
      featureId: siteId(feed, r.stationId),
      ...(r.area === undefined ? {} : { componentKey: areaKey(r.area) }),
    },
    result,
    phenomenonTime: { instant: r.at },
    ...(polled ? {} : { validUntil: new Date(at + validitySec * 1000).toISOString() }),
    aggregation: "instantaneous",
  };
  return { id: observationId(feed.id, draft as never), ...draft };
}

/**
 * `parking.available`: spaces free now. No reading for a count that is not a
 * whole number of zero or more, or that exceeds the given capacity.
 */
export function availableDraft(
  feed: ParkingFeed,
  r: ReadingInput & { count: number; capacity?: number },
  ctx: ReadingContext,
): RecordDraft | undefined {
  if (!validCount(r.count)) return undefined;
  if (validCount(r.capacity) && r.count > r.capacity) return undefined;
  return readingDraft(feed, r, "parking.available", { type: "count", value: r.count }, ctx);
}

/**
 * `parking.occupied`: spaces in use. A count above capacity is kept: the
 * source says the car park is over-full.
 */
export function occupiedDraft(
  feed: ParkingFeed,
  r: ReadingInput & { count: number },
  ctx: ReadingContext,
): RecordDraft | undefined {
  if (!validCount(r.count)) return undefined;
  return readingDraft(feed, r, "parking.occupied", { type: "count", value: r.count }, ctx);
}

/** `parking.occupancy_pct`: the share of spaces in use, as published; none when negative. */
export function occupancyPctDraft(
  feed: ParkingFeed,
  r: ReadingInput & { pct: number },
  ctx: ReadingContext,
): RecordDraft | undefined {
  if (!Number.isFinite(r.pct) || r.pct < 0) return undefined;
  return readingDraft(
    feed,
    r,
    "parking.occupancy_pct",
    { type: "quantity", value: r.pct, unit: "%" },
    ctx,
  );
}

/** `parking.status`: whether the site is open and has room. */
export function statusDraft(
  feed: ParkingFeed,
  r: ReadingInput & { status: ParkingStatus },
  ctx: ReadingContext,
): RecordDraft | undefined {
  return readingDraft(
    feed,
    r,
    "parking.status",
    { type: "category", value: r.status, vocabulary: "parking_status" },
    ctx,
  );
}

/** `parking.trend`: which way occupancy is moving. */
export function trendDraft(
  feed: ParkingFeed,
  r: ReadingInput & { trend: ParkingTrend },
  ctx: ReadingContext,
): RecordDraft | undefined {
  return readingDraft(
    feed,
    r,
    "parking.trend",
    { type: "category", value: r.trend, vocabulary: "trend" },
    ctx,
  );
}

/**
 * The count readings a source's free, taken and total spaces give: the free
 * count as published, else `capacity − occupied` (at least 0) when both are
 * known; the occupied count only when the source gives it. Counts are never
 * invented: an impossible one gives no reading.
 */
export function occupancyDrafts(
  feed: ParkingFeed,
  r: ReadingInput,
  counts: { available?: number; occupied?: number; capacity?: number },
  ctx: ReadingContext,
): RecordDraft[] {
  const capacity = validCount(counts.capacity) ? counts.capacity : undefined;
  const occupied = validCount(counts.occupied) ? counts.occupied : undefined;
  // A free count above capacity is impossible, so it is no reading, and the
  // count derived from the same publication's occupied spaces is not one either.
  const impossible =
    validCount(counts.available) && capacity !== undefined && counts.available > capacity;
  let available = validCount(counts.available) && !impossible ? counts.available : undefined;
  if (available === undefined && !impossible && occupied !== undefined && capacity !== undefined) {
    available = Math.max(0, capacity - occupied);
  }
  const out: (RecordDraft | undefined)[] = [
    available === undefined ? undefined : availableDraft(feed, { ...r, count: available }, ctx),
    occupied === undefined ? undefined : occupiedDraft(feed, { ...r, count: occupied }, ctx),
  ];
  return out.filter((d): d is RecordDraft => d !== undefined);
}

/**
 * One priced row of a tariff, for `userGroups`, while the stay is between
 * `minDuration` and `maxDuration`. A `flat` row (the default) is one price;
 * a `parking_time` row's `amount` is the price per hour, billed in steps of
 * `stepSizeSec`.
 */
export interface RateRow {
  amount: number;
  component?: "flat" | "parking_time";
  stepSizeSec?: number;
  minDuration?: Quantity;
  maxDuration?: Quantity;
  userGroups?: string[];
}

/**
 * A decimal string of a price: at least to the cent, and to four places
 * where a rate per hour derived from another step is not a whole cent.
 */
const money = (amount: number) => amount.toFixed(4).replace(/0{1,2}$/, "");

/**
 * A `parking_rate` offer for a site: one element per priced row. Rows
 * without a finite price of zero or more are left out; undefined when none
 * is left.
 */
export function rateDraft(
  feed: ParkingFeed,
  stationId: string,
  n: number,
  input: {
    currency: string;
    rows: RateRow[];
    /** The tariff as the publisher wrote it. */
    text?: string;
    lang?: string;
    /** The site's `[lon, lat]`, where the offer is located; unlocated without it. */
    point?: [number, number];
    /** When the poll read the tariff. */
    fetchedAt: string;
    /** The publisher's page of the tariff. */
    url?: string;
  },
): RecordDraft | undefined {
  const elements = input.rows
    .filter((row) => Number.isFinite(row.amount) && row.amount >= 0)
    .map((row) => {
      const restrictions = {
        ...(row.minDuration === undefined ? {} : { minDuration: { ...row.minDuration } }),
        ...(row.maxDuration === undefined ? {} : { maxDuration: { ...row.maxDuration } }),
        ...(row.userGroups === undefined || row.userGroups.length === 0
          ? {}
          : { userGroups: [...row.userGroups] }),
      };
      const step = row.stepSizeSec;
      return {
        components: [
          {
            type: row.component ?? "flat",
            price: { amount: money(row.amount), currency: input.currency },
            ...(step !== undefined && Number.isInteger(step) && step > 0 ? { stepSize: step } : {}),
          },
        ],
        ...(Object.keys(restrictions).length === 0 ? {} : { restrictions }),
      };
    });
  if (elements.length === 0) return undefined;
  const text = clean(input.text);
  const url = webUrl(input.url);
  return {
    id: `oc:offer:${feed.id}:${stationId}:${n}`,
    class: "offer",
    kind: "parking_rate",
    temporality: "static",
    subject: { class: "feature", id: siteId(feed, stationId) },
    currency: input.currency,
    elements,
    ...(text === undefined ? {} : { displayText: [{ lang: input.lang ?? "und", text }] }),
    ...(url === undefined ? {} : { url }),
    validity: { status: "active" },
    location: input.point === undefined ? { ...UNLOCATED } : pointLocation(input.point),
    provenance: provenance(feed, stationId),
    freshness: freshness(feed, input.fetchedAt),
  };
}
