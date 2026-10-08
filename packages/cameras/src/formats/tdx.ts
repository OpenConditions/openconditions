import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import { COMPASS_POINTS, type DirectionRef } from "@openconditions/model";
import { cameraDraft, type DraftContext, imageReading, imageRedistributionOf } from "../camera.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";
import { isRecord, jsonOf, lonLat, textOf } from "../records.js";

/** TDX's road names and descriptions are in Traditional Chinese. */
const LANG = "zh-Hant";

const COMPASS = new Set<string>(COMPASS_POINTS);

/** `RoadDirection` is the road's compass direction at the camera; `A` (all) gives none. */
function directionOf(value: string | undefined): DirectionRef | undefined {
  if (value === undefined || !COMPASS.has(value)) return undefined;
  return { value: "unknown", basis: "compass", compass: value as (typeof COMPASS_POINTS)[number] };
}

/**
 * TDX's road CCTV lists (`/v2/Road/Traffic/CCTV/{Freeway|Highway}`), one
 * payload each: a camera per record with one view along the road's
 * direction. Both bureaus serve their live view as an MJPEG stream (the
 * freeway bureau's `abs2mjpg` service and the highway bureau's own hosts
 * answer `multipart/x-mixed-replace` JPEG frames); only the highway bureau
 * adds a snapshot still. A camera without a description is named by its
 * road and kilometre mark. The images sit on the agencies' hosts under no
 * stated licence.
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
      if (cameraId === undefined || point === undefined) {
        out.rejected = (out.rejected ?? 0) + 1;
        continue;
      }
      const roadName = textOf(cctv["RoadName"]);
      const mile = textOf(cctv["LocationMile"]);
      const name =
        textOf(cctv["SurveillanceDescription"]) ??
        ([roadName, mile].filter((part) => part !== undefined).join(" ") || undefined);
      const direction = directionOf(textOf(cctv["RoadDirection"]));
      const stream = textOf(cctv["VideoStreamURL"]);
      const still = textOf(cctv["VideoImageURL"]);
      out.features.push(
        cameraDraft(feed, dc, {
          cameraId,
          point,
          names: name === undefined ? [] : [{ lang: LANG, text: name }],
          type: "traffic",
          ...(roadName === undefined ? {} : { road: { name: [{ lang: LANG, text: roadName }] } }),
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
