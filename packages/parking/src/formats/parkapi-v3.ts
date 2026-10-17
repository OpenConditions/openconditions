import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import type { ExternalId } from "@openconditions/model";
import {
  PARKAPI_RESTRICTION_AREAS,
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
 * Whether the site as a whole is kept for lorries: a `TRUCK` restriction
 * without spaces of its own, or with all of the site's. Toll Collect's
 * motorway lorry parks come so, and so do some city sources'.
 */
function isLorryPark(site: ParkApiSite): boolean {
  return restrictionsOf(site).some(
    (r) => r.type === "TRUCK" && (r.capacity === undefined || r.capacity === site.capacity),
  );
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

function typeOf(site: ParkApiSite, truck: boolean): ParkingSiteType | undefined {
  if (truck) return "truck_parking";
  if ((site.park_and_ride_type ?? []).some((t) => PARK_AND_RIDE.has(t))) return "park_and_ride";
  const code = `purpose:${site.purpose ?? "CAR"}|type:${site.type ?? ""}`;
  return parkingCrosswalk.feature("parkapi", code)?.type as ParkingSiteType | undefined;
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
  const layout = site.type === undefined ? undefined : LAYOUTS[site.type];
  const publisher = text(source?.attribution_contributor) ?? text(source?.name);
  const license = text(source?.attribution_license);
  const recordId = text(site.original_uid);
  const address = text(site.address);
  const usage = [
    ...(truck ? ["truck"] : []),
    ...(type === "park_and_ride" ? ["park_and_ride"] : []),
    ...((site.park_and_ride_type ?? []).includes("CARPOOL") ? ["carpool"] : []),
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
  const status =
    site.realtime_opening_status === undefined ? undefined : STATUSES[site.realtime_opening_status];
  if (status !== undefined) out.push(statusDraft(feed, { ...reading, status }, ctx));
  return out.filter((d): d is RecordDraft => d !== undefined);
}

/**
 * ParkAPI v3 (MobiData BW): the `main` payload lists the parking sites, the
 * `sources` payload the upstream publishers they came from; a poll without
 * the sources is refused. Car sites and sites without a purpose are kept.
 * Each site credits its upstream source, which also qualifies its provider
 * id, so sites of two upstream sources may still link. A site restricted to
 * lorries as a whole is a lorry park; a restriction of the site's other
 * audiences is an area of it, with the area's own live free count where it
 * has one. A live free count is bounded by the live capacity, else the static
 * one. A site without a placeable point is rejected.
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
  let rejected = 0;
  for (const body of payloads["main"] ?? []) {
    for (const site of items<ParkApiSite>(body)) {
      if (site.purpose !== undefined && site.purpose !== null && site.purpose !== "CAR") continue;
      const lon = coordinate(site.lon);
      const lat = coordinate(site.lat);
      const stationId = site.id === undefined ? undefined : String(site.id);
      if (stationId === undefined || lon === undefined || lat === undefined) {
        rejected++;
        continue;
      }
      const point: [number, number] = [lon, lat];
      const source =
        (site.source_id === undefined ? undefined : byId.get(site.source_id)) ??
        (site.source_uid === undefined ? undefined : byUid.get(site.source_uid));
      const truck = isLorryPark(site);
      const areas = areasOf(site, truck);
      const input = siteInput(feed, site, stationId, point, source, truck, areas);
      out.features.push(siteDraft(feed, input, ctx.fetchedAt));
      out.observations.push(
        ...readingsOf(feed, site, stationId, point, ctx, input.upstream, areas),
      );
    }
  }
  out.rejected = rejected;
  return out;
}
