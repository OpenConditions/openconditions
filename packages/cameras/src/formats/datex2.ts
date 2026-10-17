import { parseDatexCameraDevices, parseXmlDocument } from "@openconditions/datex2";
import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import { cameraDraft, type DraftContext, imageReading, imageRedistributionOf } from "../camera.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";

/** The publication's language: DGT writes its road destinations in Spanish. */
const LANG = "es";

/**
 * Traffic cameras of a DATEX II v3 device publication, as DGT publishes
 * them: a camera per device with one view, which looks along the road's
 * reference direction where the device says so, towards the destination it
 * names, and whose still is the device's URL. The camera is named for its
 * road and that destination, and placed in the publisher's country, its
 * province (else its autonomous community) and municipality, with the
 * community beside a province as the area's description. The device's
 * update time dates its record, not its image, and
 * the publication says nothing of whether a camera works. The images sit on
 * a portal whose legal notice reserves them, so their licence is unknown.
 * A camera without a placeable point is counted as `no_geometry`.
 */
export function parseDatex2Cameras(
  feed: CamerasCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const dc: DraftContext = { fetchedAt: ctx.fetchedAt, out };
  let unplaced = 0;
  for (const body of payloads["main"] ?? []) {
    for (const device of parseDatexCameraDevices(parseXmlDocument(body), { sourceId: feed.id })) {
      if (device.point === undefined) {
        unplaced++;
        continue;
      }
      const name = [device.roadName, device.roadDestination]
        .filter((part) => part !== undefined)
        .join(" → ");
      // The province is the finer of the two subdivisions DGT names.
      const subdivision = device.province ?? device.autonomousCommunity;
      const toward = device.roadDestination;
      const direction =
        device.directionRoad !== undefined || toward !== undefined
          ? {
              value: device.directionRoad ?? ("unknown" as const),
              basis: "road_reference" as const,
              ...(toward === undefined ? {} : { toward }),
            }
          : undefined;
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
          ...(device.country === undefined
            ? {}
            : {
                admin: {
                  country: device.country,
                  ...(subdivision === undefined ? {} : { subdivision }),
                  ...(device.municipality === undefined
                    ? {}
                    : { municipality: device.municipality }),
                },
              }),
          ...(device.province !== undefined && device.autonomousCommunity !== undefined
            ? { areaDescription: [{ lang: LANG, text: device.autonomousCommunity }] }
            : {}),
          imageRedistribution: imageRedistributionOf(feed, "unknown"),
          views: [{ key: "0", ...(direction === undefined ? {} : { direction }) }],
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
  recordSkipped(feed.id, "no_geometry", unplaced);
  return out;
}
