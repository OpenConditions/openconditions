import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import { COMPASS_POINTS, type DirectionRef, type RoadRef } from "@openconditions/model";
import {
  cameraDraft,
  type DraftContext,
  imageReading,
  imageRedistributionOf,
  type SiteImageInput,
} from "../camera.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";
import { entryOf, isRecord, jsonOf, lonLat, positionSkip, textOf } from "../records.js";

/** TDX's road names and descriptions are in Traditional Chinese. */
const LANG = "zh-Hant";

const COMPASS = new Set<string>(COMPASS_POINTS);

/**
 * `RoadDirection` is the road's compass direction at the camera; `A` (all)
 * gives none, and any other value is skipped as an unknown one.
 */
function directionOf(
  feed: CamerasCatalogFeed,
  value: string | undefined,
): DirectionRef | undefined {
  if (value === undefined || value === "A") return undefined;
  if (!COMPASS.has(value)) {
    recordSkipped(feed.id, "unknown_value");
    return undefined;
  }
  return { value: "unknown", basis: "compass", compass: value as (typeof COMPASS_POINTS)[number] };
}

/**
 * The road class of `RoadClass`: national freeway (0), expressway (1),
 * urban expressway (2), provincial (3), county (4), township (5) and urban
 * road (6). A ramp (7) has no class of its own: it is the road's ramp.
 */
const ROAD_CLASSES: Readonly<Record<string, RoadRef["class"]>> = {
  "0": "motorway",
  "1": "trunk",
  "2": "trunk",
  "3": "primary",
  "4": "secondary",
  "5": "tertiary",
  "6": "local",
};
const RAMP = "7";

/**
 * The documented `LocationType` values: roadside (1), median (2), the
 * island between fast and slow lanes (3), a gantry over the lanes (4), the
 * pavement (5) and other (6). Only the gantry is a mounting the model holds.
 */
const LOCATION_TYPES: ReadonlySet<string> = new Set(["1", "2", "3", "4", "5", "6"]);
const GANTRY = "4";

/** A kilometre mark, `9K+020`: kilometres and metres. */
const KM_MARK = /^(\d+)K\+(\d{1,3})$/i;

function kilometresOf(mark: string | undefined): number | undefined {
  const m = KM_MARK.exec(mark ?? "");
  return m === null ? undefined : Number(m[1]) + Number(m[2]) / 1000;
}

/** The road a camera stands on: its name and class, section ends and kilometre mark. */
function roadOf(feed: CamerasCatalogFeed, cctv: Record<string, unknown>): RoadRef | undefined {
  const name = textOf(cctv["RoadName"]);
  const roadClass = textOf(cctv["RoadClass"]);
  const section = isRecord(cctv["RoadSection"]) ? cctv["RoadSection"] : {};
  const from = textOf(section["Start"]);
  const to = textOf(section["End"]);
  const km = kilometresOf(textOf(cctv["LocationMile"]));
  const mapped = entryOf(ROAD_CLASSES, roadClass);
  if (roadClass !== undefined && mapped === undefined && roadClass !== RAMP) {
    recordSkipped(feed.id, "unknown_value");
  }
  const road: RoadRef = {
    ...(name === undefined ? {} : { name: [{ lang: LANG, text: name }] }),
    ...(mapped === undefined ? {} : { class: mapped }),
    ...(roadClass === RAMP ? { carriageway: "ramp" as const } : {}),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(km === undefined ? {} : { kmFrom: km }),
  };
  return Object.keys(road).length === 0 ? undefined : road;
}

/** The reference pictures of where the camera looks, and the sketch of the roadside layout. */
function imagesOf(cctv: Record<string, unknown>): SiteImageInput[] {
  const views = Array.isArray(cctv["LookingViews"]) ? cctv["LookingViews"] : [];
  return [
    ...views.flatMap((view) => {
      const url = isRecord(view) ? textOf(view["Image"]) : undefined;
      return url === undefined ? [] : [{ url, category: "other" as const }];
    }),
    ...[textOf(cctv["LayoutMapURL"])].flatMap((url) =>
      url === undefined ? [] : [{ url, category: "other" as const }],
    ),
  ];
}

/**
 * TDX's road CCTV lists (`/v2/Road/Traffic/CCTV/{Freeway|Highway}`), one
 * payload each: a camera per record with one view along the road's
 * direction. Both bureaus serve their live view as an MJPEG stream (the
 * freeway bureau's `abs2mjpg` service and the highway bureau's own hosts
 * answer `multipart/x-mixed-replace` JPEG frames); only the highway bureau
 * adds a snapshot still. A camera without a description is named by its
 * road and kilometre mark. The road carries its class, its section's ends
 * and the kilometre mark; the base link and road codes are kept as
 * external codes, the sub-authority as the camera's provider, a gantry as
 * its mounting, and the reference pictures and layout sketch as site
 * images. The images sit on the agencies' hosts under no stated licence.
 */
export function parseTdxCameras(
  feed: CamerasCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const dc: DraftContext = { fetchedAt: ctx.fetchedAt, out };
  for (const body of payloads["main"] ?? []) {
    const doc = jsonOf(body, "the CCTV list");
    if (!isRecord(doc) || !Array.isArray(doc["CCTVs"])) {
      throw new Error("the CCTV list carries no CCTVs");
    }
    for (const record of doc["CCTVs"]) {
      const cctv = isRecord(record) ? record : {};
      const cameraId = textOf(cctv["CCTVID"]);
      const point = lonLat(cctv["PositionLon"], cctv["PositionLat"]);
      if (cameraId === undefined) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      if (point === undefined) {
        recordSkipped(feed.id, positionSkip(cctv["PositionLon"], cctv["PositionLat"]));
        continue;
      }
      const roadName = textOf(cctv["RoadName"]);
      const mile = textOf(cctv["LocationMile"]);
      const name =
        textOf(cctv["SurveillanceDescription"]) ??
        ([roadName, mile].filter((part) => part !== undefined).join(" ") || undefined);
      const direction = directionOf(feed, textOf(cctv["RoadDirection"]));
      const stream = textOf(cctv["VideoStreamURL"]);
      const still = textOf(cctv["VideoImageURL"]);
      const road = roadOf(feed, cctv);
      const locationType = textOf(cctv["LocationType"]);
      if (locationType !== undefined && !LOCATION_TYPES.has(locationType)) {
        recordSkipped(feed.id, "unknown_value");
      }
      const external = [
        ["tw:link", textOf(cctv["LinkID"])],
        ["tw:road", textOf(cctv["RoadID"])],
      ].flatMap(([system, code]) =>
        code === undefined ? [] : [{ system: system as string, code }],
      );
      const provider = textOf(cctv["SubAuthorityCode"]) ?? textOf(doc["AuthorityCode"]);
      out.features.push(
        cameraDraft(feed, dc, {
          cameraId,
          point,
          names: name === undefined ? [] : [{ lang: LANG, text: name }],
          type: "traffic",
          ...(road === undefined ? {} : { road }),
          ...(external.length === 0 ? {} : { external }),
          ...(provider === undefined ? {} : { provider }),
          ...(locationType === GANTRY ? { mounting: "gantry" as const } : {}),
          images: imagesOf(cctv),
          imageRedistribution: imageRedistributionOf(feed, "unknown"),
          views: [{ key: "0", ...(direction === undefined ? {} : { direction }) }],
        }),
      );
      out.observations.push(
        imageReading(feed, dc, {
          cameraId,
          viewKey: "0",
          status: "unknown",
          point,
          ...(still === undefined ? {} : { imageUrl: still }),
          ...(stream === undefined ? {} : { streamUrl: stream, streamType: "mjpeg" as const }),
        }),
      );
    }
  }
  return out;
}
