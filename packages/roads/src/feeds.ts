import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SourceFormat } from "@openconditions/core";
import type { FeedAuth, FeedSourceBase } from "@openconditions/ingest-framework";
import { loadFeedFiles } from "@openconditions/ingest-framework";
import type { GeoJsonMapping } from "./model.js";
import type { SiteGeometry } from "./siteTable.js";
import { roadFeedSchema } from "./feed-schema.js";
import { parseDatexSituations } from "./datex.js";
import { parseGeoJson } from "./geojson.js";
import { parseFlatJson } from "./flatjson.js";
import { parseTrafikverket } from "./trafikverket.js";
import { parseIbi511 } from "./ibi511.js";
import { parseGddkia } from "./gddkia.js";
import { parseLtaIncidents } from "./lta.js";
import { parseOpen511 } from "./open511.js";
import { parseWzdx } from "./wzdx.js";
import { parseAutobahn } from "./autobahn.js";
import { parseDigitraffic } from "./digitraffic.js";
import { parseDigitrafficFlow, parseDatexMeasuredData } from "./flow.js";
import type { FlowParseResult } from "./flow.js";
import { parseFintrafficFlow } from "./flow-fintraffic.js";
import type { SourceDescriptor } from "./types.js";

// FeedAuth now lives in @openconditions/ingest-framework; re-exported here so
// existing consumers of @openconditions/roads are unaffected.
export type { FeedAuth };

/**
 * Describes a remote data feed that the ingest service polls periodically.
 * Extends the domain-agnostic {@link FeedSourceBase} (id, name, format, auth,
 * cadence, license, `url` template(s), `expandEnv`, `bodyTemplate`, `catalog`,
 * etc. — see `@openconditions/ingest-framework`) with the road-specific mapping
 * fields. All feed transport is now pure data.
 */
export type FeedSource = FeedSourceBase & {
  format: SourceFormat;
  /**
   * A companion DATEX II MeasurementSiteTablePublication that supplies the
   * geometry for measurement sites keyed only by id in the data feed (the NDW
   * layout). The ingest service fetches and caches it, then joins it into the
   * flow parser. Only meaningful for `produces: "flow"` datex2 feeds.
   *
   * Set `gzip: true` when the URL serves a gzip-compressed body (e.g. an
   * `.xml.gz` file). The streaming site-table loader honours this flag and does
   * NOT magic-byte-sniff the response, so a gzipped body without `gzip: true`
   * would stream corrupt bytes into the parser (yielding an empty map).
   */
  siteTable?: { url: string; gzip?: boolean };
  /**
   * A JSON/GeoJSON station registry supplying Point geometry for flow feeds
   * keyed only by station id (Fintraffic, WebTRIS). The ingest service fetches
   * it (egress-guarded, cached) and joins it into the flow parser as its
   * siteMap — the JSON counterpart to the DATEX `siteTable`.
   */
  stationRegistry?: { url: string; format: "fintraffic-stations" | "webtris-sites" };
  /** Field mapping for `format: "geojson"` feeds (passed to the generic reader). */
  geojson?: GeoJsonMapping;
  /**
   * For `datex2` feeds whose GML `posList` is "lon lat" rather than the WGS84
   * "lat lon" default (e.g. Trafikverket). Passed through to the parser.
   */
  posListLonLat?: boolean;
  bbox?: [number, number, number, number];
  /**
   * Marks a reference-only feed whose records carry OpenLR but no coordinate, so
   * the ingest resolve stage map-matches them via the openlr-resolver service.
   * No current feed sets this: the open feeds we ingest carry coordinates or
   * Alert-C/TMC, not OpenLR (which is largely a commercial-feed scheme). The
   * resolver is ready infrastructure awaiting such a source — see
   * services/openlr-resolver/README.md "Status".
   */
  openlrResolver?: boolean;
};

/**
 * Resolves the feed data directory relative to the running module, tolerating
 * both layouts this code runs in (mirrors core's migrations-folder resolution):
 *  - workspace/published package: `dist/index.js` (or `src/feeds.ts` in dev/test)
 *    → `../feeds/roads` sibling, shipped via the package `files` allowlist;
 *  - inlined into the ingest bundle: the ingest build copies `feeds/roads/` next
 *    to its entry, so `./feeds/roads` resolves there.
 */
function resolveFeedsDir(): string {
  const candidates = ["../feeds/roads", "./feeds/roads"].map((rel) =>
    fileURLToPath(new URL(rel, import.meta.url))
  );
  const found = candidates.find(existsSync);
  if (!found) {
    throw new Error(`roads feed data dir not found (looked in: ${candidates.join(", ")})`);
  }
  return found;
}

/**
 * All registered feed sources, loaded from the per-country JSON5 data files
 * under `feeds/roads/` and validated against {@link roadFeedSchema} at load.
 * `format` is validated as a non-empty string here and keyed into `parserFor`
 * (which throws on an unknown format), so the narrowing to `SourceFormat` is a
 * schema-guarded assertion rather than an unchecked cast.
 */
export const FEED_SOURCES: FeedSource[] = loadFeedFiles(
  resolveFeedsDir(),
  roadFeedSchema
) as FeedSource[];

type ParserFn = typeof parseDatexSituations;
type FlowParserFn = (
  input: string | Buffer,
  src: SourceDescriptor,
  siteMap?: Map<string, SiteGeometry>
) => FlowParseResult;

/**
 * Returns the parser function for a given source format.
 * Throws for any format not yet supported.
 */
export function parserFor(format: SourceFormat): ParserFn {
  if (format === "datex2") return parseDatexSituations;
  if (format === "open511") return parseOpen511;
  if (format === "wzdx") return parseWzdx;
  if (format === "geojson") return parseGeoJson;
  if (format === "ibi511-json") return parseIbi511 as ParserFn;
  if (format === "lta-json") return parseLtaIncidents as ParserFn;
  if (format === "gddkia-xml") return parseGddkia;
  if (format === "flatjson") return parseFlatJson as ParserFn;
  if (format === "trafikverket-json") return parseTrafikverket as ParserFn;
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
  if (format === "fintraffic-tms-json") return parseFintrafficFlow;
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
    ...(feed.geojson ? { geojson: feed.geojson } : {}),
    ...(feed.posListLonLat ? { posListLonLat: true } : {}),
  };
}
