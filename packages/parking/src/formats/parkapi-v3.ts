import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { ExternalId, Quantity } from "@openconditions/model";
import {
  PARKAPI_RESTRICTION_AREAS,
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
 * the part of it its own `capacity` counts, is kept for. Without a type it
 * restricts every audience.
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
  /** Deprecated for the restrictions' own: the longest stay, in seconds. */
  max_stay?: number;
  supervision_type?: string;
  has_lighting?: boolean;
  is_covered?: boolean;
  lat?: number | string | null;
  lon?: number | string | null;
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

/** One entry of `/v3/sources`: the upstream publisher a site came from. */
interface ParkApiSource {
  id?: number;
  uid?: string;
  name?: string;
  attribution_license?: string | null;
  attribution_contributor?: string | null;
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

/** Whether a restriction covers the whole site: no spaces of its own, or all of the site's. */
const coversSite = (site: ParkApiSite, r: ParkApiRestriction) =>
  r.capacity === undefined || r.capacity === site.capacity;

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

/**
 * The longest a vehicle may stay at the site: the longest `max_stay` of the
 * restrictions on every audience at all hours (alternatives, so the longest
 * of them is allowed), else the site's deprecated `max_stay` in seconds. A
 * restriction's limit for one audience or for some hours only is left out:
 * the site's single maximum stay would state it for everyone at all times.
 */
function maxStayOf(site: ParkApiSite): Quantity | undefined {
  const limits = restrictionsOf(site)
    .filter((r) => r.type === undefined && text(r.hours) === undefined)
    .map((r) => durationMinutes(r.max_stay))
    .filter((minutes): minutes is number => minutes !== undefined && minutes > 0);
  if (limits.length > 0) return { value: Math.max(...limits), unit: "min" };
  const seconds = site.max_stay;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? { value: seconds / 60, unit: "min" }
    : undefined;
}

/** An area a restriction stands for, with the restriction it came from. */
type RestrictionArea = AreaInput & { restriction: ParkApiRestriction };

/**
 * The areas of a site's restrictions: one per audience that names a user
 * group or vehicle type, the first of a repeated one winning. A restriction
 * that counts no spaces is no area; one that counts none of its own says only
 * that the site has such spaces, except a lorry park's, which has all of them.
 */
function areasOf(site: ParkApiSite, lorryPark: boolean): RestrictionArea[] {
  const vehicleType = (PARKAPI_VEHICLE_TYPES[site.purpose ?? "CAR"] ?? "car") as ParkingVehicleType;
  const seen = new Set<string>();
  return restrictionsOf(site).flatMap((restriction) => {
    const target =
      restriction.type === undefined ? undefined : PARKAPI_RESTRICTION_AREAS[restriction.type];
    if (!target) return [];
    const capacity =
      restriction.capacity ??
      (lorryPark && restriction.type === "TRUCK" ? site.capacity : undefined);
    if (capacity === 0) return [];
    const area = {
      vehicleType: (target.vehicleType ?? vehicleType) as ParkingVehicleType,
      userGroup: target.userGroup as ParkingUserGroup,
    };
    if (seen.has(areaKey(area))) return [];
    seen.add(areaKey(area));
    return [{ ...area, ...(validCount(capacity) ? { capacity } : {}), restriction }];
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

/**
 * How many enumerated values of a kept site go unread: a structure `type`
 * the crosswalk gives no classification (`OTHER`, or bicycle furniture on a
 * car site), a `park_and_ride_type` or `supervision_type` it does not map,
 * an identifier other than an OpenStreetMap one, and a restriction audience
 * that is no area and not the whole site's customers.
 */
function unreadValues(site: ParkApiSite, customers: boolean): number {
  const supervision = site.supervision_type;
  return [
    site.type !== undefined && structureType(site) === undefined,
    ...parkAndRideTypes(site).map((t) => !PARK_AND_RIDE_TYPES.has(t)),
    supervision !== undefined &&
      supervision !== "VIDEO" &&
      !(Object.hasOwn(PARKAPI_SUPERVISION, supervision) && PARKAPI_SUPERVISION[supervision]),
    ...(site.external_identifiers ?? []).map((e) => e.type !== "OSM"),
    ...restrictionsOf(site).map(
      (r) =>
        r.type !== undefined &&
        !PARKAPI_RESTRICTION_AREAS[r.type] &&
        !(r.type === "CUSTOMER" && customers),
    ),
  ].filter(Boolean).length;
}

function siteInput(
  feed: ParkingCatalogFeed,
  site: ParkApiSite,
  stationId: string,
  point: [number, number],
  source: ParkApiSource | undefined,
  truck: boolean,
  areas: readonly RestrictionArea[],
): SiteInput {
  const sourceUid = source?.uid ?? text(site.source_uid);
  const type = typeOf(site, truck);
  const customers = isCustomerPark(site);
  const built = site.type === undefined ? undefined : LAYOUTS[site.type];
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
  const publisher = text(source?.attribution_contributor) ?? text(source?.name);
  const license = text(source?.attribution_license);
  const recordId = text(site.original_uid);
  const address = text(site.address);
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
    ...optional("address", address === undefined ? undefined : { text: address }),
    ...optional("openingHoursOsm", text(site.opening_hours)),
    ...optional("tariffText", text(site.fee_description)),
    ...optional("notes", text(site.description)),
    ...optional("audience", customers ? "customers" : undefined),
    ...optional("supervision", supervision as SiteInput["supervision"] | undefined),
    ...(securityFeatures.length === 0 ? {} : { securityFeatures }),
    ...(site.has_fee === false ? { free: true } : {}),
    ...optional("capacityTotal", typeof site.capacity === "number" ? site.capacity : undefined),
    ...optional(
      "heightLimitM",
      typeof site.max_height === "number" && site.max_height > 0
        ? site.max_height / 100
        : undefined,
    ),
    areas: areas.map(({ restriction: _, ...area }) => area),
    usage,
    ...(publisher === undefined
      ? {}
      : {
          upstream: [
            {
              publisher,
              ...(recordId === undefined ? {} : { recordId }),
              ...(license === undefined ? {} : { license: licenseId(license) }),
            },
          ],
        }),
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

/**
 * ParkAPI v3 (MobiData BW): the `main` payload lists the parking sites, the
 * `sources` payload the upstream publishers they came from; a poll without
 * the sources is refused. Car sites and sites without a purpose are kept.
 * Each site credits its upstream source, which also qualifies its provider
 * id, so sites of two upstream sources may still link. A site restricted to
 * lorries as a whole is a lorry park, and one restricted to customers as a
 * whole a customers' car park; a restriction of the site's other audiences
 * is an area of it, with the area's own live free count where it has one. A
 * live free count is bounded by the live capacity, else the static one.
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
      const stationId =
        typeof site.id === "number" || typeof site.id === "string"
          ? text(String(site.id))
          : undefined;
      if (stationId === undefined) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      const lon = coordinate(site.lon);
      const lat = coordinate(site.lat);
      if (lon === undefined || lat === undefined) {
        recordSkipped(feed.id, "no_geometry");
        continue;
      }
      const point: [number, number] = [lon, lat];
      const source =
        (site.source_id === undefined ? undefined : byId.get(site.source_id)) ??
        (site.source_uid === undefined ? undefined : byUid.get(site.source_uid));
      const truck = isLorryPark(site);
      const areas = areasOf(site, truck);
      const input = siteInput(feed, site, stationId, point, source, truck, areas);
      recordSkipped(feed.id, "unknown_value", unreadValues(site, isCustomerPark(site)));
      const draft = siteDraft(feed, input, ctx.fetchedAt);
      // `siteDraft` takes no maximum stay, which the site's details can hold.
      const maxStay = maxStayOf(site);
      if (maxStay !== undefined) (draft["details"] as Record<string, unknown>)["maxStay"] = maxStay;
      out.features.push(draft);
      out.observations.push(
        ...readingsOf(feed, site, stationId, point, ctx, input.upstream, areas),
      );
    }
  }
  return out;
}
