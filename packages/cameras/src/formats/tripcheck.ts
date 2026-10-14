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
  road?: RoadRef;
  upstream?: string;
  views: { key: string; imageUrl?: string; text?: string }[];
}

const english = (text: string | undefined): LocalizedText[] =>
  text === undefined ? [] : [{ lang: "en", text }];

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
 * that the key does not depend on the order of the rows. A row's `cctv-other`
 * says where its image looks: the camera's description when every image of
 * the device says the same, else each image's view name. A device repeated
 * in a later payload adds its views to the same camera. The inventory says
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
  const devices = new Map<string, Device>();
  for (const body of payloads["main"] ?? []) {
    const doc = jsonOf(body, "the camera inventory");
    if (!isRecord(doc) || !Array.isArray(doc["CCTVInventoryRequest"])) {
      throw new Error("the camera inventory carries no CCTVInventoryRequest");
    }
    const organisation = isRecord(doc["organization-information"])
      ? textOf(doc["organization-information"]["organization-name"])
      : undefined;
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
        const route = textOf(row["route-id"]);
        device = {
          point,
          names: english(textOf(row["device-name"])),
          ...(route === undefined ? {} : { road: { ref: route } }),
          ...(organisation === undefined ? {} : { upstream: organisation }),
          views: [],
        };
        devices.set(cameraId, device);
      }
      const imageUrl = textOf(row["cctv-url"]);
      const text = textOf(row["cctv-other"]);
      const key = fileKey(imageUrl);
      // Views are keyed as components are, so keys that differ only by `#` collide.
      const taken = device.views.find((view) => viewKey(view.key) === viewKey(key));
      if (taken === undefined) {
        device.views.push({
          key,
          ...(imageUrl === undefined ? {} : { imageUrl }),
          ...(text === undefined ? {} : { text }),
        });
      } else if (taken.imageUrl !== imageUrl) {
        out.rejected = (out.rejected ?? 0) + 1;
      }
    }
  }
  for (const [cameraId, device] of devices) {
    const texts = new Set(device.views.map((view) => view.text));
    const shared = texts.size === 1 ? [...texts][0] : undefined;
    const views: ViewInput[] = device.views.map((view) =>
      texts.size === 1 || view.text === undefined
        ? { key: view.key }
        : { key: view.key, name: english(view.text) },
    );
    out.features.push(
      cameraDraft(feed, dc, {
        cameraId,
        point: device.point,
        names: device.names,
        description: english(shared),
        type: "traffic",
        ...(device.road === undefined ? {} : { road: device.road }),
        ...(device.upstream === undefined ? {} : { upstream: device.upstream }),
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
          ...(device.upstream === undefined ? {} : { upstream: device.upstream }),
        }),
      );
    }
  }
  return out;
}
