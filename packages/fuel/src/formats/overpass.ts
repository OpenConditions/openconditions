import {
  decodeOverpass,
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
  type SkipReason,
} from "@openconditions/ingest-framework";
import type { AUDIENCES, PAYMENT_METHODS } from "@openconditions/model";
import {
  availabilityDraft,
  type FuelFeed,
  type ProductInput,
  placeable,
  stationDraft,
} from "../station.js";

/**
 * The `fuel:<name>` tags with a grade (https://wiki.openstreetmap.org/wiki/Key:fuel:*),
 * in the order a station lists its products. The tag name is read
 * case-insensitively (`fuel:HGV_diesel`). Tags the wiki lists as deprecated
 * aliases (`fuel:GNV`, `fuel:GPL`, `fuel:b7`) read as the tag they stand for,
 * and the hydrogen tags without a pressure are the 700 bar product cars fill.
 * `fuel:GTL_diesel` is the brands' premium diesel ("Ultimate Diesel",
 * "V-Power Diesel", as the wiki names them); `fuel:biodiesel` is pure
 * biodiesel, as DATEX's `bioDiesel` is read; `fuel:biogas` is compressed
 * biomethane.
 */
const TAGS: readonly { tag: string; product: ProductInput }[] = [
  { tag: "diesel", product: { key: "diesel", grade: "diesel" } },
  { tag: "octane_95", product: { key: "e5", grade: "e5" } },
  { tag: "e5", product: { key: "e5", grade: "e5" } },
  { tag: "e10", product: { key: "e10", grade: "e10" } },
  { tag: "octane_98", product: { key: "sp98", grade: "sp98" } },
  { tag: "octane_100", product: { key: "sp100", grade: "sp100" } },
  { tag: "e85", product: { key: "e85", grade: "e85" } },
  { tag: "lpg", product: { key: "lpg", grade: "lpg" } },
  { tag: "gpl", product: { key: "lpg", grade: "lpg" } },
  { tag: "cng", product: { key: "cng", grade: "cng" } },
  { tag: "gnv", product: { key: "cng", grade: "cng" } },
  { tag: "biogas", product: { key: "cng_bio", grade: "cng_bio" } },
  { tag: "lng", product: { key: "lng", grade: "lng" } },
  { tag: "gtl_diesel", product: { key: "diesel_premium", grade: "diesel_premium" } },
  // A lorry pump sells the same grade as the car pumps, so it is its own product.
  { tag: "hgv_diesel", product: { key: "diesel:hgv", grade: "diesel", vehicleScope: "hgv" } },
  { tag: "diesel_b7", product: { key: "b7", grade: "b7" } },
  { tag: "b7", product: { key: "b7", grade: "b7" } },
  { tag: "diesel_b10", product: { key: "b10", grade: "b10" } },
  { tag: "b10", product: { key: "b10", grade: "b10" } },
  { tag: "biodiesel", product: { key: "b100", grade: "b100" } },
  { tag: "hvo100", product: { key: "hvo100", grade: "hvo100" } },
  { tag: "ethanol", product: { key: "ethanol", grade: "ethanol" } },
  { tag: "e100", product: { key: "ethanol", grade: "ethanol" } },
  { tag: "methanol", product: { key: "methanol", grade: "methanol" } },
  { tag: "adblue", product: { key: "adblue", grade: "adblue" } },
  { tag: "h35", product: { key: "h2_350", grade: "h2_350" } },
  { tag: "h70", product: { key: "h2_700", grade: "h2_700" } },
  { tag: "h2", product: { key: "h2_700", grade: "h2_700" } },
  { tag: "hydrogen", product: { key: "h2_700", grade: "h2_700" } },
];

type PaymentMethod = (typeof PAYMENT_METHODS)[number];

const GRADE_TAGS: ReadonlySet<string> = new Set(TAGS.map(({ tag }) => tag));

/** `fuel:others=no` says the tags list every fuel; it names no product. */
const NO_PRODUCT_TAGS: ReadonlySet<string> = new Set(["others"]);

/**
 * `payment:<method>` tags (https://wiki.openstreetmap.org/wiki/Key:payment:*)
 * by the method they name; a method not listed here, a fuel card or a
 * station's own card, is `other`.
 */
const PAYMENT: Readonly<Record<string, PaymentMethod>> = {
  cash: "cash",
  coins: "cash",
  notes: "cash",
  credit_cards: "credit_card",
  visa: "credit_card",
  mastercard: "credit_card",
  american_express: "credit_card",
  diners_club: "credit_card",
  discover_card: "credit_card",
  jcb: "credit_card",
  debit_cards: "debit_card",
  maestro: "debit_card",
  girocard: "debit_card",
  v_pay: "debit_card",
  visa_debit: "debit_card",
  visa_electron: "debit_card",
  contactless: "contactless",
};

/** The OSM `access` values by who may fill up. */
const ACCESS: Readonly<Record<string, (typeof AUDIENCES)[number]>> = {
  yes: "public",
  permissive: "public",
  customers: "customers",
  permit: "permit",
  private: "private",
  no: "private",
};

/** `shop=*` at a station: what it sells, a plain shop for any other value. */
const SHOPS: Readonly<Record<string, string>> = {
  convenience: "food_shopping",
  kiosk: "kiosk",
  supermarket: "supermarket",
};

/** A table's own entry for a tag value; an inherited key such as `constructor` is none. */
const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/** The station's amenity tags, each `yes` but for `shop` and `internet_access`. */
function amenitiesOf(tags: Record<string, string>): string[] {
  const yes = (key: string) => tags[key]?.trim().toLowerCase() === "yes";
  const shop = tags["shop"]?.trim().toLowerCase();
  const internet = tags["internet_access"]?.trim().toLowerCase();
  return [
    ...(shop && shop !== "no" ? [own(SHOPS, shop) ?? "shop"] : []),
    ...(yes("kiosk") ? ["kiosk"] : []),
    ...(yes("car_wash") ? ["car_wash"] : []),
    ...(yes("atm") ? ["cash_machine"] : []),
    ...(yes("toilets") ? ["toilets"] : []),
    ...(yes("compressed_air") ? ["compressed_air"] : []),
    ...(internet === "wlan" || internet === "yes" ? ["wifi"] : []),
  ];
}

/**
 * How fuel is paid for, from the `payment:*` tags that say `yes`. A value
 * neither `yes` nor `no` is counted as not read.
 */
function paymentOf(tags: Record<string, string>, skip: (reason: "unknown_value") => void) {
  const methods: PaymentMethod[] = [];
  for (const [key, raw] of Object.entries(tags)) {
    if (!key.startsWith("payment:")) continue;
    const value = raw.trim().toLowerCase();
    const method = key.slice(8).toLowerCase();
    if (value === "yes") methods.push(own(PAYMENT, method) ?? "other");
    else if (value !== "no") skip("unknown_value");
  }
  return methods;
}

/** Who pumps: the driver at a self-service or automated station, staff where self service is `no`. */
function serviceOf(tags: Record<string, string>): ProductInput["service"] {
  const selfService = tags["self_service"]?.trim().toLowerCase();
  if (selfService === "yes" || tags["automated"]?.trim().toLowerCase() === "yes") return "self";
  return selfService === "no" ? "served" : undefined;
}

const COUNTRY = /^[A-Z]{2}$/;
const WIKIDATA_ITEM = /^Q[1-9][0-9]*$/;

/** OSM text is in whatever language the mapper wrote it. */
const UNDETERMINED = "und";

/**
 * Whether each graded product is sold, from the station's `fuel:*` tags: `yes`
 * sold, `no` not sold, any other value unknown and counted as not read, as is
 * every tag of a fuel without a grade (`fuel:octane_102`, `fuel:heating_oil`).
 * Products of one key keep the first tag that says something.
 */
function productsOf(
  tags: Record<string, string>,
  service: ProductInput["service"],
  skip: (reason: "unknown_value") => void,
): { product: ProductInput; sold: boolean }[] {
  const fuel = new Map<string, string>();
  for (const [key, value] of Object.entries(tags)) {
    if (!key.startsWith("fuel:")) continue;
    const name = key.slice(5).toLowerCase();
    if (NO_PRODUCT_TAGS.has(name)) continue;
    if (!GRADE_TAGS.has(name)) {
      skip("unknown_value");
      continue;
    }
    const v = value.trim().toLowerCase();
    if (v !== "yes" && v !== "no") skip("unknown_value");
    fuel.set(name, v);
  }
  const out = new Map<string, { product: ProductInput; sold: boolean }>();
  for (const { tag, product } of TAGS) {
    const value = fuel.get(tag);
    if ((value !== "yes" && value !== "no") || out.has(product.key)) continue;
    out.set(product.key, {
      product: service === undefined ? product : { ...product, service },
      sold: value === "yes",
    });
  }
  return [...out.values()];
}

const tag = (tags: Record<string, string>, key: string): string | undefined => {
  const value = tags[key]?.trim();
  return value ? value : undefined;
};

/**
 * OpenStreetMap filling stations (`amenity=fuel`) as Overpass answers for a
 * cell, nodes at their position and ways and relations at their centre. The
 * station id is the element (`node/<id>`), which is also its `osm:<type>` id
 * that linking matches on. Its `fuel:*` tags are the products, each with an
 * availability reading as of the fetch; OSM holds no prices. The tags list
 * what mappers recorded, so the products are not complete. `self_service` and
 * `automated` set who pumps; `access`, the `payment:*` tags and `hgv` who may
 * fill up and how to pay; the shop, kiosk, car wash, cash machine, toilet,
 * air pump and wireless internet tags the amenities. The address is kept only when
 * its tags name the country. A station placed outside WGS84 range is skipped
 * as malformed.
 */
export function parseOverpassFuel(
  feed: FuelFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const skip = (reason: SkipReason) => recordSkipped(feed.id, reason);
  for (const payload of payloads["main"] ?? []) {
    for (const element of decodeOverpass(payload, skip)) {
      const { tags } = element;
      if (tags["amenity"] !== "fuel") continue;
      if (!placeable(element.lon, element.lat)) {
        skip("malformed");
        continue;
      }
      const products = productsOf(tags, serviceOf(tags), skip);
      const access = tag(tags, "access")?.toLowerCase();
      const audience = access === undefined ? undefined : own(ACCESS, access);
      if (access !== undefined && audience === undefined) skip("unknown_value");
      const payment = paymentOf(tags, skip);
      const hgv = tag(tags, "hgv")?.toLowerCase();
      const name = tag(tags, "name");
      const brand = tag(tags, "brand");
      const brandWikidata = tag(tags, "brand:wikidata");
      const operator = tag(tags, "operator");
      const hours = tag(tags, "opening_hours");
      const country = tag(tags, "addr:country")?.toUpperCase();
      const feature = stationDraft(feed, {
        stationId: `${element.type}/${element.id}`,
        lon: element.lon,
        lat: element.lat,
        ...(element.centre ? { geometryOrigin: "derived" as const } : {}),
        fetchedAt: ctx.fetchedAt,
        externalIds: [{ scheme: `osm:${element.type}`, id: String(element.id) }],
        ...(name ? { name: { lang: UNDETERMINED, text: name } } : {}),
        ...(brand ? { brand } : {}),
        ...(brandWikidata && WIKIDATA_ITEM.test(brandWikidata) ? { brandWikidata } : {}),
        ...(operator ? { operator: { lang: UNDETERMINED, text: operator } } : {}),
        ...(hours ? { openingHours: hours } : {}),
        ...(country && COUNTRY.test(country)
          ? {
              address: {
                ...(tag(tags, "addr:street") ? { street: tag(tags, "addr:street") } : {}),
                ...(tag(tags, "addr:housenumber")
                  ? { houseNumber: tag(tags, "addr:housenumber") }
                  : {}),
                ...(tag(tags, "addr:postcode") ? { postalCode: tag(tags, "addr:postcode") } : {}),
                ...(tag(tags, "addr:city") ? { city: tag(tags, "addr:city") } : {}),
                country,
              },
            }
          : {}),
        ...(audience === undefined ? {} : { audience }),
        payment,
        amenities: amenitiesOf(tags),
        ...(hgv === "yes" || hgv === "no" ? { truckSuitable: hgv === "yes" } : {}),
        productsComplete: false,
        products: products.map(({ product }) => product),
      });
      out.features.push(feature);
      for (const { product, sold } of products) {
        out.observations.push(
          availabilityDraft(feature, {
            componentKey: product.key,
            available: sold,
            at: ctx.fetchedAt,
          }),
        );
      }
    }
  }
  return out;
}
