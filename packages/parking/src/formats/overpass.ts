import {
  decodeOverpass,
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import type { AUDIENCES } from "@openconditions/model";
import type {
  ParkingLayout,
  ParkingSiteType,
  ParkingUserGroup,
} from "@openconditions/model-parking";
import type { ParkingCatalogFeed } from "../feed-schema.js";
import { type AreaInput, type SiteInput, siteDraft } from "../site.js";

/** OSM text is in whatever language the mapper wrote it. */
const UNDETERMINED = "und";

/** Kerbside parking is on the street. */
const ON_STREET = new Set(["street_side", "lane", "on_kerb", "half_on_kerb"]);

/** How the car park is built; a rooftop deck sits on a structure of several levels. */
const LAYOUTS: Readonly<Record<string, ParkingLayout>> = {
  "multi-storey": "multi_storey",
  underground: "underground",
  surface: "surface",
  rooftop: "multi_storey",
};

/** `park_ride` values that make a site a park-and-ride (a list such as `tram;bus`). */
const PARK_RIDE = new Set(["yes", "bus", "train", "tram"]);

const AUDIENCE: Readonly<Record<string, (typeof AUDIENCES)[number]>> = {
  yes: "public",
  permissive: "public",
  customers: "customers",
  permit: "permit",
  private: "private",
  no: "private",
  destination: "restricted",
  delivery: "restricted",
};

/** `capacity:<group>` tags that are areas of the site. */
const AREA_TAGS: readonly [string, ParkingUserGroup][] = [
  ["capacity:disabled", "disabled"],
  ["capacity:charging", "ev_charging"],
  ["capacity:women", "women"],
];

const tag = (tags: Record<string, string>, key: string): string | undefined => {
  const value = tags[key]?.trim();
  return value ? value : undefined;
};

const count = (value: string | undefined): number | undefined =>
  value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;

/** A height in metres (`2.1`, `2,1 m`); feet and words are left out. */
function metres(value: string | undefined): number | undefined {
  const digits = value?.match(/^(\d+(?:[.,]\d+)?)\s*m?$/)?.[1];
  if (digits === undefined) return undefined;
  const n = Number(digits.replace(",", "."));
  return n > 0 ? n : undefined;
}

/**
 * An area per `capacity:<group>` tag: a count where it is one above 0,
 * presence only for `yes`; `no` and 0 are no area.
 */
function areasOf(tags: Record<string, string>): AreaInput[] {
  return AREA_TAGS.flatMap(([key, userGroup]) => {
    const value = tag(tags, key);
    const n = count(value);
    if (n !== undefined) return n > 0 ? [{ vehicleType: "car", userGroup, capacity: n }] : [];
    return value === "yes" ? [{ vehicleType: "car", userGroup }] : [];
  });
}

function typeOf(tags: Record<string, string>): ParkingSiteType {
  const parkRide = (tag(tags, "park_ride") ?? "").split(";").map((v) => v.trim());
  if (parkRide.some((v) => PARK_RIDE.has(v))) return "park_and_ride";
  return ON_STREET.has(tag(tags, "parking") ?? "") ? "on_street" : "off_street";
}

/**
 * OpenStreetMap car parks (`amenity=parking`) as Overpass answers for a cell,
 * nodes at their position and ways and relations at their centre. The site
 * id is the element (`way/<id>`), and its `osm:<type>` id the only id
 * linking matches on: the node and the way of one car park may link, two
 * ways may not. OSM holds no occupancy, so there are no readings. The address
 * is kept only when its tags name the country.
 */
export function parseOverpassParking(
  feed: ParkingCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  for (const payload of payloads["main"] ?? []) {
    for (const element of decodeOverpass(payload)) {
      const { tags } = element;
      if (tags["amenity"] !== "parking") continue;
      const type = typeOf(tags);
      const layout = LAYOUTS[tag(tags, "parking") ?? ""];
      const audience = AUDIENCE[tag(tags, "access") ?? ""];
      const country = tag(tags, "addr:country");
      const optional = <K extends keyof SiteInput>(key: K, value: SiteInput[K] | undefined) =>
        value === undefined ? {} : { [key]: value };
      const input: SiteInput = {
        stationId: `${element.type}/${element.id}`,
        providerId: false,
        point: [element.lon, element.lat],
        lang: UNDETERMINED,
        externalIds: [{ scheme: `osm:${element.type}`, id: String(element.id) }],
        type,
        ...optional("layout", layout),
        ...optional("name", tag(tags, "name")),
        ...optional("operator", tag(tags, "operator")),
        ...optional("website", tag(tags, "website") ?? tag(tags, "contact:website")),
        ...optional("openingHoursOsm", tag(tags, "opening_hours")),
        ...optional("audience", audience),
        ...(tag(tags, "fee") === "no" ? { free: true } : {}),
        ...optional("capacityTotal", count(tag(tags, "capacity"))),
        ...optional("heightLimitM", metres(tag(tags, "maxheight"))),
        ...(country === undefined
          ? {}
          : {
              address: {
                country,
                street: tag(tags, "addr:street"),
                houseNumber: tag(tags, "addr:housenumber"),
                postalCode: tag(tags, "addr:postcode"),
                city: tag(tags, "addr:city"),
              },
            }),
        areas: areasOf(tags),
        usage: type === "park_and_ride" ? ["park_and_ride"] : [],
      };
      out.features.push(siteDraft(feed, input, ctx.fetchedAt));
    }
  }
  return out;
}
