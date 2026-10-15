import {
  defineIngestDomain,
  type FeedFormat,
  type IngestDomain,
} from "@openconditions/ingest-framework";
import { type BorderCatalogFeed, borderFeedShape } from "./feed-schema.js";
import { parseCbp } from "./formats/cbp.js";
import { parseCbsa } from "./formats/cbsa.js";

/** What a border feed publishes: crossings and how long their queues are. */
export const BORDER_PRODUCTS = ["waits"] as const;

/**
 * The records every border format emits, which on-demand routing reads: the
 * crossings, their queues, the waits in them and whether the crossing is open.
 */
const PRODUCES = {
  kinds: ["border_crossing", "lane_group"],
  properties: ["border.wait", "facility.open_status"],
} as const;

/** A format of one agency's wait times, read from one `main` payload. */
function waits(
  id: string,
  parse: FeedFormat<BorderCatalogFeed>["parse"],
): FeedFormat<BorderCatalogFeed> {
  return {
    id,
    kind: "features",
    products: BORDER_PRODUCTS,
    produces: PRODUCES,
    endpoints: { main: { required: true } },
    parse,
  };
}

const FORMATS: FeedFormat<BorderCatalogFeed>[] = [
  waits("cbp-bwt", parseCbp),
  waits("cbsa-bwt", parseCbsa),
];

/**
 * The border domain: land border crossings and the waits their inspecting
 * agencies publish for each queue. The records are the border model's kinds;
 * the domain is where their feeds and formats live.
 */
export const borderDomain: IngestDomain<BorderCatalogFeed> = defineIngestDomain<BorderCatalogFeed>({
  id: "border",
  products: BORDER_PRODUCTS,
  feedShape: borderFeedShape,
  formats: Object.fromEntries(FORMATS.map((format) => [format.id, format])),
  resolvers: [],
});
