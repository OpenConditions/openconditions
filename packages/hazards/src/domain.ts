import {
  defineIngestDomain,
  type FeedFormat,
  type IngestDomain,
} from "@openconditions/ingest-framework";
import { type HazardsCatalogFeed, hazardsFeedShape } from "./feed-schema.js";
import { parseCap } from "./formats/cap.js";
import { parseEffis } from "./formats/effis.js";
import { parseEonet } from "./formats/eonet.js";
import { parseFirms } from "./formats/firms.js";
import { parseGdacs } from "./formats/gdacs.js";
import { parseHms } from "./formats/hms.js";
import { parseMeteoAlarm } from "./formats/meteoalarm.js";
import { parseNws } from "./formats/nws.js";
import { parseUsgs } from "./formats/usgs.js";
import { parseWfigs } from "./formats/wfigs.js";

/**
 * What a hazards feed publishes: authorities' warnings, wildfires, smoke,
 * earthquakes, and other natural events.
 */
export const HAZARDS_PRODUCTS = ["alerts", "fires", "smoke", "quakes", "events"] as const;

const FORMATS: FeedFormat<HazardsCatalogFeed>[] = [
  {
    id: "cap",
    kind: "situations",
    products: ["alerts"],
    // The CAP messages, the directory listing a walk over them reads, and
    // shapes for the areas they name only by warn cell.
    endpoints: {
      alerts: { required: true },
      index: { required: false },
      areas: { required: false },
    },
    parse: parseCap,
  },
  {
    id: "nws",
    kind: "situations",
    products: ["alerts"],
    // The active alerts, and the shapes of the zones the zone-only ones name.
    endpoints: { alerts: { required: true }, zones: { required: false } },
    parse: parseNws,
  },
  {
    id: "meteoalarm",
    kind: "situations",
    products: ["alerts"],
    // The countries' warnings, and MeteoAlarm's shapes for the regions they
    // name by EMMA id (other codes reach them through the vendored aliases).
    endpoints: { alerts: { required: true }, geocodes: { required: false } },
    parse: parseMeteoAlarm,
  },
  {
    id: "firms",
    kind: "measurements",
    products: ["fires"],
    endpoints: { main: { required: true } },
    parse: parseFirms,
  },
  {
    id: "wfigs",
    kind: "situations",
    products: ["fires"],
    // The mapped perimeters, and every reported incident with its point.
    endpoints: { perimeters: { required: false }, incidents: { required: true } },
    parse: parseWfigs,
  },
  {
    id: "effis",
    kind: "situations",
    products: ["fires"],
    endpoints: { main: { required: true } },
    parse: parseEffis,
  },
  {
    id: "hms",
    kind: "situations",
    products: ["smoke"],
    endpoints: { main: { required: true } },
    parse: parseHms,
  },
  {
    id: "usgs",
    kind: "situations",
    products: ["quakes"],
    // The last day, which is fresh, and the last month, which catches revisions and deletions.
    endpoints: { recent: { required: true }, window: { required: true } },
    parse: parseUsgs,
  },
  {
    id: "eonet",
    kind: "situations",
    products: ["events"],
    // The open events, and the ones closed lately, which carry the closing date.
    endpoints: { open: { required: true }, closed: { required: false } },
    parse: parseEonet,
  },
  {
    id: "gdacs",
    kind: "situations",
    products: ["events"],
    // The event list, and the CAP areas of the current episodes.
    endpoints: { events: { required: true }, areas: { required: false } },
    parse: parseGdacs,
  },
];

/**
 * The hazards domain: warnings authorities issue as CAP alerts, and hazard
 * events from authorities and satellites. The records are the hazards
 * model's kinds; the domain is where their feeds and formats live.
 */
export const hazardsDomain: IngestDomain<HazardsCatalogFeed> =
  defineIngestDomain<HazardsCatalogFeed>({
    id: "hazards",
    products: HAZARDS_PRODUCTS,
    feedShape: hazardsFeedShape,
    formats: Object.fromEntries(FORMATS.map((format) => [format.id, format])),
    resolvers: [],
  });
