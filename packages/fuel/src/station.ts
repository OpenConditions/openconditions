import type { CatalogFeed, RecordDraft } from "@openconditions/ingest-framework";
import { type AUDIENCES, type LIFECYCLES, observationId } from "@openconditions/model";
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
  audience?: (typeof AUDIENCES)[number];
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
    },
  }));
  return {
    id: `oc:feature:${feed.id}:${input.stationId}`,
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
    ...(input.audience === undefined ? {} : { access: { audience: input.audience } }),
    ...(components.length === 0 ? {} : { components }),
    details: {
      kind: "fuel_station",
      v: 1,
      ...(input.brand === undefined ? {} : { brand: input.brand }),
      productsComplete: input.productsComplete,
    },
  };
}

/** A reading of one of the station's products, located and attributed as the station is. */
function readingDraft(
  station: StationDraft,
  componentKey: string,
  property: string,
  result: RecordDraft,
  at: string,
): RecordDraft {
  if (!station.components?.some((c) => c.key === componentKey)) {
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
    subject: { kind: "feature", featureId: station.id, componentKey },
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
