import {
  defineIngestDomain,
  type FeedDefinition,
  type FeedFormat,
  type IngestDomain,
} from "@openconditions/ingest-framework";
import {
  CAMERAS_MAPPING_FIELDS,
  type CamerasCatalogFeed,
  type CamerasFeedExtension,
  camerasFeedShape,
  readMapping,
} from "./feed-schema.js";
import { parseDatex2Cameras } from "./formats/datex2.js";
import { parseDigitraffic, parseDigitrafficStatus } from "./formats/digitraffic.js";
import { parseHkTdCameras } from "./formats/hk-td.js";
import { parseIbi511 } from "./formats/ibi511.js";
import { CAMERAS_LAYOUT_FORMATS, parseLayout } from "./formats/layout.js";
import { parseNps } from "./formats/nps.js";
import { parseOverpassCameras } from "./formats/overpass.js";
import { parseTdxCameras } from "./formats/tdx.js";
import { parseTfl } from "./formats/tfl.js";
import { parseTrafikverketCameras } from "./formats/trafikverket.js";
import { parseTripcheck } from "./formats/tripcheck.js";
import { parseWindy } from "./formats/windy.js";

/** What a camera feed publishes: cameras, their views, and each view's current image. */
export const CAMERAS_PRODUCTS = ["cameras"] as const;

/**
 * The records every camera format emits, which on-demand routing reads: the
 * camera features, the view components feature reads match too, and the
 * image readings.
 */
const PRODUCES = {
  kinds: ["camera", "camera_view"],
  properties: ["camera.image"],
} as const;

/**
 * A format of cameras, read from one `main` payload unless it names its
 * roles; one with a live status role reads that role alone too.
 */
function cameras(
  id: string,
  parse: FeedFormat<CamerasCatalogFeed>["parse"],
  endpoints: FeedFormat<CamerasCatalogFeed>["endpoints"] = { main: { required: true } },
  parseStatus?: FeedFormat<CamerasCatalogFeed>["parseStatus"],
): FeedFormat<CamerasCatalogFeed> {
  return {
    id,
    kind: "features",
    products: CAMERAS_PRODUCTS,
    produces: PRODUCES,
    endpoints,
    parse,
    ...(parseStatus === undefined ? {} : { parseStatus }),
  };
}

const FORMATS: FeedFormat<CamerasCatalogFeed>[] = [
  ...CAMERAS_LAYOUT_FORMATS.map((id) => cameras(id, parseLayout)),
  // Per grid cell, webcams tagged on any object.
  cameras("overpass", parseOverpassCameras),
  // The station list, each station's details, and every preset's latest
  // image time, which polls on its own between the daily lists.
  cameras(
    "digitraffic",
    parseDigitraffic,
    {
      sites: { required: true },
      details: { required: false },
      status: { required: false, status: true },
    },
    parseDigitrafficStatus,
  ),
  cameras("trafikverket", parseTrafikverketCameras),
  cameras("ibi511", parseIbi511),
  cameras("tdx", parseTdxCameras),
  // The English list, and the Traditional Chinese one for the names.
  cameras("hk-td", parseHkTdCameras, { main: { required: true }, names: { required: false } }),
  cameras("datex2", parseDatex2Cameras),
  // Per grid cell, Windy's webcams inside the cell.
  cameras("windy", parseWindy),
  cameras("tfl", parseTfl),
  cameras("nps", parseNps),
  cameras("tripcheck", parseTripcheck),
];

const LAYOUTS: ReadonlySet<string> = new Set(CAMERAS_LAYOUT_FORMATS);

/** The mapping field every format reads: what the images' licence allows is the feed's to say. */
const EVERY_FORMAT_READS: ReadonlySet<string> = new Set(["imageRedistribution"]);

/**
 * A feed in a generic layout is read only through its `layout` block and its
 * `cameras` mapping, so both must be written in full; a format with its own
 * parser reads neither, beyond the images' licence, so a mapping or layout
 * there would be silently ignored. The feed shape cannot require a field for
 * some formats only.
 */
function lintFeed(feed: FeedDefinition): string[] {
  const own = feed as FeedDefinition & CamerasFeedExtension;
  if (!LAYOUTS.has(feed.format)) {
    const mappingFields = CAMERAS_MAPPING_FIELDS.filter(
      (key) =>
        !EVERY_FORMAT_READS.has(key) &&
        own.cameras !== undefined &&
        Object.hasOwn(own.cameras, key),
    );
    return [
      ...(own.layout === undefined ? [] : [`format ${feed.format} reads no layout block`]),
      ...(mappingFields.length === 0
        ? []
        : [`format ${feed.format} reads no cameras mapping: ${mappingFields.join(", ")}`]),
    ];
  }
  const issues = own.layout === undefined ? [`format ${feed.format} needs a layout block`] : [];
  if (own.cameras === undefined)
    return [...issues, `format ${feed.format} needs a cameras mapping`];
  return [...issues, ...readMapping(own.cameras).issues];
}

/**
 * The cameras domain: traffic, weather and landscape cameras, the views each
 * has, and the image each view shows now. The records are the model's roads
 * kinds; the domain is where their feeds and formats live.
 */
export const camerasDomain: IngestDomain<CamerasCatalogFeed> =
  defineIngestDomain<CamerasCatalogFeed>({
    id: "cameras",
    products: CAMERAS_PRODUCTS,
    feedShape: camerasFeedShape,
    formats: Object.fromEntries(FORMATS.map((format) => [format.id, format])),
    resolvers: [],
    lintFeed,
  });
