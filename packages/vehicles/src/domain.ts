import {
  defineIngestDomain,
  type FeedFormat,
  type IngestDomain,
} from "@openconditions/ingest-framework";
import { type VehiclesCatalogFeed, vehiclesFeedShape } from "./feed-schema.js";
import { parseDigitrafficMaintenance } from "./formats/digitraffic.js";

/** What a vehicles feed publishes: where road maintenance fleets are and what they do. */
export const VEHICLES_PRODUCTS = ["maintenance"] as const;

const FORMATS: FeedFormat<VehiclesCatalogFeed>[] = [
  {
    id: "digitraffic",
    kind: "measurements",
    products: ["maintenance"],
    // Off season and at night no vehicle may be out.
    mayBeEmpty: true,
    // Each poll states every vehicle's latest position, so the place a vehicle left is no longer one.
    restatesTransient: true,
    endpoints: { main: { required: true } },
    parse: parseDigitrafficMaintenance,
  },
];

/**
 * The vehicles domain: the positions and work of the service vehicles an
 * authority tracks, as `@openconditions/model-vehicles` models them.
 */
export const vehiclesDomain: IngestDomain<VehiclesCatalogFeed> =
  defineIngestDomain<VehiclesCatalogFeed>({
    id: "vehicles",
    products: VEHICLES_PRODUCTS,
    feedShape: vehiclesFeedShape,
    formats: Object.fromEntries(FORMATS.map((format) => [format.id, format])),
    resolvers: [],
  });
