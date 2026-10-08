import {
  defineIngestDomain,
  type FeedDefinition,
  type FeedFormat,
  type IngestDomain,
} from "@openconditions/ingest-framework";
import {
  type ChargingCatalogFeed,
  type ChargingFeedExtension,
  chargingFeedShape,
} from "./feed-schema.js";
import { parseAfdc } from "./formats/afdc.js";
import { parseBnetza } from "./formats/bnetza.js";
import { parseChargy } from "./formats/chargy.js";
import { parseCynap } from "./formats/cynap.js";
import { parseDatex2, parseDatex2Status } from "./formats/datex2.js";
import { parseDigitraffic, parseDigitrafficStatus } from "./formats/digitraffic.js";
import { parseEipa, parseEipaStatus } from "./formats/eipa.js";
import { parseEvroam } from "./formats/evroam.js";
import { parseIrve, parseIrveStatus } from "./formats/irve.js";
import { parseKeco, parseKecoStatus } from "./formats/keco.js";
import { CHARGING_LAYOUT_FORMATS, parseLayout } from "./formats/layout.js";
import { parseLta } from "./formats/lta.js";
import { parseNobil } from "./formats/nobil.js";
import { parseOcm } from "./formats/ocm.js";
import { parseOcpi, parseOcpiStatus } from "./formats/ocpi.js";
import { parseOicp, parseOicpStatus } from "./formats/oicp.js";
import { parseOverpassCharging } from "./formats/overpass.js";
import { parseTdx, parseTdxStatus } from "./formats/tdx.js";

/** What a charging feed publishes: charging sites, their charge points' status and tariffs. */
export const CHARGING_PRODUCTS = ["charging"] as const;

/** The records every charging format emits, which on-demand routing reads. */
const PRODUCES = {
  kinds: ["charging_site", "evse", "connector", "energy_tariff"],
  properties: ["charging.evse_status", "charging.connector_status"],
} as const;

/**
 * A format of charging sites, read from one `main` payload unless it names
 * its roles; one with a live status role reads that role alone too.
 */
function sites(
  id: string,
  parse: FeedFormat<ChargingCatalogFeed>["parse"],
  endpoints: FeedFormat<ChargingCatalogFeed>["endpoints"] = { main: { required: true } },
  parseStatus?: FeedFormat<ChargingCatalogFeed>["parseStatus"],
): FeedFormat<ChargingCatalogFeed> {
  return {
    id,
    kind: "features",
    products: CHARGING_PRODUCTS,
    produces: PRODUCES,
    endpoints,
    parse,
    ...(parseStatus === undefined ? {} : { parseStatus }),
  };
}

const optional = { required: false } as const;
/** The charge points' live states, polled more often than the rest. */
const liveStatus = { required: false, status: true } as const;

const FORMATS: FeedFormat<ChargingCatalogFeed>[] = [
  ...CHARGING_LAYOUT_FORMATS.map((id) => sites(id, parseLayout)),
  // The locations, their EVSEs' live states by uid where the locations are
  // polled slower, the tariffs, and OCPDB's tariff associations and sources.
  sites(
    "ocpi",
    parseOcpi,
    {
      main: { required: true },
      status: liveStatus,
      tariffs: optional,
      associations: optional,
      sources: optional,
    },
    parseOcpiStatus,
  ),
  sites("oicp", parseOicp, { main: { required: true }, status: liveStatus }, parseOicpStatus),
  sites("datex2", parseDatex2, { main: { required: true }, status: liveStatus }, parseDatex2Status),
  sites(
    "digitraffic",
    parseDigitraffic,
    { main: { required: true }, status: liveStatus, tariffs: optional },
    parseDigitrafficStatus,
  ),
  sites("overpass", parseOverpassCharging),
  sites("bnetza", parseBnetza),
  // The static consolidation, and the dynamic one's status per charge point.
  sites("irve", parseIrve, { main: { required: true }, status: liveStatus }, parseIrveStatus),
  sites("afdc", parseAfdc),
  sites("nobil", parseNobil),
  // The reader's files: pools are the sites, the other files join to them;
  // `dynamic.json` adds each point's state (and its prices, read in full only).
  sites(
    "eipa",
    parseEipa,
    {
      pools: { required: true },
      stations: { required: true },
      points: { required: true },
      operators: optional,
      dictionary: optional,
      status: liveStatus,
    },
    parseEipaStatus,
  ),
  sites("cynap", parseCynap),
  // One KML, sites and every connector's live state together.
  sites("chargy", parseChargy),
  sites("evroam", parseEvroam),
  // The charger information pages, and the chargers whose state just changed:
  // each status answer holds only the last minutes' changes, so every answer
  // since the information was fetched is read.
  sites(
    "keco",
    parseKeco,
    {
      main: { required: true },
      // `period=10`, the longest window the API allows.
      status: { ...liveStatus, accumulatesSince: "main", changesWindowSec: 600 },
    },
    parseKecoStatus,
  ),
  // The batch file the DataMall link names, sites, prices and states together.
  sites("lta", parseLta),
  // Per city: the stations, the rates per connector, the connectors' live states.
  sites(
    "tdx",
    parseTdx,
    { sites: { required: true }, tariffs: optional, status: liveStatus },
    parseTdxStatus,
  ),
  // Per grid cell, full objects.
  sites("ocm", parseOcm),
];

const LAYOUTS: ReadonlySet<string> = new Set(CHARGING_LAYOUT_FORMATS);

/**
 * A feed in a generic layout is read only through its `layout` block and its
 * `charging` mapping, so both must be written; the feed shape cannot require
 * a field for some formats only.
 */
function lintFeed(feed: FeedDefinition): string[] {
  if (!LAYOUTS.has(feed.format)) return [];
  const own = feed as FeedDefinition & ChargingFeedExtension;
  return [
    ...(own.layout === undefined ? [`format ${feed.format} needs a layout block`] : []),
    ...(own.charging === undefined ? [`format ${feed.format} needs a charging mapping`] : []),
  ];
}

/**
 * The charging domain: where an electric vehicle can charge, what each
 * charge point is doing and what charging costs.
 */
export const chargingDomain: IngestDomain<ChargingCatalogFeed> =
  defineIngestDomain<ChargingCatalogFeed>({
    id: "charging",
    products: CHARGING_PRODUCTS,
    feedShape: chargingFeedShape,
    formats: Object.fromEntries(FORMATS.map((format) => [format.id, format])),
    resolvers: [],
    lintFeed,
  });
