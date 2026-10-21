import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
  recordSkipped,
} from "@openconditions/ingest-framework";
import {
  DATEX2_V2_PARKING,
  type ParkingSiteType,
  type ParkingStatus,
  type ParkingUserGroup,
  type ParkingVehicleType,
} from "@openconditions/model-parking";
import type { ParkingCatalogFeed } from "../feed-schema.js";
import {
  type AreaInput,
  areaKey,
  entryOf,
  occupancyDrafts,
  type ParkingTrend,
  type ReadingInput,
  type SiteInput,
  siteDraft,
  statusDraft,
  trendDraft,
  zonedInstant,
} from "../site.js";

/** One assignment of a site's spaces to a user group, fuel or vehicle. */
interface LightAssignment {
  typeOfAssignment?: string | null;
  vehicleType?: string | null;
  fuelType?: string | null;
  user?: string | null;
  additionalAssignment?: string | null;
  /** The spaces assigned; the exporter's name for a count of bays, not of free ones. */
  availableSpaces?: number | null;
}

interface LightCoordinates {
  latitude?: number;
  longitude?: number;
  geometry?: { type?: string; coordinates?: unknown };
}

/** One `parkingSite` of a DATEX II Light parking publication, as the exporter writes it. */
interface LightSite {
  id?: string | null;
  externalId?: string | null;
  lastUpdate?: string | null;
  publicationTime?: string | null;
  type?: string | null;
  name?: string | null;
  description?: string | null;
  isOpenNow?: boolean | null;
  temporaryClosed?: boolean | null;
  freeParking?: boolean | null;
  numberOfSpaces?: number | null;
  availableSpaces?: number | null;
  occupancyTrend?: string | null;
  tariffDescription?: string[] | null;
  openingTimesDescription?: string[] | null;
  equipmentAndServices?: string[] | null;
  zoneDescription?: string[] | null;
  urlLinkAddress?: string | null;
  assignedFor?: LightAssignment[] | null;
  locationAndDimension?: {
    locationDescriptor?: string | null;
    roadName?: string | null;
    specificAccessInformation?: string[] | null;
    dimension?: { height?: number | null } | null;
    coordinatesForDisplay?: LightCoordinates | null;
  } | null;
}

const MOJIBAKE = /[ÃÂ]/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Windows-1252's characters for bytes 0x80–0x9F that are not Latin-1's. */
const CP1252_TO_BYTE = new Map<number, number>([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

/**
 * Text whose UTF-8 bytes were decoded once more as Windows-1252 or Latin-1
 * (`SÃ¼d` for `Süd`), as the Park+Ride bundle publishes it, read back as
 * UTF-8. Text with no sign of that, with a character no single byte gives,
 * or whose bytes are not UTF-8 is returned as it is.
 */
export function repairMojibake(text: string): string {
  if (!MOJIBAKE.test(text)) return text;
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const byte = c <= 0xff ? c : CP1252_TO_BYTE.get(c);
    if (byte === undefined) return text;
    bytes[i] = byte;
  }
  try {
    return UTF8.decode(bytes);
  } catch {
    return text;
  }
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const lines = (values: unknown): string[] =>
  Array.isArray(values) ? values.map(text).filter((v): v is string => v !== undefined) : [];

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * `[lon, lat]` from the display coordinates, an object or a GeoJSON point.
 * Some bundled records give latitude for longitude; in North Rhine-Westphalia
 * (about 6–10° E, 50–53° N) a longitude above 20 with a latitude below 20 is
 * such a record, read the other way round.
 */
function pointOf(c: LightCoordinates | null | undefined): [number, number] | undefined {
  const coords = c?.geometry?.coordinates;
  const [x, y]: unknown[] =
    finite(c?.longitude) && finite(c?.latitude)
      ? [c.longitude, c.latitude]
      : Array.isArray(coords) && coords.length === 2
        ? coords
        : [];
  if (!finite(x) || !finite(y)) return undefined;
  const [lon, lat] = x > 20 && y < 20 ? [y, x] : [x, y];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lon === 0 && lat === 0)) return undefined;
  return [lon, lat];
}

/**
 * The exporter's site types, written `carPark` or `CAR_PARK`. A `carPark` is
 * any off-street car park: the bundle types surface lots so as well as
 * garages, so it says nothing of how the site is built. `other` says only
 * that it is none of these.
 */
const TYPES: Readonly<Record<string, { type: ParkingSiteType; layout?: "surface" } | null>> = {
  carpark: { type: "off_street" },
  offstreetparkingground: { type: "off_street", layout: "surface" },
  onstreet: { type: "on_street" },
  other: null,
};

const typeKey = (value: unknown) => text(value)?.replace(/_/g, "").toLowerCase();

const PARK_AND_RIDE = /p\s*\+\s*r|p\s*&\s*r\b|park\s*(?:&|\+|and)\s*ride|parkandride/i;

/** The bundle's park-and-ride datasets name their records `park-and-ride-<city>-<n>`. */
const PARK_AND_RIDE_DATASET = /^park-and-ride-/;

const USERS: Readonly<Record<string, ParkingUserGroup>> = {
  disabled: "disabled",
  women: "women",
  familys: "family",
  families: "family",
  family: "family",
  residents: "residents",
  customers: "customers",
  shorttermparkers: "short_term",
  longtermparkers: "long_term",
};

const VEHICLES: Readonly<Record<string, ParkingVehicleType>> = {
  car: "car",
  lorry: "truck",
  truck: "truck",
  bus: "bus",
  coach: "coach",
  motorcycle: "motorcycle",
  bicycle: "bicycle",
  caravan: "caravan",
};

const CHARGING_FUELS = new Set(["battery", "electric", "electricity"]);

/** Every user DATEX names, lower-cased as the exporter's spellings are compared, and those read. */
const KNOWN_USERS: ReadonlySet<string> = new Set([
  ...DATEX2_V2_PARKING.userTypes.map((u) => u.toLowerCase()),
  ...Object.keys(USERS),
]);

const KNOWN_TRENDS: ReadonlySet<string> = new Set(
  DATEX2_V2_PARKING.parkingOccupancyTrends.map((t) => t.toLowerCase()),
);

/** Equipment lines that name an amenity, a way to pay or both. */
const EQUIPMENT: readonly [RegExp, { amenity?: string; payment?: string[] }][] = [
  [/geldautomat/i, { amenity: "cash_machine" }],
  [/toilette/i, { amenity: "toilets" }],
  [/barzahlung/i, { payment: ["cash"] }],
  [/debit/i, { payment: ["debit_card"] }],
  [/kreditkarte/i, { payment: ["credit_card"] }],
];

/** The stop a park-and-ride zone names as `ifopt: <id>`. */
const IFOPT = /^ifopt:\s*(\S+)$/i;

/** Equipment lines that say a site has such spaces, without a count. */
const EQUIPMENT_AREAS: readonly [RegExp, ParkingUserGroup][] = [
  [/behindertengerechte parkpl|behindertenparkpl/i, "disabled"],
  [/fahrzeug aufladen|ladesäule|ladestation/i, "ev_charging"],
];

const lower = (value: unknown) => text(value)?.toLowerCase();

/** A site's assignments that are objects; a null entry assigns nothing. */
const assignments = (site: LightSite): LightAssignment[] =>
  Array.isArray(site.assignedFor)
    ? site.assignedFor.filter((a) => typeof a === "object" && a !== null)
    : [];

/**
 * The site's areas: one per assignment to a user group or to charging, and
 * one per equipment line that names such spaces. A published count of 0
 * means none, so it is no area; an assignment without a count says only that
 * the site has such spaces.
 */
function areasOf(site: LightSite): AreaInput[] {
  const out: AreaInput[] = [];
  for (const a of assignments(site)) {
    const user = lower(a.user);
    const userGroup =
      entryOf(USERS, user) ??
      (CHARGING_FUELS.has(lower(a.fuelType) ?? "") ? "ev_charging" : undefined);
    if (userGroup === undefined) continue;
    const counted = finite(a.availableSpaces);
    if (counted && !(Number.isInteger(a.availableSpaces) && (a.availableSpaces as number) > 0)) {
      continue;
    }
    const vehicle = lower(a.vehicleType);
    out.push({
      vehicleType: entryOf(VEHICLES, vehicle) ?? "car",
      userGroup,
      ...(counted ? { capacity: a.availableSpaces as number } : {}),
    });
  }
  const equipment = lines(site.equipmentAndServices);
  for (const [pattern, userGroup] of EQUIPMENT_AREAS) {
    if (equipment.some((line) => pattern.test(line))) out.push({ vehicleType: "car", userGroup });
  }
  const seen = new Set<string>();
  return out.filter((area) => {
    const key = areaKey(area);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isParkAndRide(site: LightSite, stationId: string): boolean {
  const named = [site.name, site.description, ...(site.zoneDescription ?? [])].some(
    (t) => typeof t === "string" && PARK_AND_RIDE.test(t),
  );
  return (
    named ||
    PARK_AND_RIDE_DATASET.test(stationId) ||
    assignments(site).some((a) => lower(a.user) === "parkandrideusers")
  );
}

/**
 * The upstream system a bundle's record id comes from: the id without its
 * own number, after the last `-`, `.` or `_` (`parking-apcoa-4623` →
 * `parking-apcoa`, `parking-herne-parkmoeglichkeit.24`, `W_P08o` → `W`), else
 * its leading letters (`PH01` → `PH`). A city system's `<n>[<name>]` id has
 * none: `""`. The Mobidrom bundle lists one garage under several systems
 * (the city's and APCOA's), so each system is its own id authority.
 */
export function upstreamPrefix(id: string): string {
  if (/^\d+\[/.test(id)) return "";
  const separator = id.search(/[-._][^-._]*$/);
  if (separator > 0) return id.slice(0, separator);
  return id.match(/^[A-Za-z]+/)?.[0] ?? "";
}

function siteInput(
  feed: ParkingCatalogFeed,
  site: LightSite,
  stationId: string,
  point: [number, number],
): SiteInput {
  const prefix = upstreamPrefix(stationId);
  const typed = entryOf(TYPES, typeKey(site.type));
  const parkAndRide = isParkAndRide(site, stationId);
  const name = text(site.name) ?? text(site.description);
  const description = text(site.description);
  const height = site.locationAndDimension?.dimension?.height;
  const tariff = lines(site.tariffDescription);
  const hours = lines(site.openingTimesDescription);
  const address = text(site.locationAndDimension?.locationDescriptor);
  const street = text(site.locationAndDimension?.roadName);
  const accessNotes = lines(site.locationAndDimension?.specificAccessInformation);
  const customers = assignments(site).some((a) => lower(a.user) === "customers");
  const equipment = lines(site.equipmentAndServices).flatMap((line) =>
    EQUIPMENT.filter(([pattern]) => pattern.test(line)).map(([, meaning]) => meaning),
  );
  const stops = lines(site.zoneDescription).flatMap((line) => {
    const id = line.match(IFOPT)?.[1];
    return id === undefined ? [] : [{ scheme: "ifopt", id }];
  });
  const optional = <K extends keyof SiteInput>(key: K, value: SiteInput[K] | undefined) =>
    value === undefined ? {} : { [key]: value };
  return {
    stationId,
    ...(prefix === "" ? {} : { providerAuthority: `${feed.id}/${prefix}` }),
    point,
    lang: "de",
    ...optional("name", name),
    ...optional("type", parkAndRide ? "park_and_ride" : typed?.type),
    ...optional("layout", typed?.layout),
    ...optional("website", text(site.urlLinkAddress)),
    ...optional(
      "address",
      address === undefined && street === undefined
        ? undefined
        : {
            ...(address === undefined ? {} : { text: address }),
            ...(street === undefined ? {} : { street }),
          },
    ),
    ...optional("accessNotes", accessNotes.length === 0 ? undefined : accessNotes.join("\n")),
    amenities: [...new Set(equipment.flatMap((e) => (e.amenity === undefined ? [] : [e.amenity])))],
    payment: equipment.flatMap((e) => e.payment ?? []) as SiteInput["payment"],
    stops,
    ...optional(
      "notes",
      description !== undefined && description !== name ? description : undefined,
    ),
    ...optional("tariffText", tariff.length === 0 ? undefined : tariff.join("\n")),
    ...optional("openingHoursText", hours.length === 0 ? undefined : hours.join("; ")),
    ...(site.freeParking === true ? { free: true } : {}),
    ...optional("capacityTotal", finite(site.numberOfSpaces) ? site.numberOfSpaces : undefined),
    ...optional("heightLimitM", finite(height) && height > 0 ? height : undefined),
    areas: areasOf(site),
    usage: [...(parkAndRide ? ["park_and_ride"] : []), ...(customers ? ["customer"] : [])],
  };
}

const TRENDS: Readonly<Record<string, ParkingTrend>> = {
  increasing: "filling",
  decreasing: "clearing",
  stable: "steady",
};

function statusOf(site: LightSite): ParkingStatus | undefined {
  if (site.temporaryClosed === true) return "closed_abnormally";
  if (site.isOpenNow === false) return "closed";
  if (site.isOpenNow === true) return "open";
  return undefined;
}

/**
 * How many enumerated values of a site go unread: a site type, an
 * assignment's user or an occupancy trend DATEX does not define.
 */
function unreadValues(site: LightSite): number {
  const type = typeKey(site.type);
  const trend = lower(site.occupancyTrend);
  return [
    type !== undefined && !Object.hasOwn(TYPES, type),
    ...assignments(site).map((a) => {
      const user = lower(a.user);
      return user !== undefined && !KNOWN_USERS.has(user);
    }),
    trend !== undefined && !KNOWN_TRENDS.has(trend),
  ].filter(Boolean).length;
}

function readingsOf(
  feed: ParkingCatalogFeed,
  site: LightSite,
  reading: ReadingInput,
  ctx: ParseContext,
): RecordDraft[] {
  const out: (RecordDraft | undefined)[] = [
    ...occupancyDrafts(
      feed,
      reading,
      {
        ...(finite(site.availableSpaces) ? { available: site.availableSpaces } : {}),
        ...(finite(site.numberOfSpaces) ? { capacity: site.numberOfSpaces } : {}),
      },
      ctx,
    ),
  ];
  const status = statusOf(site);
  if (status !== undefined) out.push(statusDraft(feed, { ...reading, status }, ctx));
  const trend = entryOf(TRENDS, lower(site.occupancyTrend));
  if (trend !== undefined) out.push(trendDraft(feed, { ...reading, trend }, ctx));
  return out.filter((d): d is RecordDraft => d !== undefined);
}

const instant = (value: unknown): string | undefined => zonedInstant(text(value));

/** The sites of a body and its publication time: the light publication, or a bare array. */
function sitesOf(body: Buffer): { sites: LightSite[]; publishedAt?: string } {
  const doc = JSON.parse(body.toString("utf8"), (_key, value) =>
    typeof value === "string" ? repairMojibake(value) : value,
  ) as unknown;
  if (Array.isArray(doc)) return { sites: doc as LightSite[] };
  const publication = (doc as { parkingPublicationLight?: Record<string, unknown> } | null)
    ?.parkingPublicationLight;
  const sites = publication?.["parkingSite"];
  if (!Array.isArray(sites)) throw new Error("datex2-light: body has no parkingSite array");
  const publishedAt = instant(publication?.["publicationTime"]);
  return { sites: sites as LightSite[], ...(publishedAt === undefined ? {} : { publishedAt }) };
}

/**
 * The DATEX II Light JSON of the NRW Mobilithek exporter (Mobidrom): a
 * `parkingPublicationLight.parkingSite[]` publication or a bare array of
 * sites. Text is repaired where the publisher double-encoded it. Readings
 * are dated by the site's last update, else the publication time. A
 * park-and-ride zone's IFOPT id is the stop it serves; equipment lines that
 * name a cash machine, toilets or a way to pay are read as such. A site
 * without an id is counted as `malformed`, one without a placeable point as
 * `no_geometry`, and a site type, user or trend DATEX does not define as an
 * unknown value.
 */
export function parseDatex2Light(
  feed: ParkingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  let malformed = 0;
  let unplaced = 0;
  let unknown = 0;
  for (const body of payloads["main"] ?? []) {
    const { sites, publishedAt } = sitesOf(body);
    for (const site of sites) {
      if (typeof site !== "object" || site === null) {
        malformed++;
        continue;
      }
      const stationId = text(site.id) ?? text(site.externalId);
      const point = pointOf(site.locationAndDimension?.coordinatesForDisplay);
      if (stationId === undefined) {
        malformed++;
        continue;
      }
      if (point === undefined) {
        unplaced++;
        continue;
      }
      unknown += unreadValues(site);
      out.features.push(siteDraft(feed, siteInput(feed, site, stationId, point), ctx.fetchedAt));
      const at =
        instant(site.lastUpdate) ?? instant(site.publicationTime) ?? publishedAt ?? ctx.fetchedAt;
      out.observations.push(...readingsOf(feed, site, { stationId, at, point }, ctx));
    }
  }
  recordSkipped(feed.id, "malformed", malformed);
  recordSkipped(feed.id, "no_geometry", unplaced);
  recordSkipped(feed.id, "unknown_value", unknown);
  return out;
}
