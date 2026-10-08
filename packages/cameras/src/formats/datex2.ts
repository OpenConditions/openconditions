import { parseDatexCameraDevices, parseXmlDocument } from "@openconditions/datex2";
import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import { cameraDraft, type DraftContext, imageReading, imageRedistributionOf } from "../camera.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";

/** The publication's language: DGT writes its road destinations in Spanish. */
const LANG = "es";

/**
 * Traffic cameras of a DATEX II v3 device publication, as DGT publishes
 * them: a camera per device with one view, which looks along the road's
 * reference direction where the device says so, and whose still is the
 * device's URL. The camera is named for its road and the destination the
 * view faces. The device's update time dates its record, not its image, and
 * the publication says nothing of whether a camera works. The images sit on
 * a portal whose legal notice reserves them, so their licence is unknown.
 */
export function parseDatex2Cameras(
  feed: CamerasCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const dc: DraftContext = { fetchedAt: ctx.fetchedAt, out };
  for (const body of payloads["main"] ?? []) {
    for (const device of parseDatexCameraDevices(parseXmlDocument(body))) {
      if (device.point === undefined) {
        out.rejected = (out.rejected ?? 0) + 1;
        continue;
      }
      const name = [device.roadName, device.roadDestination]
        .filter((part) => part !== undefined)
        .join(" → ");
      out.features.push(
        cameraDraft(feed, dc, {
          cameraId: device.id,
          point: device.point,
          names: name === "" ? [] : [{ lang: LANG, text: name }],
          type: "traffic",
          ...(device.roadName === undefined
            ? {}
            : {
                road: {
                  ref: device.roadName,
                  ...(device.kilometrePoint === undefined ? {} : { kmFrom: device.kilometrePoint }),
                },
              }),
          imageRedistribution: imageRedistributionOf(feed, "unknown"),
          views: [
            {
              key: "0",
              ...(device.directionRoad === undefined
                ? {}
                : { direction: { value: device.directionRoad, basis: "road_reference" } }),
            },
          ],
        }),
      );
      out.observations.push(
        imageReading(feed, dc, {
          cameraId: device.id,
          viewKey: "0",
          status: "unknown",
          point: device.point,
          ...(device.imageUrl === undefined ? {} : { imageUrl: device.imageUrl }),
        }),
      );
    }
  }
  return out;
}
