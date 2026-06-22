import type { SourceFormat } from "@openconditions/core";
import { parseDatexSituations } from "./datex.js";
import { parseOpen511 } from "./open511.js";
import { parseWzdx } from "./wzdx.js";
import { parseAutobahn } from "./autobahn.js";
import { parseDigitraffic } from "./digitraffic.js";
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
  url: string | ((env: Record<string, string | undefined>) => string) | string[];
  auth?: {
    kind: "none" | "query-key" | "header-key" | "token";
    envVar?: string;
  };
  bbox?: [number, number, number, number];
  cadenceSec: number;
  freshnessWindowSec: number;
  gzip?: boolean;
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
    // Curated set of major autobahns; dynamic enumeration of the full road list is a follow-up.
    url: [
      "https://verkehr.autobahn.de/o/autobahn/A1/services/warning",
      "https://verkehr.autobahn.de/o/autobahn/A2/services/warning",
      "https://verkehr.autobahn.de/o/autobahn/A3/services/warning",
      "https://verkehr.autobahn.de/o/autobahn/A4/services/warning",
      "https://verkehr.autobahn.de/o/autobahn/A5/services/warning",
      "https://verkehr.autobahn.de/o/autobahn/A6/services/warning",
      "https://verkehr.autobahn.de/o/autobahn/A7/services/warning",
      "https://verkehr.autobahn.de/o/autobahn/A8/services/warning",
      "https://verkehr.autobahn.de/o/autobahn/A9/services/warning",
      "https://verkehr.autobahn.de/o/autobahn/A10/services/warning",
    ],
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
    // WZDx registry-driven expansion (one registry pull → N sub-feeds) is a follow-up; the parser is ready.
    url: [],
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "CC0-1.0",
    attribution: "WZDx publishers",
    country: "US",
    privacyUrl: "https://www.transportation.gov/privacy",
    enabledByDefault: false,
  },
];

type ParserFn = typeof parseDatexSituations;

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
