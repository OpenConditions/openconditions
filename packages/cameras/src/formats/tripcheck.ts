import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import type { LocalizedText, RoadRef } from "@openconditions/model";
import {
  cameraDraft,
  type DraftContext,
  imageReading,
  imageRedistributionOf,
  type ViewInput,
  viewKey,
} from "../camera.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";
import { isRecord, jsonOf, lonLat, textOf, urlOf } from "../records.js";

interface Device {
  point: [number, number];
  names: LocalizedText[];
  description: LocalizedText[];
  road?: RoadRef;
  views: { key: string; imageUrl?: string }[];
}

/** The image's file name, which tells a device's images apart; `0` where the address has none. */
function fileKey(url: string | undefined): string {
  const valid = urlOf(url);
  const name = valid === undefined ? undefined : new URL(valid).pathname.split("/").pop();
  if (!name) return "0";
  // A bad percent escape in the address is no reason to lose the feed: keep the segment as written.
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * ODOT's TripCheck API camera inventory (`Cctv/Inventory`): a row per image,
 * so a device with several images repeats under its `device-id`. A device is
 * one camera and each of its images a view, keyed by the image's file name so
 * that the key does not depend on the order of the rows. The inventory says
 * nothing of whether a camera works, and its `last-update-time` is the row's,
 * not the image's. The images are ODOT's or a partner agency's, and the
 * terms ask the republisher to credit the agency: the inventory's
 * organisation is the upstream publisher.
 */
export function parseTripcheck(
  feed: CamerasCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const dc: DraftContext = { fetchedAt: ctx.fetchedAt, out };
  for (const body of payloads["main"] ?? []) {
    const doc = jsonOf(body, "the camera inventory");
    if (!isRecord(doc) || !Array.isArray(doc["CCTVInventoryRequest"])) {
      throw new Error("the camera inventory carries no CCTVInventoryRequest");
    }
    const organisation = isRecord(doc["organization-information"])
      ? textOf(doc["organization-information"]["organization-name"])
      : undefined;
    const devices = new Map<string, Device>();
    for (const record of doc["CCTVInventoryRequest"]) {
      const row = isRecord(record) ? record : {};
      const cameraId = textOf(row["device-id"]);
      const point = lonLat(row["longitude"], row["latitude"]);
      if (cameraId === undefined || point === undefined) {
        out.rejected = (out.rejected ?? 0) + 1;
        continue;
      }
      let device = devices.get(cameraId);
      if (device === undefined) {
        const name = textOf(row["device-name"]);
        const description = textOf(row["cctv-other"]);
        const route = textOf(row["route-id"]);
        device = {
          point,
          names: name === undefined ? [] : [{ lang: "en", text: name }],
          description: description === undefined ? [] : [{ lang: "en", text: description }],
          ...(route === undefined ? {} : { road: { ref: route } }),
          views: [],
        };
        devices.set(cameraId, device);
      }
      const imageUrl = textOf(row["cctv-url"]);
      const key = fileKey(imageUrl);
      // Views are keyed as components are, so keys that differ only by `#` collide.
      const taken = device.views.find((view) => viewKey(view.key) === viewKey(key));
      if (taken === undefined) {
        device.views.push({ key, ...(imageUrl === undefined ? {} : { imageUrl }) });
      } else if (taken.imageUrl !== imageUrl) {
        out.rejected = (out.rejected ?? 0) + 1;
      }
    }
    for (const [cameraId, device] of devices) {
      const views: ViewInput[] = device.views.map((view) => ({ key: view.key }));
      out.features.push(
        cameraDraft(feed, dc, {
          cameraId,
          point: device.point,
          names: device.names,
          description: device.description,
          type: "traffic",
          ...(device.road === undefined ? {} : { road: device.road }),
          ...(organisation === undefined ? {} : { upstream: organisation }),
          imageRedistribution: imageRedistributionOf(feed, "allowed"),
          views,
        }),
      );
      for (const view of device.views) {
        out.observations.push(
          imageReading(feed, dc, {
            cameraId,
            viewKey: view.key,
            status: "unknown",
            point: device.point,
            ...(view.imageUrl === undefined ? {} : { imageUrl: view.imageUrl }),
            ...(organisation === undefined ? {} : { upstream: organisation }),
          }),
        );
      }
    }
  }
  return out;
}
