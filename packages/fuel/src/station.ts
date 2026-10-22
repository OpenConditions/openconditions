import type { CatalogFeed, RecordDraft } from "@openconditions/ingest-framework";
import {
  type AUDIENCES,
  type DirectionRef,
  type LIFECYCLES,
  observationId,
  type PAYMENT_METHODS,
  type ROAD_CLASSES,
  recordLocalId,
} from "@openconditions/model";
import { type FuelGrade, type FuelUnit, GRADE_UNIT } from "./grades.js";

/** What a fuel record takes from its feed. */
export type FuelFeed = Pick<
  CatalogFeed,
  "id" | "format" | "attribution" | "license" | "licenseUrl" | "accessMode" | "onDemand"
>;

/** One product a station sells: a grade, and how it is priced when a source tells several apart. */
export interface ProductInput {
  /** The component key: the grade, plus `:self` or `:served` where a source prices both. */
  key: string;
  grade: FuelGrade;
  /** The sale unit; the grade's own by default. */
  per?: FuelUnit;
  /** The product's biofuel share by volume, as the station declares it. */
  biofuelPct?: number;
  service?: "self" | "served" | "unknown";
  priceLevel?: "standard" | "member" | "card" | "fleet" | "cash" | "unknown";
  vehicleScope?: "any" | "car" | "hgv";
  priceBasis?: "gross" | "net";
}

export interface StationAddress {
  street?: string;
  houseNumber?: string;
  postalCode?: string;
  city?: string;
  country: string;
}

export interface StationInput {
  /** The source's own id of the station (`node/<id>` for OSM). */
  stationId: string;
  lon: number;
  lat: number;
  /** When the poll or the on-demand fetch read the station. */
  fetchedAt: string;
  name?: { lang: string; text: string };
  brand?: string;
  /** The brand's Wikidata item (`Q<digits>`). */
  brandWikidata?: string;
  operator?: { lang: string; text: string };
  /**
   * The station's ids that linking matches on. Absent, the station carries its
   * `stationId` under the `provider` scheme with the feed as authority, so two
   * stations of one source never link. OSM gives its `osm:<type>` id instead.
   */
  externalIds?: readonly { scheme: string; id: string }[];
  /** Opening hours in the OSM `opening_hours` grammar. */
  openingHours?: string;
  address?: StationAddress;
  admin?: { country: string; geocodes?: { scheme: string; code: string }[] };
  /** The class of the road the station is on, where the source names it. */
  roadClass?: (typeof ROAD_CLASSES)[number];
  /** The road the station is on and its kilometre point, where the source names them. */
  road?: { ref: string; km?: number };
  /** The carriageway the station stands beside, read against `road`. */
  direction?: DirectionRef;
  /** Who may fill up; `unknown` when the station says how to pay but not who it serves. */
  audience?: (typeof AUDIENCES)[number];
  /** How fuel can be paid for, in the order the source lists it. */
  payment?: readonly (typeof PAYMENT_METHODS)[number][];
  /** What the source says about payment beyond the methods, such as the fuel cards taken. */
  paymentNotes?: { lang: string; text: string };
  /** What the station offers besides fuel, as `amenity` vocabulary values. */
  amenities?: readonly string[];
  /** The source's free-text description of the station's other offers. */
  description?: { lang: string; text: string };
  truckSuitable?: boolean;
  lifecycle?: (typeof LIFECYCLES)[number];
  /** Whether the source lists every grade the station sells, so a missing one is not sold. */
  productsComplete: boolean;
  products: readonly ProductInput[];
}

/** A station draft: the feature the price and availability drafts hang on. */
export type StationDraft = RecordDraft & {
  id: string;
  location: Record<string, unknown>;
  provenance: Record<string, unknown>;
  freshness: Record<string, unknown>;
  /** Absent when the station has no known product. */
  components?: { key: string; kind: string; details: { per: FuelUnit } & RecordDraft }[];
};

/**
 * Whether a source position can place a station: finite, on the globe, and
 * not 0,0, which publishers write for a station they have not located.
 */
export function placeable(lon: number, lat: number): boolean {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= -180 &&
    lon <= 180 &&
    lat >= -90 &&
    lat <= 90 &&
    !(lon === 0 && lat === 0)
  );
}

/**
 * A station's source position, or why it cannot place the station as a skip
 * reason: `no_geometry` when the source gives none (a coordinate absent, or
 * 0,0, the unlocated station), `malformed` when it gives one that is not a
 * position on the globe. An absent coordinate is `undefined`; one present but
 * unreadable is NaN.
 */
export function stationPosition(
  lon: number | undefined,
  lat: number | undefined,
): { lon: number; lat: number } | { skip: "no_geometry" | "malformed" } {
  if (lon === undefined || lat === undefined || (lon === 0 && lat === 0)) {
    return { skip: "no_geometry" };
  }
  return placeable(lon, lat) ? { lon, lat } : { skip: "malformed" };
}

/**
 * A JSON object: what a station record, and each price or day in it, must be
 * to be read. A `null` or a bare value in a station list is a malformed
 * record, not a reason to fail the poll.
 */
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A price as the decimal text a money result carries, to the tenth of a
 * cent; undefined for a number that is no price: not positive, or so large
 * that it would print in exponent form, which no money amount is written in.
 */
export function priceText(value: unknown): string | undefined {
  return typeof value === "number" && value > 0 && value < 1e21 ? value.toFixed(3) : undefined;
}

/** An instant in UTC at second precision, as the drafts carry it. */
export function utcInstant(at: Date): string {
  return at.toISOString().replace(/\.000Z$/, "Z");
}

/**
 * When an on-demand feed's answer fetched at `fetchedAt` stops being current:
 * `onDemand.ttlSec` later. Undefined for a bulk feed, whose next poll replaces
 * the answer.
 */
function expiry(feed: FuelFeed, fetchedAt: string): string | undefined {
  const ttlSec = feed.onDemand?.ttlSec;
  if (ttlSec === undefined) return undefined;
  return utcInstant(new Date(Date.parse(fetchedAt) + ttlSec * 1000));
}

/**
 * The station's access block: absent when the source says nothing about who
 * may fill up or how to pay, its audience `unknown` when it names only the
 * payment.
 */
function accessOf(input: StationInput): { access?: Record<string, unknown> } {
  const payment = input.payment === undefined ? [] : [...new Set(input.payment)];
  if (input.audience === undefined && payment.length === 0 && input.paymentNotes === undefined) {
    return {};
  }
  return {
    access: {
      audience: input.audience ?? "unknown",
      ...(payment.length === 0 ? {} : { payment }),
      ...(input.paymentNotes === undefined ? {} : { notes: [input.paymentNotes] }),
    },
  };
}

/** The station's road, as `location.roads`: its class, reference and kilometre point. */
function roadsOf(input: StationInput): { roads?: Record<string, unknown>[] } {
  if (input.roadClass === undefined && input.road === undefined) return {};
  return {
    roads: [
      {
        ...(input.road === undefined ? {} : { ref: input.road.ref }),
        ...(input.roadClass === undefined ? {} : { class: input.roadClass }),
        ...(input.road?.km === undefined ? {} : { kmFrom: input.road.km }),
      },
    ],
  };
}

/**
 * A `fuel_station` feature with one `fuel_product` component per product (none
 * when no product is known). An on-demand feed's station says when it expires.
 */
export function stationDraft(feed: FuelFeed, input: StationInput): StationDraft {
  const expiresAt = expiry(feed, input.fetchedAt);
  const freshness = {
    fetchedAt: input.fetchedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
  const components = input.products.map((p) => ({
    key: p.key,
    kind: "fuel_product",
    details: {
      kind: "fuel_product",
      v: 1,
      grade: p.grade,
      ...(p.service === undefined ? {} : { service: p.service }),
      priceLevel: p.priceLevel ?? "standard",
      vehicleScope: p.vehicleScope ?? "any",
      per: p.per ?? GRADE_UNIT[p.grade],
      priceBasis: p.priceBasis ?? "gross",
      ...(p.biofuelPct === undefined ? {} : { biofuelPct: p.biofuelPct }),
    },
  }));
  return {
    id: `oc:feature:${feed.id}:${recordLocalId(input.stationId)}`,
    class: "feature",
    kind: "fuel_station",
    temporality: "static",
    lifecycle: input.lifecycle ?? "operational",
    location: {
      geometry: { type: "Point", coordinates: [input.lon, input.lat] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "exact",
      ...(input.address === undefined ? {} : { address: input.address }),
      ...(input.admin === undefined ? {} : { admin: input.admin }),
      ...roadsOf(input),
    },
    provenance: {
      origin: "feed",
      sourceId: feed.id,
      sourceFormat: feed.format,
      accessMode: feed.accessMode ?? "bulk",
      recordId: input.stationId,
      attribution: {
        provider: feed.attribution,
        license: feed.license,
        ...(feed.licenseUrl === undefined ? {} : { licenseUrl: feed.licenseUrl }),
      },
      privacy: { class: "authoritative" },
    },
    freshness,
    externalIds:
      input.externalIds === undefined || input.externalIds.length === 0
        ? [{ scheme: "provider", id: input.stationId, authority: feed.id }]
        : input.externalIds.map((e) => ({ ...e })),
    ...(input.name === undefined ? {} : { name: [input.name] }),
    ...(input.description === undefined ? {} : { description: [input.description] }),
    ...(input.operator === undefined
      ? {}
      : { operator: { role: "operator", name: [input.operator] } }),
    ...(input.openingHours === undefined
      ? {}
      : {
          openingHours: {
            osm: input.openingHours,
            ...(input.openingHours === "24/7" ? { twentyFourSeven: true } : {}),
          },
        }),
    ...accessOf(input),
    ...(input.amenities === undefined || input.amenities.length === 0
      ? {}
      : { amenities: [...new Set(input.amenities)] }),
    ...(components.length === 0 ? {} : { components }),
    details: {
      kind: "fuel_station",
      v: 1,
      ...(input.brand === undefined ? {} : { brand: input.brand }),
      ...(input.brandWikidata === undefined ? {} : { brandWikidata: input.brandWikidata }),
      productsComplete: input.productsComplete,
      ...(input.truckSuitable === undefined ? {} : { truckSuitable: input.truckSuitable }),
      ...(input.direction === undefined ? {} : { direction: input.direction }),
    },
  };
}

/**
 * A reading of the station, or of one of its products when `componentKey`
 * names one, located and attributed as the station is.
 */
function readingDraft(
  station: StationDraft,
  componentKey: string | undefined,
  property: string,
  result: RecordDraft,
  at: string,
): RecordDraft {
  if (componentKey !== undefined && !station.components?.some((c) => c.key === componentKey)) {
    throw new Error(`${station.id} has no product ${componentKey}`);
  }
  const draft = {
    class: "observation",
    kind: "observation",
    property,
    temporality: "live",
    location: station.location,
    provenance: station.provenance,
    freshness: station.freshness,
    subject: {
      kind: "feature",
      featureId: station.id,
      ...(componentKey === undefined ? {} : { componentKey }),
    },
    result,
    phenomenonTime: { instant: at },
    aggregation: "instantaneous",
  };
  const namespace = station.provenance["sourceId"] as string;
  return { id: observationId(namespace, draft as never), ...draft };
}

/**
 * A `fuel.price` reading of one product, per the product's sale unit.
 * `amount` is the decimal string of the price; `at` is when the price was set.
 */
export function priceDraft(
  station: StationDraft,
  price: { componentKey: string; amount: string; currency: string; at: string },
): RecordDraft {
  const per = station.components?.find((c) => c.key === price.componentKey)?.details.per;
  return readingDraft(
    station,
    price.componentKey,
    "fuel.price",
    { type: "money", amount: price.amount, currency: price.currency, ...(per ? { per } : {}) },
    price.at,
  );
}

/** A `fuel.product_available` reading: whether the product is in stock at `at`. */
export function availabilityDraft(
  station: StationDraft,
  availability: { componentKey: string; available: boolean; at: string },
): RecordDraft {
  return readingDraft(
    station,
    availability.componentKey,
    "fuel.product_available",
    { type: "boolean", value: availability.available },
    availability.at,
  );
}

/**
 * A `facility.open_status` reading of the whole station: whether the
 * publisher says it is open at `at`. It is the publisher's word on the
 * moment, which a temporary closure the hours do not show changes too; it
 * does not retire the station.
 */
export function openStatusDraft(
  station: StationDraft,
  status: { open: boolean; at: string },
): RecordDraft {
  return readingDraft(
    station,
    undefined,
    "facility.open_status",
    {
      type: "category",
      value: status.open ? "open" : "closed",
      vocabulary: "facility_open_status",
    },
    status.at,
  );
}
