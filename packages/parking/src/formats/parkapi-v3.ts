import {
  captureLicensing,
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { ExternalId, Quantity } from "@openconditions/model";
import {
  PARKAPI_KERB_POSITIONS,
  PARKAPI_LINE_POSITIONS,
  PARKAPI_ORIENTATIONS,
  PARKAPI_RESTRICTION_AREAS,
  PARKAPI_SIDES,
  PARKAPI_SUPERVISION,
  PARKAPI_V3,
  PARKAPI_VEHICLE_TYPES,
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
  entryOf,
  occupancyDrafts,
  type ReadingInput,
  type SiteInput,
  siteDraft,
  statusDraft,
  utcInstant,
  validCount,
} from "../site.js";

/**
 * One entry of a site's `restrictions[]`: an audience (`type`) the site, or
 * the part of it its own `capacity` counts, is kept for, during its `hours`
 * (OSM `opening_hours`) and for at most its `max_stay` (ISO 8601). Without a
 * type it restricts every audience. Several entries are alternatives.
 */
interface ParkApiRestriction {
  type?: string;
  capacity?: number;
  realtime_capacity?: number;
  realtime_free_capacity?: number;
  hours?: string;
  max_stay?: string;
}

/** One parking site of `/v3/parking-sites`, as far as it is read. */
interface ParkApiSite {
  id?: number | string;
  source_id?: number;
  source_uid?: string;
  original_uid?: string;
  photo_url?: string;
  name?: string;
  operator_name?: string;
  public_url?: string;
  address?: string;
  description?: string;
  type?: string;
  purpose?: string;
  park_and_ride_type?: string[];
  has_fee?: boolean;
  fee_description?: string;
  opening_hours?: string;
  max_height?: number;
  max_width?: number;
  /** Deprecated for the restrictions' own: the longest stay, in seconds. */
  max_stay?: number;
  supervision_type?: string;
  has_lighting?: boolean;
  is_covered?: boolean;
  orientation?: string;
  side?: string;
  parking_type?: string;
  linear_parking_position?: string | null;
  capacity_min?: number;
  capacity_max?: number;
  related_location?: string;
  lat?: number | string | null;
  lon?: number | string | null;
  official_region_code?: string | null;
  geojson?: { type?: string; coordinates?: unknown };
  capacity?: number;
  realtime_capacity?: number;
  has_realtime_data?: boolean;
  realtime_data_updated_at?: string;
  realtime_free_capacity?: number;
  realtime_opening_status?: string;
  restrictions?: ParkApiRestriction[] | null;
  external_identifiers?: { type?: string; value?: string }[];
  [field: string]: unknown;
}

/**
 * One bay of `/v3/parking-spots`: of the site its `parking_site_id` names, or
 * standing alone. Its live state is a `realtime_status`.
 */
type ParkApiSpot = ParkApiSite & {
  parking_site_id?: number;
  realtime_status?: string | null;
};

/** One entry of `/v3/sources`: the upstream publisher a site came from. */
interface ParkApiSource {
  id?: number;
  uid?: string;
  name?: string;
  attribution_license?: string | null;
  attribution_contributor?: string | null;
  attribution_url?: string | null;
}

/** How a car site is built, from its ParkAPI `type`. */
const LAYOUTS: Readonly<Record<string, ParkingLayout>> = {
  CAR_PARK: "multi_storey",
  UNDERGROUND: "underground",
  OFF_STREET_PARKING_GROUND: "surface",
};

/** `park_and_ride_type` values that make a site a park-and-ride; `CARPOOL` is a usage. */
const PARK_AND_RIDE = new Set(["YES", "TRAIN", "TRAM", "BUS"]);

const STATUSES: Readonly<Record<string, ParkingStatus>> = {
  OPEN: "open",
  CLOSED: "closed",
  UNKNOWN: "unknown",
};

/** A bay's live state: its free count, or that it is not known. */
const SPOT_STATES: Readonly<Record<string, number | "unknown">> = {
  AVAILABLE: 1,
  TAKEN: 0,
  UNKNOWN: "unknown",
};

const PURPOSES: ReadonlySet<string> = new Set(PARKAPI_V3.purposes);
const PARK_AND_RIDE_TYPES: ReadonlySet<string> = new Set(PARKAPI_V3.parkAndRideTypes);

/**
 * The licence a source names, as its SPDX id where the text is one a
 * source is known to write it as, else as written.
 */
function licenseId(text: string): string {
  const t = text.trim();
  if (/^CC[- ]?0\b/i.test(t)) return "CC0-1.0";
  if (/dl-de\/zero-2-0|Datenlizenz Deutschland\s*[–-]\s*Zero/i.test(t)) return "DL-DE-ZERO-2.0";
  if (/dl-de\/by-2-0|Datenlizenz Deutschland\s*[–-]\s*Namensnennung/i.test(t)) {
    return "DL-DE-BY-2.0";
  }
  if (/^(CC[- ]BY[- ]4\.0|Creative Commons Namensnennung\s*-\s*4\.0\b.*)$/i.test(t)) {
    return "CC-BY-4.0";
  }
  return t;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

function coordinate(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number.parseFloat(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** A JSON body's items: `{ items: [...] }` or a bare array. */
function items<T>(body: Buffer): T[] {
  const doc = JSON.parse(body.toString("utf8")) as unknown;
  if (Array.isArray(doc)) return doc as T[];
  const list = (doc as { items?: unknown } | null)?.items;
  if (!Array.isArray(list)) throw new Error("parkapi-v3: body has no items array");
  return list as T[];
}

/** An OpenStreetMap element a site names as itself, as a linking id. */
function osmIds(site: ParkApiSite): ExternalId[] {
  return (site.external_identifiers ?? []).flatMap((e) => {
    if (e.type !== "OSM" || typeof e.value !== "string") return [];
    const [, type, id] = e.value.match(/openstreetmap\.org\/(node|way|relation)\/(\d+)/) ?? [];
    return type && id ? [{ scheme: `osm:${type}`, id }] : [];
  });
}

function restrictionsOf(site: ParkApiSite): ParkApiRestriction[] {
  return Array.isArray(site.restrictions)
    ? site.restrictions.filter((r): r is ParkApiRestriction => typeof r === "object" && r !== null)
    : [];
}

/**
 * Whether a restriction covers the whole site at all hours: no spaces of its
 * own, or all of the site's, and no hours.
 */
const coversSite = (site: ParkApiSite, r: ParkApiRestriction) =>
  (r.capacity === undefined || r.capacity === site.capacity) && text(r.hours) === undefined;

/**
 * Whether the site as a whole is kept for lorries: a `TRUCK` restriction
 * covering it. Toll Collect's motorway lorry parks come so, and so do some
 * city sources'.
 */
function isLorryPark(site: ParkApiSite): boolean {
  return restrictionsOf(site).some((r) => r.type === "TRUCK" && coversSite(site, r));
}

/** Whether the site as a whole is kept for customers: a `CUSTOMER` restriction covering it. */
function isCustomerPark(site: ParkApiSite): boolean {
  return restrictionsOf(site).some((r) => r.type === "CUSTOMER" && coversSite(site, r));
}

const DURATION =
  /^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * The minutes of an ISO 8601 duration. Years and months have no fixed
 * length, so a duration naming them is unreadable, as is one naming nothing.
 */
function durationMinutes(value: unknown): number | undefined {
  const m = typeof value === "string" ? value.trim().match(DURATION) : null;
  if (!m || m.slice(1).every((part) => part === undefined) || m[0].endsWith("T")) return undefined;
  const [weeks, days, hours, minutes, seconds] = m.slice(1).map((part) => Number(part ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
  ];
  return ((weeks * 7 + days) * 24 + hours) * 60 + minutes + seconds / 60;
}

/** A restriction's `max_stay`, when it is a readable stay of more than nothing. */
function stayOf(r: ParkApiRestriction): Quantity | undefined {
  const minutes = durationMinutes(r.max_stay);
  return minutes !== undefined && minutes > 0 ? { value: minutes, unit: "min" } : undefined;
}

/**
 * The longest a vehicle may stay at the site: the longest `max_stay` of the
 * restrictions on every audience that cover the whole site at all hours
 * (alternatives, so the longest of them is allowed), else the site's
 * deprecated `max_stay` in seconds. A limit for one audience, or for some
 * hours or spaces only, is its area's.
 */
function maxStayOf(site: ParkApiSite): Quantity | undefined {
  const limits = restrictionsOf(site)
    .filter((r) => r.type === undefined && coversSite(site, r))
    .map((r) => stayOf(r)?.value)
    .filter((minutes): minutes is number => minutes !== undefined);
  if (limits.length > 0) return { value: Math.max(...limits), unit: "min" };
  const seconds = site.max_stay;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? { value: seconds / 60, unit: "min" }
    : undefined;
}

/** An area a restriction stands for, with the restriction it came from. */
type RestrictionArea = AreaInput & { restriction: ParkApiRestriction };

/**
 * The areas of a site's restrictions, each with its hours and maximum stay:
 * one per audience, the first of a repeated one winning. A restriction of
 * every audience is the area of the site's own vehicles where it keeps spaces
 * of its own or holds at some hours only; covering the whole site at all
 * hours it limits the site's stay instead. A restriction that counts no
 * spaces is no area; one that counts none of its own says only that the site
 * has such spaces, except a lorry park's, which has all of them. A
 * customers' car park has no customers' area: the site is theirs.
 */
function areasOf(site: ParkApiSite, lorryPark: boolean, customers: boolean): RestrictionArea[] {
  const vehicleType = (entryOf(PARKAPI_VEHICLE_TYPES, site.purpose ?? "CAR") ??
    "car") as ParkingVehicleType;
  const seen = new Set<string>();
  return restrictionsOf(site).flatMap((restriction) => {
    const { type } = restriction;
    if (type === undefined && coversSite(site, restriction)) return [];
    if (type === "CUSTOMER" && customers && coversSite(site, restriction)) return [];
    const target =
      type === undefined
        ? { userGroup: "any" }
        : Object.hasOwn(PARKAPI_RESTRICTION_AREAS, type)
          ? PARKAPI_RESTRICTION_AREAS[type]
          : undefined;
    if (!target) return [];
    const capacity =
      restriction.capacity ?? (lorryPark && type === "TRUCK" ? site.capacity : undefined);
    if (capacity === 0) return [];
    const area = {
      vehicleType: ((target as { vehicleType?: string }).vehicleType ??
        vehicleType) as ParkingVehicleType,
      userGroup: target.userGroup as ParkingUserGroup,
    };
    if (seen.has(areaKey(area))) return [];
    seen.add(areaKey(area));
    const hoursOsm = text(restriction.hours);
    const maxStay = stayOf(restriction);
    return [
      {
        ...area,
        ...(validCount(capacity) ? { capacity } : {}),
        ...(hoursOsm === undefined ? {} : { hoursOsm }),
        ...(maxStay === undefined ? {} : { maxStay }),
        restriction,
      },
    ];
  });
}

const parkAndRideTypes = (site: ParkApiSite): string[] =>
  Array.isArray(site.park_and_ride_type) ? site.park_and_ride_type : [];

/** What the site's structure `type` classifies it as, for its purpose. */
const structureType = (site: ParkApiSite): ParkingSiteType | undefined =>
  parkingCrosswalk.feature("parkapi", `purpose:${site.purpose ?? "CAR"}|type:${site.type ?? ""}`)
    ?.type as ParkingSiteType | undefined;

function typeOf(site: ParkApiSite, truck: boolean): ParkingSiteType | undefined {
  if (truck) return "truck_parking";
  if (parkAndRideTypes(site).some((t) => PARK_AND_RIDE.has(t))) return "park_and_ride";
  return structureType(site);
}

/** A value's meaning in a table, when the table has it. */
const lookup = (table: Readonly<Record<string, string | null>>, value: unknown) =>
  typeof value === "string" && Object.hasOwn(table, value)
    ? (table[value] ?? undefined)
    : undefined;

/** Whether a field is set to a value its table does not hold. */
const unread = (table: Readonly<Record<string, string | null>>, value: unknown) =>
  value !== undefined && value !== null && lookup(table, value) === undefined;

const EXTERNAL_ID_TYPES: ReadonlySet<string> = new Set(PARKAPI_V3.externalIdentifierTypes);

/**
 * How many enumerated values of a kept site go unread: a structure `type`
 * the crosswalk gives no classification (`OTHER`, or bicycle furniture on a
 * car site), a `park_and_ride_type`, `supervision_type`, bay layout,
 * identifier type or restriction audience ParkAPI does not define.
 */
function unreadValues(site: ParkApiSite): number {
  const supervision = site.supervision_type;
  return [
    site.type !== undefined && structureType(site) === undefined,
    ...parkAndRideTypes(site).map((t) => !PARK_AND_RIDE_TYPES.has(t)),
    supervision !== undefined &&
      supervision !== "VIDEO" &&
      unread(PARKAPI_SUPERVISION, supervision),
    unread(PARKAPI_ORIENTATIONS, site.orientation),
    unread(PARKAPI_SIDES, site.side),
    unread(PARKAPI_KERB_POSITIONS, site.parking_type),
    unread(PARKAPI_LINE_POSITIONS, site.linear_parking_position),
    ...(site.external_identifiers ?? []).map((e) => !EXTERNAL_ID_TYPES.has(e.type ?? "")),
    ...restrictionsOf(site).map(
      (r) => r.type !== undefined && !Object.hasOwn(PARKAPI_RESTRICTION_AREAS, r.type),
    ),
  ].filter(Boolean).length;
}

/** The stops a site names by their DHID, the German form of an IFOPT id. */
function stopsOf(site: ParkApiSite): ExternalId[] {
  return (site.external_identifiers ?? []).flatMap((e) =>
    e.type === "DHID" && typeof e.value === "string" && e.value.trim() !== ""
      ? [{ scheme: "ifopt", id: e.value.trim() }]
      : [],
  );
}

/** A web address the licensing record can hold: http(s) only. */
function webUrl(value: unknown): string | undefined {
  const url = text(value);
  if (url === undefined || !URL.canParse(url)) return undefined;
  return ["http:", "https:"].includes(new URL(url).protocol) ? url : undefined;
}

/**
 * The upstream source's credit: its publisher, the site's id there and its
 * licence, with the licence's own page where the source links one.
 */
function upstreamOf(
  feed: ParkingCatalogFeed,
  site: ParkApiSite,
  source: ParkApiSource | undefined,
): SiteInput["upstream"] {
  const publisher = text(source?.attribution_contributor) ?? text(source?.name);
  if (publisher === undefined) return undefined;
  const written = text(source?.attribution_license);
  const license = written === undefined ? undefined : licenseId(written);
  const licenseUrl = webUrl(source?.attribution_url);
  const recordId = text(site.original_uid);
  return [
    {
      publisher,
      ...(recordId === undefined ? {} : { recordId }),
      ...(license === undefined ? {} : { license }),
      ...(licenseUrl === undefined
        ? {}
        : {
            licensing: captureLicensing({
              id: feed.id,
              name: publisher,
              license: license ?? "NOASSERTION",
              licenseUrl,
            }),
          }),
    },
  ];
}

function siteInput(
  feed: ParkingCatalogFeed,
  site: ParkApiSite,
  stationId: string,
  point: [number, number],
  source: ParkApiSource | undefined,
  truck: boolean,
  customers: boolean,
  areas: readonly RestrictionArea[],
): SiteInput {
  const sourceUid = source?.uid ?? text(site.source_uid);
  const type = typeOf(site, truck);
  const built = entryOf(LAYOUTS, site.type);
  // A roofed lot or kerbside stretch; a garage is covered already.
  const layout = site.is_covered === true && (built ?? "surface") === "surface" ? "covered" : built;
  const supervision =
    site.supervision_type !== undefined && Object.hasOwn(PARKAPI_SUPERVISION, site.supervision_type)
      ? (PARKAPI_SUPERVISION[site.supervision_type] ?? undefined)
      : undefined;
  const securityFeatures = [
    ...(site.supervision_type === "VIDEO" ? ["cctv"] : []),
    ...(site.has_lighting === true ? ["lighting"] : []),
  ];
  const upstream = upstreamOf(feed, site, source);
  const address = text(site.address);
  const photo = text(site.photo_url);
  const region = text(site.official_region_code);
  const bays = {
    orientation: lookup(PARKAPI_ORIENTATIONS, site.orientation),
    position: lookup(PARKAPI_KERB_POSITIONS, site.parking_type),
    side: lookup(PARKAPI_SIDES, site.side),
  } as NonNullable<SiteInput["bays"]>;
  const line = lookup(PARKAPI_LINE_POSITIONS, site.linear_parking_position) as
    | "road_centre"
    | "bays_centre"
    | undefined;
  const count = (value: unknown) => (typeof value === "number" ? value : undefined);
  const metres = (centimetres: unknown) => {
    const cm = count(centimetres);
    return cm !== undefined && cm > 0 ? cm / 100 : undefined;
  };
  const usage = [
    ...(truck ? ["truck"] : []),
    ...(type === "park_and_ride" ? ["park_and_ride"] : []),
    ...(parkAndRideTypes(site).includes("CARPOOL") ? ["carpool"] : []),
    ...(customers ? ["customer"] : []),
  ];
  const optional = <K extends keyof SiteInput>(key: K, value: SiteInput[K] | undefined) =>
    value === undefined ? {} : { [key]: value };
  return {
    stationId,
    point,
    lang: "de",
    providerAuthority: sourceUid === undefined ? feed.id : `${feed.id}/${sourceUid}`,
    externalIds: osmIds(site),
    ...optional("name", text(site.name)),
    ...optional("type", type),
    ...optional("layout", layout),
    ...optional("operator", text(site.operator_name)),
    ...optional("website", text(site.public_url)),
    ...optional("images", photo === undefined ? undefined : [{ url: photo, category: "site" }]),
    ...optional("address", address === undefined ? undefined : { text: address }),
    ...optional("areaDescription", text(site.related_location)),
    // The German official regional key (Amtlicher Regionalschlüssel), twelve digits.
    ...optional(
      "geocodes",
      region !== undefined && /^\d{12}$/.test(region)
        ? [{ scheme: "ars", code: region }]
        : undefined,
    ),
    ...optional("openingHoursOsm", text(site.opening_hours)),
    ...optional("tariffText", text(site.fee_description)),
    ...optional("notes", text(site.description)),
    ...optional("audience", customers ? "customers" : undefined),
    ...optional("supervision", supervision as SiteInput["supervision"] | undefined),
    ...(securityFeatures.length === 0 ? {} : { securityFeatures }),
    ...(site.has_fee === false ? { free: true } : {}),
    ...optional("capacityTotal", count(site.capacity)),
    capacityRange: { min: count(site.capacity_min), max: count(site.capacity_max) },
    // ParkAPI gives both limits in centimetres.
    ...optional("heightLimitM", metres(site.max_height)),
    ...optional("widthLimitM", metres(site.max_width)),
    ...optional("maxStay", maxStayOf(site)),
    bays,
    ...optional(
      "outline",
      site.geojson === undefined
        ? undefined
        : { geometry: site.geojson, ...(line ? { line } : {}) },
    ),
    stops: stopsOf(site),
    areas: areas.map(({ restriction: _, ...area }) => area),
    usage,
    ...optional("upstream", upstream),
  };
}

function readingsOf(
  feed: ParkingCatalogFeed,
  site: ParkApiSite,
  stationId: string,
  point: [number, number],
  ctx: ParseContext,
  upstream: SiteInput["upstream"],
  areas: readonly RestrictionArea[],
): RecordDraft[] {
  if (site.has_realtime_data === false) return [];
  const updated = site.realtime_data_updated_at;
  if (updated === undefined || !Number.isFinite(Date.parse(updated))) return [];
  const reading: ReadingInput = {
    stationId,
    at: utcInstant(new Date(updated)),
    point,
    ...(upstream === undefined ? {} : { upstream }),
  };
  const out: (RecordDraft | undefined)[] = occupancyDrafts(
    feed,
    reading,
    {
      ...(typeof site.realtime_free_capacity === "number"
        ? { available: site.realtime_free_capacity }
        : {}),
      // The live capacity bounds the live free count; the static one when there is none.
      ...(typeof (site.realtime_capacity ?? site.capacity) === "number"
        ? { capacity: (site.realtime_capacity ?? site.capacity) as number }
        : {}),
    },
    ctx,
  );
  // An area's live free count is bounded by its own live capacity, else its static one.
  for (const { vehicleType, userGroup, restriction } of areas) {
    if (typeof restriction.realtime_free_capacity !== "number") continue;
    const capacity = restriction.realtime_capacity ?? restriction.capacity;
    out.push(
      ...occupancyDrafts(
        feed,
        { ...reading, area: { vehicleType, userGroup } },
        {
          available: restriction.realtime_free_capacity,
          ...(typeof capacity === "number" ? { capacity } : {}),
        },
        ctx,
      ),
    );
  }
  const opening = site.realtime_opening_status;
  if (typeof opening === "string") {
    const status = Object.hasOwn(STATUSES, opening) ? STATUSES[opening] : undefined;
    if (status === undefined) recordSkipped(feed.id, "unknown_value");
    else out.push(statusDraft(feed, { ...reading, status }, ctx));
  }
  return out.filter((d): d is RecordDraft => d !== undefined);
}

/** A record's id as text, when it has one. */
const idOf = (value: unknown) =>
  typeof value === "number" || typeof value === "string" ? text(String(value)) : undefined;

/** A record's `[lon, lat]`, when it has a placeable one. */
function pointOf(record: { lat?: unknown; lon?: unknown }): [number, number] | undefined {
  const lon = coordinate(record.lon);
  const lat = coordinate(record.lat);
  return lon === undefined || lat === undefined ? undefined : [lon, lat];
}

/** A placed car bay of the spots payload. */
interface PlacedSpot {
  spot: ParkApiSpot;
  id: string;
  point: [number, number];
}

/**
 * The car bays of the spots payload. A bay that is no object or has no id is
 * malformed, one without a placeable point has no geometry, and one of a
 * purpose ParkAPI does not define is of an unknown type; bays for bicycles,
 * motorcycles and items are left out by design, as their sites are.
 */
function spotsOf(feed: ParkingCatalogFeed, payloads: FeedPayloads): PlacedSpot[] {
  return (payloads["spots"] ?? []).flatMap((body) =>
    items<unknown>(body).flatMap((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        recordSkipped(feed.id, "malformed");
        return [];
      }
      const spot = item as ParkApiSpot;
      const purpose = spot.purpose ?? "CAR";
      if (purpose !== "CAR") {
        if (!PURPOSES.has(purpose)) recordSkipped(feed.id, "unknown_type");
        return [];
      }
      const id = idOf(spot.id);
      if (id === undefined) {
        recordSkipped(feed.id, "malformed");
        return [];
      }
      const point = pointOf(spot);
      if (point === undefined) {
        recordSkipped(feed.id, "no_geometry");
        return [];
      }
      return [{ spot, id, point }];
    }),
  );
}

/** The component key of a site's bay. */
const spaceKey = (id: string) => `spot:${id}`;

/** Whether a bay's live state is unread: published, but not one ParkAPI defines. */
const unreadState = (spot: ParkApiSpot) =>
  typeof spot.realtime_status === "string" && !Object.hasOwn(SPOT_STATES, spot.realtime_status);

/** The live state of a site's bay, as a free count of one or none, or an unknown status. */
function spaceReadings(
  feed: ParkingCatalogFeed,
  { spot, id, point }: PlacedSpot,
  stationId: string,
  ctx: ParseContext,
  upstream: SiteInput["upstream"],
): RecordDraft[] {
  const state = spot.realtime_status;
  const updated = spot.realtime_data_updated_at;
  if (spot.has_realtime_data === false || typeof state !== "string") return [];
  if (updated === undefined || !Number.isFinite(Date.parse(updated))) return [];
  const meaning = Object.hasOwn(SPOT_STATES, state) ? SPOT_STATES[state] : undefined;
  if (meaning === undefined) return [];
  const reading: ReadingInput = {
    stationId,
    spaceKey: spaceKey(id),
    at: utcInstant(new Date(updated)),
    point,
    ...(upstream === undefined ? {} : { upstream }),
  };
  const draft =
    meaning === "unknown"
      ? statusDraft(feed, { ...reading, status: "unknown" }, ctx)
      : occupancyDrafts(feed, reading, { available: meaning, capacity: 1 }, ctx)[0];
  return draft === undefined ? [] : [draft];
}

/**
 * A bay that stands alone, as a site of one space: its restrictions, outline,
 * region and stops are read as a site's, its live state as the site's free
 * count, or as an unknown status.
 */
function spotAsSite({ spot }: PlacedSpot): ParkApiSite {
  const meaning =
    typeof spot.realtime_status === "string" && Object.hasOwn(SPOT_STATES, spot.realtime_status)
      ? SPOT_STATES[spot.realtime_status]
      : undefined;
  return {
    ...spot,
    id: undefined,
    capacity: 1,
    ...(typeof meaning === "number" ? { realtime_free_capacity: meaning } : {}),
    ...(meaning === "unknown" ? { realtime_opening_status: "UNKNOWN" } : {}),
  };
}

/**
 * ParkAPI v3 (MobiData BW): the `main` payload lists the parking sites, the
 * `sources` payload the upstream publishers they came from; a poll without
 * the sources is refused. Car sites and sites without a purpose are kept.
 * Each site credits its upstream source, which also qualifies its provider
 * id, so sites of two upstream sources may still link. A site restricted to
 * lorries as a whole is a lorry park, and one restricted to customers as a
 * whole a customers' car park; a restriction of the site's other audiences
 * is an area of it, with its hours, its maximum stay and the area's own live
 * free count where it has them. A live free count is bounded by the live
 * capacity, else the static one. A site's outline, bay layout, estimated
 * capacity range, photo, regional key and the stops it serves are read too.
 *
 * The optional `spots` payload lists single bays: a bay of a kept site is a
 * `parking_space` of it, with its live state as a free count of one or none;
 * a bay of no kept site is a site of one space, `spot/<id>`.
 *
 * A site that is no object or has no id is malformed, one without a placeable
 * point has no geometry, and one of a purpose ParkAPI does not define is of
 * an unknown type; each is skipped under that reason. Bicycle, motorcycle and
 * locker sites are left out by design. An enumerated value of a kept site
 * that is published without is counted as unknown.
 */
export function parseParkApiV3(
  feed: ParkingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const sources = payloads["sources"] ?? [];
  // Without the source list every site goes uncredited under the bare feed authority.
  if (sources.length === 0 && (payloads["main"] ?? []).length > 0) {
    throw new Error("parkapi-v3: sites without a sources payload");
  }
  const byId = new Map<number, ParkApiSource>();
  const byUid = new Map<string, ParkApiSource>();
  for (const body of sources) {
    for (const source of items<ParkApiSource>(body)) {
      if (typeof source.id === "number") byId.set(source.id, source);
      if (typeof source.uid === "string") byUid.set(source.uid, source);
    }
  }
  const spots = spotsOf(feed, payloads);
  const spotsOfSite = new Map<string, PlacedSpot[]>();
  for (const placed of spots) {
    const site = idOf(placed.spot.parking_site_id);
    if (site !== undefined) spotsOfSite.set(site, [...(spotsOfSite.get(site) ?? []), placed]);
  }
  const sourceOf = (record: { source_id?: number; source_uid?: string }) =>
    (record.source_id === undefined ? undefined : byId.get(record.source_id)) ??
    (record.source_uid === undefined ? undefined : byUid.get(record.source_uid));
  /** Publishes a site and its readings, with the bays it holds. */
  const publish = (
    site: ParkApiSite,
    stationId: string,
    point: [number, number],
    bays: readonly PlacedSpot[],
  ) => {
    const source = sourceOf(site);
    const truck = isLorryPark(site);
    const customers = isCustomerPark(site);
    const areas = areasOf(site, truck, customers);
    const input = siteInput(feed, site, stationId, point, source, truck, customers, areas);
    const vehicleType = (entryOf(PARKAPI_VEHICLE_TYPES, site.purpose ?? "CAR") ??
      "car") as ParkingVehicleType;
    input.spaces = bays.map(({ spot, id, point: at }) => {
      const restriction = restrictionsOf(spot).find(
        (r) => r.type !== undefined && Object.hasOwn(PARKAPI_RESTRICTION_AREAS, r.type),
      );
      const target =
        restriction?.type === undefined ? undefined : PARKAPI_RESTRICTION_AREAS[restriction.type];
      const name = text(spot.name);
      return {
        key: spaceKey(id),
        point: at,
        ...(name === undefined ? {} : { name }),
        vehicleType: (target?.vehicleType ?? vehicleType) as ParkingVehicleType,
        ...(target ? { userGroup: target.userGroup as ParkingUserGroup } : {}),
      };
    });
    recordSkipped(
      feed.id,
      "unknown_value",
      unreadValues(site) +
        bays.reduce((n, { spot }) => n + unreadValues(spot) + Number(unreadState(spot)), 0),
    );
    out.features.push(siteDraft(feed, input, ctx.fetchedAt));
    out.observations.push(
      ...readingsOf(feed, site, stationId, point, ctx, input.upstream, areas),
      ...bays.flatMap((bay) => spaceReadings(feed, bay, stationId, ctx, input.upstream)),
    );
  };
  const kept = new Set<string>();
  for (const body of payloads["main"] ?? []) {
    for (const item of items<unknown>(body)) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      const site = item as ParkApiSite;
      const purpose = site.purpose ?? "CAR";
      if (purpose !== "CAR") {
        if (!PURPOSES.has(purpose)) recordSkipped(feed.id, "unknown_type");
        continue;
      }
      const stationId = idOf(site.id);
      if (stationId === undefined) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      const point = pointOf(site);
      if (point === undefined) {
        recordSkipped(feed.id, "no_geometry");
        continue;
      }
      kept.add(stationId);
      publish(site, stationId, point, spotsOfSite.get(stationId) ?? []);
    }
  }
  // A bay of no site the feed keeps is a site of its own, under an id of its own kind.
  for (const placed of spots) {
    const site = idOf(placed.spot.parking_site_id);
    if (site !== undefined && kept.has(site)) continue;
    publish(spotAsSite(placed), `spot/${placed.id}`, placed.point, []);
    if (unreadState(placed.spot)) recordSkipped(feed.id, "unknown_value");
  }
  return out;
}
