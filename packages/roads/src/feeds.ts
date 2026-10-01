import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FeedAuth, FeedSourceBase } from "@openconditions/ingest-framework";
import { loadFeedFiles } from "@openconditions/ingest-framework";
import { parseAutobahn } from "./autobahn.js";
import { parseDatexSituations } from "./datex.js";
import { parseDigitraffic } from "./digitraffic.js";
import { roadFeedSchema } from "./feed-schema.js";
import { parseFlatJson } from "./flatjson.js";
import type { FlowParseResult } from "./flow.js";
import { parseDatexMeasuredData, parseDigitrafficFlow } from "./flow.js";
import { parseBcnTramsFlow } from "./flow-bcn.js";
import { parseBonnFlow } from "./flow-bonn.js";
import { parseElaboratedFlow } from "./flow-elaborated.js";
import { parseFintrafficFlow } from "./flow-fintraffic.js";
import { parseGeojsonFlow } from "./flow-geojson.js";
import { parseLtaSpeedBands } from "./flow-lta-speedbands.js";
import { parseMadridFlow } from "./flow-madrid.js";
import { parseNycDotFlow } from "./flow-nycdot.js";
import { parseOhgoFlow } from "./flow-ohgo.js";
import { parseTrafikverketFlow } from "./flow-trafikverket.js";
import { parseTurinFlow } from "./flow-turin.js";
import { parseWebtrisFlow } from "./flow-webtris.js";
import { parseGddkia } from "./gddkia.js";
import { parseGeoJson } from "./geojson.js";
import { parseHkRawFlow } from "./hk.js";
import { parseIbi511, parseIbi511Conditions } from "./ibi511.js";
import { parseLtaIncidents } from "./lta.js";
import { parseMivFlow } from "./miv.js";
import type { GeoJsonMapping } from "./model.js";
import { parseOhgoEvents } from "./ohgo-events.js";
import { parseOpen511 } from "./open511.js";
import type { SiteGeometry } from "./siteTable.js";
import { parseTrafikverket } from "./trafikverket.js";
import type { GeojsonFlowMapping, SourceDescriptor } from "./types.js";
import { parseVicDisruptions } from "./vic-disruptions.js";
import { parseWzdx } from "./wzdx.js";

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
  format: RoadSourceFormat;
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
  siteTable?: {
    url: string;
    gzip?: boolean;
    format?: "datex-site-table" | "datex-predefined-locations";
    reference?: SiteTableReference;
  };
  /**
   * A JSON/GeoJSON station registry supplying Point geometry for flow feeds
   * keyed only by station id (Fintraffic, WebTRIS). The ingest service fetches
   * it (egress-guarded, cached) and joins it into the flow parser as its
   * siteMap — the JSON counterpart to the DATEX `siteTable`.
   */
  stationRegistry?: {
    url: string;
    format:
      | "fintraffic-stations"
      | "webtris-sites"
      | "miv-config"
      | "france-comptage-csv"
      | "hk-detector-csv"
      | "bcn-trams-csv";
  };
  /** Field mapping for `format: "geojson"` feeds (passed to the generic reader). */
  geojson?: GeoJsonMapping;
  /** Field mapping for `format: "geojson-flow"` feeds (passed to the generic reader). */
  flowMap?: GeojsonFlowMapping;
  /**
   * For `datex2` feeds whose GML `posList` is "lon lat" rather than the WGS84
   * "lat lon" default (e.g. Trafikverket). Passed through to the parser.
   */
  posListLonLat?: boolean;
  /**
   * CRS for `datex2` feeds publishing a projected grid that declare no
   * `srsName` in the payload (e.g. Mecklenburg-Vorpommern's UTM zone 33).
   * Passed through to the parser.
   */
  srsName?: string;
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

/** A provider-specific description of how to check a versioned site table. */
export interface SiteTableReference {
  kind: "mobilithek";
  offerId: string;
  fileNamePrefix: string;
}

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
    fileURLToPath(new URL(rel, import.meta.url)),
  );
  const found = candidates.find(existsSync);
  if (!found) {
    throw new Error(`roads feed data dir not found (looked in: ${candidates.join(", ")})`);
  }
  return found;
}

type ParserFn = typeof parseDatexSituations;
type FlowParserFn = (
  input: string | Buffer,
  src: SourceDescriptor,
  siteMap?: Map<string, SiteGeometry>,
) => FlowParseResult;

const EVENT_PARSERS = {
  datex2: parseDatexSituations,
  open511: parseOpen511,
  wzdx: parseWzdx,
  geojson: parseGeoJson,
  ibi511: parseIbi511 as ParserFn,
  lta: parseLtaIncidents as ParserFn,
  gddkia: parseGddkia,
  flatjson: parseFlatJson as ParserFn,
  trafikverket: parseTrafikverket as ParserFn,
  autobahn: parseAutobahn,
  digitraffic: parseDigitraffic,
  "ohgo-events": parseOhgoEvents as ParserFn,
  "vic-disruptions": parseVicDisruptions as ParserFn,
  "ibi511-conditions": parseIbi511Conditions as ParserFn,
} satisfies Record<string, ParserFn>;

const FLOW_PARSERS = {
  digitraffic: parseDigitrafficFlow,
  datex2: parseDatexMeasuredData,
  "datex-elaborated": parseElaboratedFlow,
  "fintraffic-tms": parseFintrafficFlow,
  webtris: parseWebtrisFlow,
  "nyc-dot": parseNycDotFlow,
  ohgo: parseOhgoFlow,
  "trafikverket-flow": parseTrafikverketFlow,
  bonn: parseBonnFlow,
  informo: parseMadridFlow,
  "lta-speedbands": parseLtaSpeedBands,
  miv: parseMivFlow,
  fdt: parseTurinFlow,
  "hk-td": parseHkRawFlow,
  "geojson-flow": parseGeojsonFlow,
  "bcn-trams": parseBcnTramsFlow,
} satisfies Record<string, FlowParserFn>;

/** A wire format some roads parser reads — the roads contribution to `source_format`. */
export type RoadSourceFormat = keyof typeof EVENT_PARSERS | keyof typeof FLOW_PARSERS;

/** Every roads wire format, sorted. */
export const ROAD_SOURCE_FORMATS = [
  ...new Set([...Object.keys(EVENT_PARSERS), ...Object.keys(FLOW_PARSERS)]),
].sort() as RoadSourceFormat[];

/**
 * All registered feed sources, loaded from the per-country JSON5 data files
 * under `feeds/roads/` and validated against {@link roadFeedSchema} at load.
 * A feed whose `format` no roads parser reads fails the load, so the
 * narrowing to {@link RoadSourceFormat} is checked, not assumed.
 */
export const FEED_SOURCES: FeedSource[] = loadFeedFiles(resolveFeedsDir(), roadFeedSchema).map(
  (feed) => {
    if (!(ROAD_SOURCE_FORMATS as string[]).includes(feed.format)) {
      throw new Error(`feed ${feed.id}: no roads parser reads format "${feed.format}"`);
    }
    return feed as FeedSource;
  },
);

/**
 * Returns the parser function for a given source format.
 * Throws for any format not yet supported.
 */
export function parserFor(format: string): ParserFn {
  if (!Object.hasOwn(EVENT_PARSERS, format)) {
    throw new Error(`No parser registered for format: ${format}`);
  }
  return EVENT_PARSERS[format as keyof typeof EVENT_PARSERS];
}

/**
 * Returns the flow parser function for a given source format.
 * Throws when no flow parser is registered for the format.
 */
export function flowParserFor(format: string): FlowParserFn {
  if (!Object.hasOwn(FLOW_PARSERS, format)) {
    throw new Error(`No flow parser registered for format: ${format}`);
  }
  return FLOW_PARSERS[format as keyof typeof FLOW_PARSERS];
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
    ...(feed.accessMode ? { accessMode: feed.accessMode } : {}),
    ...(feed.laneNumbering ? { laneNumbering: feed.laneNumbering } : {}),
    ...(feed.extrasAllow ? { extrasAllow: feed.extrasAllow } : {}),
    ...(feed.geojson ? { geojson: feed.geojson } : {}),
    ...(feed.flowMap ? { flowMap: feed.flowMap } : {}),
    ...(feed.posListLonLat ? { posListLonLat: true } : {}),
    ...(feed.srsName ? { srsName: feed.srsName } : {}),
  };
}
