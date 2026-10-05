import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import type { ParkingUserGroup } from "@openconditions/model-parking";
import type { ParkingCatalogFeed } from "../feed-schema.js";
import {
  type AreaInput,
  occupancyPctDraft,
  type RateRow,
  rateDraft,
  type SiteInput,
  siteDraft,
} from "../site.js";

type Localized = { en?: string; de?: string; fr?: string; it?: string };

/** The properties of one facility of SBB's bike-and-car-parking GeoJSON, as far as they are read. */
interface SbbProperties {
  parkingFacilityCategory?: string;
  parkingFacilityType?: string;
  displayName?: string;
  capacities?: { categoryType?: string; total?: number | null }[];
  currentEstimatedOccupancy?: number | null;
  publicAccess?: boolean | null;
  operator?: string | null;
  address?: { addressLine?: string | null; postalCode?: string | null; city?: string | null };
  operationTime?: {
    daysOfWeek?: string[];
    operatingFrom?: string | null;
    operatingTo?: string | null;
  } | null;
  pricingModel?: {
    priceSegments?: { startingFrom?: number | null; price?: number | null }[];
    /** The billing step, in minutes: each segment's price is per this many minutes. */
    viableIncrement?: number | null;
    maximumDayPrice?: number | null;
    monthlyTicketPrice?: number | null;
    monthlyTicketPriceWithPublicTransportSeasonTicketDiscount?: number | null;
    yearlyTicketPrice?: number | null;
    yearlyTicketPriceWithPublicTransportSeasonTicketDiscount?: number | null;
  } | null;
  callToAction?: Record<string, Localized | null | undefined> | null;
}

interface SbbFeature {
  id?: string;
  geometry?: {
    type?: string;
    coordinates?: unknown;
    geometries?: { type?: string; coordinates?: unknown }[];
  };
  properties?: SbbProperties | null;
}

/** The capacity categories that are areas; the standard one is also the site's total. */
const CATEGORIES: Readonly<Record<string, ParkingUserGroup>> = {
  STANDARD: "any",
  DISABLED_PARKING_SPACE: "disabled",
  WITH_CHARGING_STATION: "ev_charging",
};

const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
const OSM_DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** Links to the facility, in order of preference. */
const LINKS = ["externalDesktop", "externalMobile", "sbbDesktop", "sbbMobile"] as const;

/** Season tickets bought with a public transport season ticket are cheaper. */
const PT_DISCOUNT = "public_transport_season_ticket";

/** How long an occupancy estimate stays current. */
const ESTIMATE_SEC = 3600;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function pointOf(feature: SbbFeature): [number, number] | undefined {
  const g = feature.geometry;
  const points =
    g?.type === "Point" ? [g] : (g?.geometries ?? []).filter((p) => p.type === "Point");
  for (const p of points) {
    const c = p.coordinates;
    if (Array.isArray(c) && c.length >= 2 && finite(c[0]) && finite(c[1])) return [c[0], c[1]];
  }
  return undefined;
}

/** A contiguous run of days as `Mo-Fr`, separate days as `Mo,We`. */
function dayRanges(indices: number[]): string {
  const runs: [number, number][] = [];
  for (const i of indices) {
    const last = runs.at(-1);
    if (last !== undefined && last[1] === i - 1) last[1] = i;
    else runs.push([i, i]);
  }
  return runs
    .map(([a, b]) =>
      a === b ? OSM_DAYS[a] : `${OSM_DAYS[a]}${b === a + 1 ? "," : "-"}${OSM_DAYS[b]}`,
    )
    .join(",");
}

/**
 * OSM opening hours of the one span every listed day shares: `24/7` for
 * midnight to midnight on every day, a closing time of midnight as `24:00`.
 */
function openingHoursOf(time: SbbProperties["operationTime"]): string | undefined {
  const from = text(time?.operatingFrom)?.slice(0, 5);
  const to = text(time?.operatingTo)?.slice(0, 5);
  const hhmm = /^\d{2}:\d{2}$/;
  if (from === undefined || to === undefined || !hhmm.test(from) || !hhmm.test(to)) {
    return undefined;
  }
  const indices = [...new Set((time?.daysOfWeek ?? []).map((d) => DAYS.indexOf(d)))]
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  if (indices.length === 0) return undefined;
  if (indices.length === 7 && from === "00:00" && to === "00:00") return "24/7";
  return `${dayRanges(indices)} ${from}-${to === "00:00" ? "24:00" : to}`;
}

function websiteOf(cta: SbbProperties["callToAction"]): string | undefined {
  for (const key of LINKS) {
    const link = cta?.[key];
    const url = text(link?.en) ?? text(link?.de) ?? text(link?.fr) ?? text(link?.it);
    if (url !== undefined) return url;
  }
  return undefined;
}

function areasOf(p: SbbProperties): AreaInput[] {
  return (p.capacities ?? []).flatMap((c) => {
    const userGroup = CATEGORIES[c.categoryType ?? ""];
    const total = c.total;
    return userGroup !== undefined && finite(total) && Number.isInteger(total) && total > 0
      ? [{ vehicleType: "car" as const, userGroup, capacity: total }]
      : [];
  });
}

function siteInput(p: SbbProperties, stationId: string, point: [number, number]): SiteInput {
  const type = p.parkingFacilityType ?? "";
  const parkAndRide = type === "PARK_AND_RAIL";
  const areas = areasOf(p);
  const standard = areas.find((a) => a.userGroup === "any")?.capacity;
  const name = text(p.displayName);
  const operator = text(p.operator);
  const website = websiteOf(p.callToAction);
  const hours = openingHoursOf(p.operationTime);
  const a = p.address;
  return {
    stationId,
    point,
    ...(name === undefined ? {} : { name }),
    type: parkAndRide ? "park_and_ride" : "off_street",
    ...(parkAndRide ? { usage: ["park_and_ride"] } : {}),
    ...(type.includes("UNDERGROUND") ? { layout: "underground" } : {}),
    ...(operator === undefined ? {} : { operator }),
    ...(website === undefined ? {} : { website }),
    address: {
      ...(text(a?.addressLine) === undefined ? {} : { street: a?.addressLine ?? undefined }),
      ...(text(a?.postalCode) === undefined ? {} : { postalCode: a?.postalCode ?? undefined }),
      ...(text(a?.city) === undefined ? {} : { city: a?.city ?? undefined }),
    },
    ...(hours === undefined ? {} : { openingHoursOsm: hours }),
    ...(p.publicAccess === true ? { audience: "public" } : {}),
    ...(p.publicAccess === false ? { audience: "private" } : {}),
    ...(standard === undefined ? {} : { capacityTotal: standard }),
    areas,
  };
}

const minutes = (value: number) => ({ value, unit: "min" });

/** Prices in centimes, as rows in francs. */
function rowsOf(pricing: SbbProperties["pricingModel"]): RateRow[] {
  if (!pricing) return [];
  const francs = (centimes: number | null | undefined) =>
    finite(centimes) ? centimes / 100 : undefined;
  const increment = pricing.viableIncrement;
  // A segment's price is per increment; without one there is no rate per time.
  const segments =
    finite(increment) && increment > 0
      ? (pricing.priceSegments ?? [])
          .filter((s) => finite(s.startingFrom) && finite(s.price))
          .sort((x, y) => (x.startingFrom as number) - (y.startingFrom as number))
      : [];
  // Each segment's price per increment holds from its start until the next segment starts.
  const rows: RateRow[] = segments.map((s, i) => {
    const next = segments[i + 1]?.startingFrom;
    return {
      component: "parking_time",
      amount: ((s.price as number) * 60) / (increment as number) / 100,
      stepSizeSec: (increment as number) * 60,
      minDuration: minutes(s.startingFrom as number),
      ...(finite(next) ? { maxDuration: minutes(next) } : {}),
    };
  });
  const row = (centimes: number | null | undefined, unit: string, userGroups?: string[]) => {
    const amount = francs(centimes);
    return amount === undefined
      ? []
      : [{ amount, maxDuration: { value: 1, unit }, ...(userGroups ? { userGroups } : {}) }];
  };
  return [
    ...rows,
    ...row(pricing.maximumDayPrice, "d"),
    ...row(pricing.monthlyTicketPrice, "mo", ["monthly_ticket"]),
    ...row(pricing.monthlyTicketPriceWithPublicTransportSeasonTicketDiscount, "mo", [
      "monthly_ticket",
      PT_DISCOUNT,
    ]),
    ...row(pricing.yearlyTicketPrice, "a", ["yearly_ticket"]),
    ...row(pricing.yearlyTicketPriceWithPublicTransportSeasonTicketDiscount, "a", [
      "yearly_ticket",
      PT_DISCOUNT,
    ]),
  ];
}

/** The features of the body: a GeoJSON FeatureCollection. */
function featuresOf(body: Buffer): SbbFeature[] {
  const features = (JSON.parse(body.toString("utf8")) as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) throw new Error("sbb: body has no features array");
  return features as SbbFeature[];
}

/**
 * SBB's bike-and-car-parking dataset (opentransportdata.swiss): each car
 * facility of the `main` GeoJSON is a site. The capacity categories are
 * areas, and the standard one is the site's total. The pricing model is one
 * CHF `parking_rate`. Each price segment is a price per `viableIncrement`
 * minutes, so it is a `parking_time` element (the price per hour, billed in
 * steps of the increment) from its `startingFrom` until the next segment
 * starts; then come flat rows for the day maximum and the monthly and yearly
 * tickets. The estimated occupancy is
 * a percentage reading at the poll; being an estimate, it gives no count of
 * free spaces. It carries no time of its own, so it is dated at the poll and
 * stays current for an hour, not two of the feed's daily cadences: an
 * estimate goes stale fast. A facility without a point is rejected.
 */
export function parseSbb(
  feed: ParkingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  let rejected = 0;
  for (const body of payloads["main"] ?? []) {
    for (const feature of featuresOf(body)) {
      const p = feature.properties;
      if (p?.parkingFacilityCategory !== "CAR") continue;
      const stationId = text(feature.id);
      const point = pointOf(feature);
      if (stationId === undefined || point === undefined) {
        rejected++;
        continue;
      }
      out.features.push(siteDraft(feed, siteInput(p, stationId, point), ctx.fetchedAt));
      const rate = rateDraft(feed, stationId, 1, {
        currency: "CHF",
        rows: rowsOf(p.pricingModel),
        point,
        fetchedAt: ctx.fetchedAt,
      });
      if (rate !== undefined) out.offers.push(rate);
      const share = p.currentEstimatedOccupancy;
      if (finite(share)) {
        const pct = Number((share * 100).toPrecision(12));
        const reading = { stationId, at: ctx.fetchedAt, point, pct, validForSec: ESTIMATE_SEC };
        const draft: RecordDraft | undefined = occupancyPctDraft(feed, reading, ctx);
        if (draft !== undefined) out.observations.push(draft);
      }
    }
  }
  out.rejected = rejected;
  return out;
}
