import type { SourceFormat } from "@openconditions/core";
import { parseDatexSituations } from "./datex.js";
import { parseOpen511 } from "./open511.js";
import { parseWzdx } from "./wzdx.js";
import { parseAutobahn } from "./autobahn.js";
import { parseDigitraffic } from "./digitraffic.js";
import { parseDigitrafficFlow, parseDatexMeasuredData } from "./flow.js";
import type { FlowParseResult } from "./flow.js";
import { discoverAutobahnRoads, discoverWzdxFeeds } from "./discover.js";
import type { SourceDescriptor } from "./types.js";

/**
 * Describes a remote data feed that the ingest service polls periodically.
 *
 * `url` may be:
 *  - a static string (most feeds)
 *  - a function receiving the runtime env (for feeds needing an API key in the URL)
 *  - a string array (for feeds served as multiple regional files)
 */
export interface FeedSource {
  id: string;
  name: string;
  format: SourceFormat;
  /**
   * Declares what this feed produces:
   *   "events" (default) — the parser returns Observation[] directly (RoadEvent etc.)
   *   "flow"             — the parser returns FlowParseResult; both the RoadFlow
   *                        measurements and the derived congestion RoadEvents are
   *                        flattened into the pipeline's Observation[] output.
   *
   * Each flow feed must carry its own unique `id` so atomicSwap (which is
   * source-id–scoped) never collides with an event feed from the same provider.
   */
  produces?: "events" | "flow";
  /**
   * The feed's URL(s). Optional when `discover` is set (the URL set is then
   * resolved dynamically at fetch time). When both are present, `discover` wins.
   */
  url?: string | ((env: Record<string, string | undefined>) => string) | string[];
  /**
   * Resolves the concrete URL set to fetch at request time (e.g. enumerate
   * every motorway, or pull a feed registry). The ingest service fans the
   * returned URLs out with bounded concurrency and per-URL tolerance, so one
   * failing sub-feed never wipes the source.
   */
  discover?: (fetchFn: typeof fetch) => Promise<string[]>;
  auth?: {
    kind: "none" | "query-key" | "header-key" | "token";
    envVar?: string;
  };
  bbox?: [number, number, number, number];
  cadenceSec: number;
  freshnessWindowSec: number;
  gzip?: boolean;
  /**
   * Marks a reference-only feed whose records carry OpenLR but no coordinate, so
   * the ingest resolve stage map-matches them via the openlr-resolver service.
   * No current feed sets this: the open feeds we ingest carry coordinates or
   * Alert-C/TMC, not OpenLR (which is largely a commercial-feed scheme). The
   * resolver is ready infrastructure awaiting such a source — see
   * services/openlr-resolver/README.md "Status".
   */
  openlrResolver?: boolean;
  license: string;
  licenseUrl?: string;
  attribution: string;
  country: string;
  privacyUrl: string;
  enabledByDefault: boolean;
}

/**
 * All registered feed sources.
 */
export const FEED_SOURCES: FeedSource[] = [
  {
    id: "ndw",
    name: "NDW (Netherlands)",
    format: "datex2",
    url: "http://opendata.ndw.nu/actueel_beeld.xml.gz",
    gzip: true,
    cadenceSec: 60,
    freshnessWindowSec: 300,
    license: "CC0-1.0",
    licenseUrl: "https://www.ndw.nu",
    attribution: "NDW / Rijkswaterstaat",
    country: "NL",
    privacyUrl: "https://www.ndw.nu/privacy",
    enabledByDefault: true,
  },
  {
    id: "drivebc",
    name: "DriveBC (British Columbia)",
    format: "open511",
    url: "https://api.open511.gov.bc.ca/events?format=json",
    cadenceSec: 120,
    freshnessWindowSec: 600,
    license: "OGL-BC",
    attribution:
      "Contains information licensed under the Open Government Licence – British Columbia",
    country: "CA",
    privacyUrl: "https://www2.gov.bc.ca/gov/content/home/privacy",
    enabledByDefault: true,
  },
  {
    id: "digitraffic-fi",
    name: "Digitraffic (Finland)",
    format: "digitraffic-json",
    url: [
      "https://tie.digitraffic.fi/api/traffic-message/v1/messages?inactiveHours=0&includeAreaGeometry=false&situationType=TRAFFIC_ANNOUNCEMENT",
      "https://tie.digitraffic.fi/api/traffic-message/v1/messages?inactiveHours=0&includeAreaGeometry=false&situationType=ROAD_WORK",
    ],
    cadenceSec: 120,
    freshnessWindowSec: 600,
    license: "CC-BY-4.0",
    attribution: "Fintraffic / Digitraffic",
    country: "FI",
    privacyUrl: "https://www.fintraffic.fi/en/fintraffic/data-protection",
    enabledByDefault: true,
  },
  {
    id: "autobahn-de",
    name: "Autobahn GmbH (Germany)",
    format: "autobahn-json",
    discover: discoverAutobahnRoads,
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "dl-de/by-2-0",
    attribution: "Quelle: Die Autobahn GmbH des Bundes",
    country: "DE",
    privacyUrl: "https://www.autobahn.de/datenschutz",
    enabledByDefault: true,
  },
  {
    id: "wzdx",
    name: "WZDx (United States)",
    format: "wzdx",
    discover: discoverWzdxFeeds,
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    attribution: "WZDx publishers",
    country: "US",
    privacyUrl: "https://www.transportation.gov/privacy",
    enabledByDefault: true,
  },
  {
    // Separate source id from "digitraffic-fi" (events) so that atomicSwap
    // stays source-id–scoped and the two feeds never clobber each other's rows.
    id: "digitraffic-fi-flow",
    name: "Digitraffic traffic flow (Finland)",
    format: "digitraffic-json",
    produces: "flow",
    // The /traffic-datex2/flow-data path strongly suggests this endpoint
    // returns DATEX II XML (MeasuredDataPublication), not Digitraffic GeoJSON.
    // This feed is disabled by default and has NOT been verified. Before
    // enabling: fetch the endpoint, confirm the Content-Type and payload shape,
    // and switch `format` to "datex2" if it is DATEX II XML (which routes to
    // parseDatexMeasuredData). Leaving it as "digitraffic-json" while disabled
    // preserves existing behaviour but would parse incorrectly if activated.
    url: "https://tie.digitraffic.fi/api/traffic-message/v1/traffic-datex2/flow-data",
    cadenceSec: 60,
    freshnessWindowSec: 300,
    license: "CC-BY-4.0",
    attribution: "Fintraffic / Digitraffic",
    country: "FI",
    privacyUrl: "https://www.fintraffic.fi/en/fintraffic/data-protection",
    enabledByDefault: false,
  },
];

type ParserFn = typeof parseDatexSituations;
type FlowParserFn = (input: string | Buffer, src: SourceDescriptor) => FlowParseResult;

/**
 * Returns the parser function for a given source format.
 * Throws for any format not yet supported.
 */
export function parserFor(format: SourceFormat): ParserFn {
  if (format === "datex2") return parseDatexSituations;
  if (format === "open511") return parseOpen511;
  if (format === "wzdx") return parseWzdx;
  if (format === "autobahn-json") return parseAutobahn;
  if (format === "digitraffic-json") return parseDigitraffic;
  throw new Error(`No parser registered for format: ${format}`);
}

/**
 * Returns the flow parser function for a given source format.
 * Throws when no flow parser is registered for the format.
 */
export function flowParserFor(format: SourceFormat): FlowParserFn {
  if (format === "digitraffic-json") return parseDigitrafficFlow;
  if (format === "datex2") return parseDatexMeasuredData;
  throw new Error(`No flow parser registered for format: ${format}`);
}

/**
 * Maps a FeedSource to the minimal SourceDescriptor that parsers receive at
 * call time. Keeps parsers decoupled from the full feed registry shape.
 */
export function feedToSourceDescriptor(feed: FeedSource): SourceDescriptor {
  return {
    id: feed.id,
    attribution: feed.attribution,
    country: feed.country,
    license: feed.license,
    licenseUrl: feed.licenseUrl,
  };
}
