import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import {
  type CameraStatus,
  cameraDraft,
  type DraftContext,
  imageReading,
  imageRedistributionOf,
} from "../camera.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";
import { isRecord, jsonOf, lonLat, numberOf, textOf } from "../records.js";

/** Trafikverket names and describes its cameras in Swedish. */
const LANG = "sv";

/** A WKT point, `POINT (lon lat)`, as the object API writes `Geometry.WGS84`. */
const WKT_POINT = /^POINT\s*\(\s*(\S+)\s+(\S+)\s*\)$/i;

/**
 * A camera's status: an inactive camera is offline; one whose status says
 * its images are available is online; anything else is unknown.
 * Trafikverket documents no `Status` values, and `videoOrImagesAvailable`
 * is the only one seen in a real answer, so no other value is read as
 * offline.
 */
function statusOf(camera: Record<string, unknown>): CameraStatus {
  if (camera["Active"] === false) return "offline";
  if (textOf(camera["Status"]) === "videoOrImagesAvailable") return "online";
  return "unknown";
}

/** The `Camera` objects of an object-API answer; an error answer fails the parse. */
function camerasOf(body: Buffer): unknown[] {
  const doc = jsonOf(body, "the object API answer");
  const response = isRecord(doc) ? doc["RESPONSE"] : undefined;
  const results = isRecord(response) ? response["RESULT"] : undefined;
  if (!Array.isArray(results)) throw new Error("the object API answer carries no RESULT");
  return results.flatMap((result) => {
    if (!isRecord(result)) return [];
    const error = result["ERROR"];
    if (isRecord(error)) {
      throw new Error(
        `the object API answered an error: ${textOf(error["SOURCE"]) ?? "?"}: ${textOf(error["MESSAGE"]) ?? "?"}`,
      );
    }
    return Array.isArray(result["Camera"]) ? result["Camera"] : [];
  });
}

/**
 * Trafikverket's cameras from its object API (`Camera`, namespace
 * `road.infrastructure`, schema 1.1): a camera per record with its one
 * view. A numeric `Direction` is where the camera looks, in degrees;
 * `PhotoTime` is when its photo was taken. The full-size photo is the
 * still where the camera has one, else the plain photo; the thumbnail is
 * the thumbnail. A deleted camera is left out.
 */
export function parseTrafikverketCameras(
  feed: CamerasCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const dc: DraftContext = { fetchedAt: ctx.fetchedAt, out };
  for (const body of payloads["main"] ?? []) {
    for (const record of camerasOf(body)) {
      const camera = isRecord(record) ? record : {};
      if (camera["Deleted"] === true) continue;
      const cameraId = textOf(camera["Id"]);
      const geometry = isRecord(camera["Geometry"]) ? camera["Geometry"] : {};
      const wkt = WKT_POINT.exec(textOf(geometry["WGS84"]) ?? "");
      const point = wkt === null ? undefined : lonLat(wkt[1], wkt[2]);
      if (cameraId === undefined || point === undefined) {
        out.rejected = (out.rejected ?? 0) + 1;
        continue;
      }
      const name = textOf(camera["Name"]);
      const description = textOf(camera["Description"]);
      const bearingDeg = numberOf(camera["Direction"]);
      const fullSize =
        camera["HasFullSizePhoto"] === true ? textOf(camera["PhotoUrlFullsize"]) : undefined;
      const still = fullSize ?? textOf(camera["PhotoUrl"]);
      const thumbnail = textOf(camera["PhotoUrlThumbnail"]);
      const photoTime = textOf(camera["PhotoTime"]);
      out.features.push(
        cameraDraft(feed, dc, {
          cameraId,
          point,
          names: name === undefined ? [] : [{ lang: LANG, text: name }],
          ...(description === undefined
            ? {}
            : { description: [{ lang: LANG, text: description }] }),
          type: "traffic",
          imageRedistribution: imageRedistributionOf(feed, "allowed"),
          views: [{ key: "0", ...(bearingDeg === undefined ? {} : { bearingDeg }) }],
        }),
      );
      out.observations.push(
        imageReading(feed, dc, {
          cameraId,
          viewKey: "0",
          status: statusOf(camera),
          point,
          ...(still === undefined ? {} : { imageUrl: still }),
          ...(thumbnail === undefined ? {} : { thumbnailUrl: thumbnail }),
          ...(photoTime === undefined ? {} : { imageAt: photoTime }),
        }),
      );
    }
  }
  return out;
}
