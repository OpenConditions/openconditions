import type { SourceFormat } from "@openconditions/core";
import { parseDatexSituations } from "./datex.js";
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
 * All registered feed sources. Only NDW is included in this initial slice;
 * additional feeds (Autobahn, Digitraffic, DriveBC, WZDx) are added as their
 * parsers land.
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
];

type ParserFn = typeof parseDatexSituations;

/**
 * Returns the parser function for a given source format.
 * Throws for any format not yet supported in this slice.
 */
export function parserFor(format: SourceFormat): ParserFn {
  if (format === "datex2") return parseDatexSituations;
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
