import {
  type CatalogFeed,
  defineIngestDomain,
  type FeedFormat,
  feedBaseShape,
  type IngestDomain,
} from "@openconditions/ingest-framework";
import { parseEcontrol } from "./formats/econtrol.js";
import { parseMinetur } from "./formats/minetur.js";
import { parseOverpassFuel } from "./formats/overpass.js";
import { parsePrixCarburants } from "./formats/prix-carburants.js";
import { parseTankerkoenig } from "./formats/tankerkoenig.js";

/** What a fuel feed publishes: filling stations with their products, prices and stock. */
export const FUEL_PRODUCTS = ["fuel"] as const;

/** The records every fuel format emits, which on-demand routing reads. */
const PRODUCES = {
  kinds: ["fuel_station"],
  properties: ["fuel.price", "fuel.product_available"],
} as const;

/**
 * A format of stations: a bulk poll's complete set, or an on-demand answer
 * for one cell.
 */
function stations(id: string, parse: FeedFormat["parse"]): FeedFormat {
  return {
    id,
    kind: "features",
    products: FUEL_PRODUCTS,
    produces: PRODUCES,
    endpoints: { main: { required: true } },
    parse,
  };
}

const FORMATS: FeedFormat[] = [
  stations("minetur", parseMinetur),
  stations("prix-carburants", parsePrixCarburants),
  stations("tankerkoenig", parseTankerkoenig),
  stations("econtrol", parseEcontrol),
  stations("overpass", parseOverpassFuel),
];

/**
 * The fuel domain: filling stations and what their products cost, from
 * national price feeds and, read on demand, price services and OpenStreetMap.
 */
export const fuelDomain: IngestDomain<CatalogFeed> = defineIngestDomain<CatalogFeed>({
  id: "fuel",
  products: FUEL_PRODUCTS,
  feedShape: feedBaseShape,
  formats: Object.fromEntries(FORMATS.map((format) => [format.id, format])),
  resolvers: [],
});
