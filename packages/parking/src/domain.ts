import {
  defineIngestDomain,
  type FeedDefinition,
  type FeedFormat,
  type IngestDomain,
} from "@openconditions/ingest-framework";
import {
  type ParkingCatalogFeed,
  type ParkingFeedExtension,
  parkingFeedShape,
} from "./feed-schema.js";
import { parseDatex2 } from "./formats/datex2.js";
import { parseDatex2Light } from "./formats/datex2-light.js";
import { parseDbBahnpark } from "./formats/db-bahnpark.js";
import { parseHdb } from "./formats/hdb.js";
import { PARKING_LAYOUT_FORMATS, parseLayout } from "./formats/layout.js";
import { parseOpendatahub } from "./formats/opendatahub.js";
import { parseOverpassParking } from "./formats/overpass.js";
import { parseParkApiV3 } from "./formats/parkapi-v3.js";
import { parseRdw } from "./formats/rdw.js";
import { parseSbb } from "./formats/sbb.js";
import { parseTfnsw } from "./formats/tfnsw.js";
import { parseUtmc } from "./formats/utmc.js";

/** What a parking feed publishes: parking sites, their occupancy and their rates. */
export const PARKING_PRODUCTS = ["parking"] as const;

/** The records every parking format emits, which on-demand routing reads. */
const PRODUCES = {
  kinds: ["parking_site", "parking_rate"],
  properties: [
    "parking.available",
    "parking.occupied",
    "parking.occupancy_pct",
    "parking.status",
    "parking.trend",
  ],
} as const;

/** A format of parking sites, read from one `main` payload unless it names its roles. */
function sites(
  id: string,
  parse: FeedFormat<ParkingCatalogFeed>["parse"],
  endpoints: FeedFormat<ParkingCatalogFeed>["endpoints"] = { main: { required: true } },
): FeedFormat<ParkingCatalogFeed> {
  return {
    id,
    kind: "features",
    products: PARKING_PRODUCTS,
    produces: PRODUCES,
    endpoints,
    parse,
  };
}

/** A site table and the live state of its sites, polled at their own cadences. */
const LIVE_SITES: FeedFormat<ParkingCatalogFeed>["endpoints"] = {
  sites: { required: true },
  status: { required: true },
};

const FORMATS: FeedFormat<ParkingCatalogFeed>[] = [
  ...PARKING_LAYOUT_FORMATS.map((id) => sites(id, parseLayout)),
  // The site list, and the upstream sources that type and credit its sites.
  sites("parkapi-v3", parseParkApiV3, {
    main: { required: true },
    sources: { required: true },
  }),
  sites("datex2", parseDatex2, LIVE_SITES),
  sites("datex2-light", parseDatex2Light),
  sites("overpass", parseOverpassParking),
  sites("db-bahnpark", parseDbBahnpark),
  // The specifications, joined to the garage, P+R and carpool area datasets.
  sites("rdw", parseRdw, { specs: { required: true }, areas: { required: true } }),
  sites("sbb", parseSbb),
  sites("opendatahub", parseOpendatahub, LIVE_SITES),
  sites("hdb", parseHdb, LIVE_SITES),
  sites("utmc", parseUtmc, LIVE_SITES),
  sites("tfnsw", parseTfnsw),
];

const LAYOUTS: ReadonlySet<string> = new Set(PARKING_LAYOUT_FORMATS);

/**
 * A feed in a generic layout is read only through its `layout` block and its
 * `parking` mapping, so both must be written; the feed shape cannot require
 * a field for some formats only.
 */
function lintFeed(feed: FeedDefinition): string[] {
  if (!LAYOUTS.has(feed.format)) return [];
  const own = feed as FeedDefinition & ParkingFeedExtension;
  return [
    ...(own.layout === undefined ? [`format ${feed.format} needs a layout block`] : []),
    ...(own.parking === undefined ? [`format ${feed.format} needs a parking mapping`] : []),
  ];
}

/**
 * The parking domain: car parks, garages and lorry parks, with their live
 * occupancy and their rates.
 */
export const parkingDomain: IngestDomain<ParkingCatalogFeed> =
  defineIngestDomain<ParkingCatalogFeed>({
    id: "parking",
    products: PARKING_PRODUCTS,
    feedShape: parkingFeedShape,
    formats: Object.fromEntries(FORMATS.map((format) => [format.id, format])),
    resolvers: [],
    lintFeed,
  });
