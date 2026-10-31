import {
  type CatalogFeed,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
  recordSkipped,
} from "@openconditions/ingest-framework";
import {
  type AUDIENCES,
  type ExternalId,
  type IMAGE_CATEGORIES,
  type LIFECYCLES,
  observationId,
  type PAYMENT_METHODS,
  type Quantity,
  recordLocalId,
  zonedWallClockToInstant,
} from "@openconditions/model";
import {
  type PARKING_ENTRANCES,
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
import { z } from "zod";

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
  /** `derived` where the point was computed (a way's centre, an area's vertex mean). */
  geometryOrigin?: "source" | "derived";
  /** The name in the site's language, or in each language the source gives it in. */
  name?: string | { lang: string; text: string }[];
  /** The language of the source's texts (BCP 47); `und` when unknown. */
  lang?: string;
  /** Ids beside the provider id that linking matches on (`osm:way`, `datex:parking`). */
  externalIds?: ExternalId[];
  type?: ParkingSiteType;
  layout?: ParkingLayout;
  lifecycle?: (typeof LIFECYCLES)[number];
  operator?: string;
  /** How to reach the operator, where the publisher may make it known. */
  operatorContact?: Contact;
  /** Who owns the site, where it is not the operator. */
  owner?: string;
  ownerContact?: Contact;
  website?: string;
  address?: SiteAddress;
  /** Opening hours in the OSM `opening_hours` grammar. */
  openingHoursOsm?: string;
  /** The weekly spans of `openingHoursOsm`, where the source states them as such. */
  openingHoursSpec?: { days: string[]; opens: string; closes: string }[];
  /** The source states opening hours the parser cannot read whole. */
  openingHoursUnreadable?: boolean;
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
  /** Notes in the site's language, or in each language the source writes them in. */
  notes?: string | { lang: string; text: string }[];
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
  /** How to get in and out, such as outside opening hours. */
  accessNotes?: string;
  /** How a visitor can pay; `free` follows from `free` already. */
  payment?: (typeof PAYMENT_METHODS)[number][];
  widthLimitM?: number;
  /** How many levels the site parks vehicles on. */
  levels?: number;
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
  entrances?: { point: [number, number]; kind: (typeof PARKING_ENTRANCES)[number] }[];
  /** Single bays the source publishes, each with a key unique within the site. */
  spaces?: SpaceInput[];
}

/** One bay of a site. */
export interface SpaceInput {
  key: string;
  point?: [number, number];
  name?: string;
  /** The bay's number or label as the source writes it. */
  number?: string;
  vehicleType?: ParkingVehicleType;
  userGroup?: ParkingUserGroup;
}

/** An organisation's web page, phone and e-mail. */
export interface Contact {
  website?: string;
  phone?: string;
  email?: string;
}

/** A reading of a site, or of one of its areas. */
export interface ReadingInput {
  /** The upstream publishers that supplied this reading. */
  upstream?: SiteInput["upstream"];
  stationId: string;
  area?: { vehicleType: ParkingVehicleType; userGroup: ParkingUserGroup };
  /** A single space of the site the reading is of, by its component key. */
  spaceKey?: string;
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

/**
 * A count a source can mean: a whole number of spaces, zero or more, and no
 * larger than a number counts exactly (`1e308` is an integer to JavaScript).
 */
export function validCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A publisher's position as `[lon, lat]` when both are finite and in range
 * (longitude −180..180, latitude −90..90); undefined otherwise, so a site
 * is never placed off the globe.
 */
export function lonLat(lon: unknown, lat: unknown): [number, number] | undefined {
  return typeof lon === "number" &&
    typeof lat === "number" &&
    Math.abs(lon) <= 180 &&
    Math.abs(lat) <= 90
    ? [lon, lat]
    : undefined;
}

/**
 * A code table's own entry for a publisher's token; an inherited key such as
 * `constructor` or `toString` is none, like any token the table lacks.
 */
export function entryOf<T>(
  table: Readonly<Record<string, T>>,
  key: string | null | undefined,
): T | undefined {
  return key != null && Object.hasOwn(table, key) ? table[key] : undefined;
}

/** An instant in UTC at second precision, as the drafts carry it. */
export function utcInstant(at: Date): string {
  return at.toISOString().replace(/\.000Z$/, "Z");
}

/**
 * Whether an instant has a four-digit year, which RFC 3339 requires:
 * JavaScript reads and writes years past 9999 and before 0 with a sign and
 * six digits (`+012026-…`), which no reader of the drafts accepts.
 */
const writable = (ms: number) =>
  ms >= Date.parse("0000-01-01T00:00:00Z") && ms < Date.parse("+010000-01-01T00:00:00Z");

const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(\.\d+)?$/;

/**
 * The UTC instant of a publisher's timestamp. A time with an offset (`Z`,
 * `+01:00`, or `+0100` as some feeds write it) is taken as given; a time
 * without one is wall-clock time in the publisher's `timeZone`, fractional
 * seconds kept. A space may stand for the `T`. Undefined when unreadable,
 * and for a year RFC 3339 cannot write (before 0000 or after 9999).
 */
export function instantIn(timeZone: string, value: unknown): string | undefined {
  const t = typeof value === "string" ? value.trim() : "";
  const iso = t
    .replace(/^(\d{4}-\d{2}-\d{2}) (?=\d)/, "$1T")
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(iso)) {
    const ms = Date.parse(iso);
    return writable(ms) ? utcInstant(new Date(ms)) : undefined;
  }
  const m = iso.match(WALL_CLOCK);
  const at = m?.[1] === undefined ? null : zonedWallClockToInstant(timeZone, m[1]);
  if (at === null) return undefined;
  const fraction = m?.[2] === undefined ? 0 : Math.round(Number(`0${m[2]}`) * 1000);
  const ms = at.getTime() + fraction;
  return writable(ms) ? utcInstant(new Date(ms)) : undefined;
}

/**
 * The UTC instant of a time that states its zone (`Z` or an offset), as an
 * RFC 3339 date-time must; undefined for one that does not. A time without
 * a zone is local to a zone the format does not name, which `Date.parse`
 * would read in the zone of whatever machine parses it.
 */
export function zonedInstant(value: unknown): string | undefined {
  const t = typeof value === "string" ? value.trim() : "";
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(t) ? instantIn("UTC", t) : undefined;
}

/** The key of an area component: `<vehicleType>:<userGroup>`. */
export function areaKey(area: { vehicleType: string; userGroup: string }): string {
  return `${area.vehicleType}:${area.userGroup}`;
}

/**
 * Reads one source record with `read`. A field of another JSON type than the
 * format gives it (a number for a name, a string for a list) makes reading it
 * throw a TypeError; that record is then counted as malformed and whatever it
 * had added to `out` taken back, so it cannot fail the poll or leave half a
 * site. Any other error still fails the parse.
 */
export function readRecord(
  feedId: string,
  read: () => void,
  out?: Pick<ParseOutput, "features" | "observations" | "offers">,
): void {
  const lengths = out && [out.features.length, out.observations.length, out.offers.length];
  try {
    read();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    if (out && lengths) {
      out.features.length = lengths[0]!;
      out.observations.length = lengths[1]!;
      out.offers.length = lengths[2]!;
    }
    recordSkipped(feedId, "malformed");
  }
}

/** The id of a site's feature. */
export function siteId(feed: Pick<ParkingFeed, "id">, stationId: string): string {
  return `oc:feature:${feed.id}:${recordLocalId(stationId)}`;
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

function pointLocation(
  point: [number, number],
  geometryOrigin: "source" | "derived" = "source",
): Record<string, unknown> {
  return {
    geometry: { type: "Point", coordinates: [point[0], point[1]] },
    extent: "point",
    geometryOrigin,
    fuzziness: "exact",
  };
}

const UNLOCATED = { geometry: null, extent: "none", geometryOrigin: "none", fuzziness: "exact" };

const clean = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text ? text : undefined;
};

/** An e-mail address the model can hold. */
const EMAIL = z.email();

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

/** One component per bay, the first of a repeated key winning. */
function spaceComponents(spaces: readonly SpaceInput[] | undefined, lang: string) {
  const seen = new Set<string>();
  return (spaces ?? []).flatMap((space) => {
    if (seen.has(space.key)) return [];
    seen.add(space.key);
    const name = clean(space.name);
    const number = clean(space.number);
    return [
      {
        key: space.key,
        kind: "parking_space",
        ...(name === undefined ? {} : { name: [{ lang, text: name }] }),
        ...(space.point === undefined
          ? {}
          : { position: { type: "Point", coordinates: [space.point[0], space.point[1]] } }),
        details: {
          kind: "parking_space",
          v: 1,
          ...(number === undefined ? {} : { number }),
          ...(space.vehicleType === undefined ? {} : { vehicleType: space.vehicleType }),
          ...(space.userGroup === undefined ? {} : { userGroup: space.userGroup }),
        },
      },
    ];
  });
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
  const components = [...areaComponents(input.areas), ...spaceComponents(input.spaces, lang)];
  const name = Array.isArray(input.name)
    ? input.name.flatMap((n) => {
        const t = clean(n.text);
        return t === undefined ? [] : [{ lang: n.lang, text: t }];
      })
    : text(input.name);
  const organisation = (
    role: "operator" | "owner",
    name: string | undefined,
    contact: Contact | undefined,
  ) => {
    const named = text(name);
    if (named === undefined) return undefined;
    const website = webUrl(contact?.website);
    const phone = clean(contact?.phone);
    const email = clean(contact?.email);
    return {
      role,
      name: named,
      ...(website === undefined ? {} : { website }),
      ...(phone === undefined ? {} : { phone }),
      ...(email !== undefined && EMAIL.safeParse(email).success ? { email } : {}),
    };
  };
  const operator = organisation("operator", input.operator, input.operatorContact);
  const owner = organisation("owner", input.owner, input.ownerContact);
  const description = Array.isArray(input.notes)
    ? input.notes.flatMap((n) => {
        const t = clean(n.text);
        return t === undefined ? [] : [{ lang: n.lang, text: t }];
      })
    : text(input.notes);
  const hours = input.openingHoursUnreadable ? undefined : openingHours(input.openingHoursOsm);
  const spec = (input.openingHoursSpec ?? []).map((s) => ({ ...s, days: [...s.days] }));
  const payment = [
    ...new Set([...(input.free === true ? ["free"] : []), ...(input.payment ?? [])]),
  ];
  const accessNotes = text(input.accessNotes);
  const access =
    input.audience !== undefined || payment.length > 0 || accessNotes !== undefined
      ? {
          audience: input.audience ?? "unknown",
          ...(payment.length === 0 ? {} : { payment }),
          ...(accessNotes === undefined ? {} : { notes: accessNotes }),
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
      ...pointLocation(input.point, input.geometryOrigin),
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
    ...(name === undefined || name.length === 0 ? {} : { name }),
    ...(description === undefined || description.length === 0 ? {} : { description }),
    ...(operator === undefined ? {} : { operator }),
    ...(owner === undefined ? {} : { owner }),
    ...(hours === undefined
      ? {}
      : { openingHours: { ...hours, ...(spec.length === 0 ? {} : { spec }) } }),
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
      ...(input.levels !== undefined && Number.isSafeInteger(input.levels) && input.levels > 0
        ? { levels: input.levels }
        : {}),
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
      ...(input.openingHoursUnreadable === true ? { openingHoursUnreadable: true } : {}),
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
 * when the measuring time is unreadable or so late that its validity would
 * end past the year 9999.
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
  const until = at + validitySec * 1000;
  if (!polled && !writable(until)) return undefined;
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
      ...(r.spaceKey !== undefined
        ? { componentKey: r.spaceKey }
        : r.area === undefined
          ? {}
          : { componentKey: areaKey(r.area) }),
    },
    result,
    phenomenonTime: { instant: r.at },
    ...(polled ? {} : { validUntil: new Date(until).toISOString() }),
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
 * without a finite price of zero or more, or with one too large to write in
 * decimals (`toFixed` turns to exponents from 1e21), are left out; undefined
 * when none is left.
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
    .filter((row) => Number.isFinite(row.amount) && row.amount >= 0 && row.amount < 1e21)
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
            ...(step !== undefined && Number.isSafeInteger(step) && step > 0
              ? { stepSize: step }
              : {}),
          },
        ],
        ...(Object.keys(restrictions).length === 0 ? {} : { restrictions }),
      };
    });
  if (elements.length === 0) return undefined;
  const text = clean(input.text);
  const url = webUrl(input.url);
  return {
    id: `oc:offer:${feed.id}:${recordLocalId(stationId)}:${n}`,
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
