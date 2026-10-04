import {
  decodeOverpass,
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import {
  availabilityDraft,
  type FuelFeed,
  type ProductInput,
  placeable,
  stationDraft,
} from "../station.js";

/**
 * The `fuel:<name>` tags with a grade, in the order a station lists its
 * products. The tag name is read case-insensitively (`fuel:HGV_diesel`). The
 * two hydrogen tags are one product.
 */
const TAGS: readonly { tag: string; product: ProductInput }[] = [
  { tag: "diesel", product: { key: "diesel", grade: "diesel" } },
  { tag: "octane_95", product: { key: "e5", grade: "e5" } },
  { tag: "e10", product: { key: "e10", grade: "e10" } },
  { tag: "octane_98", product: { key: "sp98", grade: "sp98" } },
  { tag: "e85", product: { key: "e85", grade: "e85" } },
  { tag: "lpg", product: { key: "lpg", grade: "lpg" } },
  { tag: "cng", product: { key: "cng", grade: "cng" } },
  { tag: "lng", product: { key: "lng", grade: "lng" } },
  // A lorry pump sells the same grade as the car pumps, so it is its own product.
  { tag: "hgv_diesel", product: { key: "diesel:hgv", grade: "diesel", vehicleScope: "hgv" } },
  { tag: "adblue", product: { key: "adblue", grade: "adblue" } },
  { tag: "h2", product: { key: "h2_700", grade: "h2_700" } },
  { tag: "hydrogen", product: { key: "h2_700", grade: "h2_700" } },
];

const COUNTRY = /^[A-Z]{2}$/;

/** OSM text is in whatever language the mapper wrote it. */
const UNDETERMINED = "und";

/**
 * Whether each graded product is sold, from the station's `fuel:*` tags: `yes`
 * sold, `no` not sold, any other value unknown. Products of one key keep the
 * first tag that says something.
 */
function productsOf(tags: Record<string, string>): { product: ProductInput; sold: boolean }[] {
  const fuel = new Map<string, string>();
  for (const [key, value] of Object.entries(tags)) {
    if (key.startsWith("fuel:")) fuel.set(key.slice(5).toLowerCase(), value.trim().toLowerCase());
  }
  const out = new Map<string, { product: ProductInput; sold: boolean }>();
  for (const { tag, product } of TAGS) {
    const value = fuel.get(tag);
    if ((value !== "yes" && value !== "no") || out.has(product.key)) continue;
    out.set(product.key, { product, sold: value === "yes" });
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
 * what mappers recorded, so the products are not complete. The address is
 * kept only when its tags name the country.
 */
export function parseOverpassFuel(
  feed: FuelFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  let rejected = 0;
  for (const payload of payloads["main"] ?? []) {
    for (const element of decodeOverpass(payload)) {
      const { tags } = element;
      if (tags["amenity"] !== "fuel") continue;
      if (!placeable(element.lon, element.lat)) {
        rejected++;
        continue;
      }
      const products = productsOf(tags);
      const name = tag(tags, "name");
      const brand = tag(tags, "brand");
      const operator = tag(tags, "operator");
      const hours = tag(tags, "opening_hours");
      const country = tag(tags, "addr:country")?.toUpperCase();
      const feature = stationDraft(feed, {
        stationId: `${element.type}/${element.id}`,
        lon: element.lon,
        lat: element.lat,
        fetchedAt: ctx.fetchedAt,
        externalIds: [{ scheme: `osm:${element.type}`, id: String(element.id) }],
        ...(name ? { name: { lang: UNDETERMINED, text: name } } : {}),
        ...(brand ? { brand } : {}),
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
  out.rejected = rejected;
  return out;
}
