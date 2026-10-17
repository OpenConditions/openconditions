import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { Quantity } from "@openconditions/model";
import type { ParkingLayout } from "@openconditions/model-parking";
import type { ParkingCatalogFeed } from "../feed-schema.js";
import { type AreaInput, type RateRow, rateDraft, type SiteInput, siteDraft } from "../site.js";

/** One facility of DB BahnPark's Parking Information API v2, as far as it is read. */
interface BahnparkFacility {
  id?: string | number;
  name?: { name?: string; context?: string }[];
  url?: string;
  type?: { name?: string };
  operator?: { name?: string };
  address?: {
    streetAndNumber?: string;
    zip?: string;
    city?: string;
    location?: { latitude?: number | null; longitude?: number | null } | null;
  };
  capacity?: { type?: string; total?: string | number }[];
  access?: {
    outOfService?: { isOutOfService?: boolean };
    openingHours?: { is24h?: boolean; text?: string };
    restrictions?: { clearance?: { height?: string | number | null } };
  };
  equipment?: { charging?: { hasChargingStation?: boolean } };
  tariff?: {
    prices?: { group?: { groupName?: string }; duration?: string; price?: number | null }[];
  };
}

const LAYOUTS: Readonly<Record<string, ParkingLayout>> = {
  Parkhaus: "multi_storey",
  Tiefgarage: "underground",
  Parkplatz: "surface",
};

const PARK_AND_RIDE = "P+R-Anlage";

/** The price group that is the public tariff. */
const STANDARD = "standard";

const duration = (value: number, unit: string): Quantity => ({ value, unit });

/** Each duration code of a price: how long it buys, and for whom when not for everyone. */
const DURATIONS: Readonly<Record<string, Omit<RateRow, "amount">>> = {
  "20min": { maxDuration: duration(20, "min") },
  "30min": { maxDuration: duration(30, "min") },
  "1hour": { maxDuration: duration(1, "h") },
  "1day": { maxDuration: duration(1, "d") },
  "1dayPCard": { maxDuration: duration(1, "d"), userGroups: ["p_card"] },
  "1week": { maxDuration: duration(1, "wk") },
  "1weekPCard": { maxDuration: duration(1, "wk"), userGroups: ["p_card"] },
  "1monthVendingMachine": { maxDuration: duration(1, "mo") },
  "1monthLongTerm": { maxDuration: duration(1, "mo"), userGroups: ["long_term"] },
  "1monthReservation": { maxDuration: duration(1, "mo"), userGroups: ["reservation"] },
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A whole number written as a number or a string. */
function integer(value: unknown): number | undefined {
  const t = typeof value === "number" ? String(value) : text(value);
  return t !== undefined && /^\d+$/.test(t) ? Number(t) : undefined;
}

type Placed =
  | { stationId: string; point: [number, number] }
  | { skip: "malformed" | "no_geometry" };

/**
 * A facility's id and point, or why it gives no site: `malformed` without an
 * id or with a coordinate that is no number, `no_geometry` without one.
 */
function placed(f: BahnparkFacility): Placed {
  if (typeof f !== "object" || f === null) return { skip: "malformed" };
  const stationId = f.id === undefined || f.id === null ? undefined : text(String(f.id));
  if (stationId === undefined) return { skip: "malformed" };
  const lat = f.address?.location?.latitude;
  const lon = f.address?.location?.longitude;
  if (lat === undefined || lat === null || lon === undefined || lon === null) {
    return { skip: "no_geometry" };
  }
  return finite(lat) && finite(lon) ? { stationId, point: [lon, lat] } : { skip: "malformed" };
}

/** The facilities of a body: a bare array, or a HAL envelope with `_embedded` as the array. */
function facilitiesOf(body: Buffer): BahnparkFacility[] {
  const doc = JSON.parse(body.toString("utf8")) as unknown;
  if (Array.isArray(doc)) return doc as BahnparkFacility[];
  const embedded = (doc as { _embedded?: unknown } | null)?._embedded;
  if (!Array.isArray(embedded)) throw new Error("db-bahnpark: body has no facility array");
  return embedded as BahnparkFacility[];
}

function nameOf(f: BahnparkFacility): string | undefined {
  const byContext = (context: string) => text(f.name?.find((n) => n.context === context)?.name);
  return byContext("DISPLAY") ?? byContext("NAME");
}

/** A capacity of the given type above zero; the first of a repeated type wins. */
const capacityOf = (f: BahnparkFacility, type: string) => {
  const n = integer(f.capacity?.find((c) => c.type === type)?.total);
  return n !== undefined && n > 0 ? n : undefined;
};

function siteInput(f: BahnparkFacility, stationId: string, point: [number, number]): SiteInput {
  const typeName = text(f.type?.name);
  const parkAndRide = typeName === PARK_AND_RIDE;
  const layout = typeName === undefined ? undefined : LAYOUTS[typeName];
  const total = capacityOf(f, "PARKING");
  const disabled = capacityOf(f, "HANDICAPPED_PARKING");
  const areas: AreaInput[] = [
    ...(total === undefined
      ? []
      : [{ vehicleType: "car", userGroup: "any", capacity: total } as const]),
    ...(disabled === undefined
      ? []
      : [{ vehicleType: "car", userGroup: "disabled", capacity: disabled } as const]),
    // The API says only that there is a charging station, not how many spaces.
    ...(f.equipment?.charging?.hasChargingStation === true
      ? [{ vehicleType: "car", userGroup: "ev_charging" } as const]
      : []),
  ];
  const hours = f.access?.openingHours;
  const heightCm = integer(f.access?.restrictions?.clearance?.height);
  const name = nameOf(f);
  const operator = text(f.operator?.name);
  const website = text(f.url);
  const hoursText = text(hours?.text);
  const address = f.address;
  return {
    stationId,
    point,
    lang: "de",
    ...(name === undefined ? {} : { name }),
    ...(parkAndRide ? { type: "park_and_ride", usage: ["park_and_ride"] } : {}),
    ...(layout === undefined ? {} : { layout }),
    ...(f.access?.outOfService?.isOutOfService === true ? { lifecycle: "temporarily_closed" } : {}),
    ...(operator === undefined ? {} : { operator }),
    ...(website === undefined ? {} : { website }),
    address: {
      ...(text(address?.streetAndNumber) === undefined ? {} : { street: address?.streetAndNumber }),
      ...(text(address?.zip) === undefined ? {} : { postalCode: address?.zip }),
      ...(text(address?.city) === undefined ? {} : { city: address?.city }),
    },
    ...(hours?.is24h === true
      ? { openingHoursOsm: "24/7" }
      : hoursText === undefined
        ? {}
        : { openingHoursText: hoursText }),
    ...(total === undefined ? {} : { capacityTotal: total }),
    ...(heightCm !== undefined && heightCm > 0 ? { heightLimitM: heightCm / 100 } : {}),
    areas,
  };
}

/**
 * The standard prices as one rate; a duration code it does not know is left
 * out and counted as an unknown value.
 */
function rateOf(
  feed: ParkingCatalogFeed,
  f: BahnparkFacility,
  stationId: string,
  point: [number, number],
  fetchedAt: string,
): RecordDraft | undefined {
  const rows: RateRow[] = (f.tariff?.prices ?? []).flatMap((p) => {
    if (p.group?.groupName !== STANDARD || !finite(p.price)) return [];
    const row = DURATIONS[text(p.duration) ?? ""];
    if (row === undefined) recordSkipped(feed.id, "unknown_value");
    return row === undefined ? [] : [{ amount: p.price, ...row }];
  });
  return rateDraft(feed, stationId, 1, { currency: "EUR", rows, point, fetchedAt });
}

/**
 * DB BahnPark (Parking Information API v2): each facility of the `main`
 * payload is a site, its standard prices one EUR `parking_rate`. P-Card,
 * long-term and reservation prices are rates for those groups. The API
 * publishes no occupancy, so there are no readings. A facility type or a
 * standard price's duration code it does not know is an unknown value, the
 * site published without it. A facility without an
 * id or a point gives no site and is counted as skipped.
 */
export function parseDbBahnpark(
  feed: ParkingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  for (const body of payloads["main"] ?? []) {
    for (const f of facilitiesOf(body)) {
      const site = placed(f);
      if ("skip" in site) {
        recordSkipped(feed.id, site.skip);
        continue;
      }
      const { stationId, point } = site;
      const typeName = text(f.type?.name);
      if (typeName !== undefined && typeName !== PARK_AND_RIDE && LAYOUTS[typeName] === undefined) {
        recordSkipped(feed.id, "unknown_value");
      }
      out.features.push(siteDraft(feed, siteInput(f, stationId, point), ctx.fetchedAt));
      const rate = rateOf(feed, f, stationId, point, ctx.fetchedAt);
      if (rate !== undefined) out.offers.push(rate);
    }
  }
  return out;
}
