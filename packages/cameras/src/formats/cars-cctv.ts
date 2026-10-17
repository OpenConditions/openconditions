import { isXmlObject, parseXmlDocument, xmlNodeToArray, xmlText } from "@openconditions/datex2";
import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import {
  cameraDraft,
  type DraftContext,
  imageReading,
  imageRedistributionOf,
  matchesImageHost,
} from "../camera.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";
import { clean, lonLat, positionSkip } from "../records.js";

const LANG = "en";

interface Device {
  id: string;
  name?: string;
  owner?: string;
  videoUrl?: string;
  stillUrl?: string;
  route?: string;
  /** Microdegrees, as the inventory writes them. */
  latitude?: string;
  longitude?: string;
}

/**
 * Every `<inventory-item>` of the inventory, with the organisation whose
 * inventory lists it; an item without a device id is skipped as malformed.
 */
function devicesOf(feed: CamerasCatalogFeed, body: Buffer): Device[] {
  // The root is namespace-qualified (`cctv:cctvInventories`), its children not.
  const doc = parseXmlDocument(body, { removeNSPrefix: true });
  const root = doc["cctvInventories"];
  if (!isXmlObject(root)) throw new Error("the camera inventory has no cctvInventories root");
  return xmlNodeToArray(root["cctvInventory"]).flatMap((inventory) => {
    if (!isXmlObject(inventory)) return [];
    const owner = isXmlObject(inventory["owner"])
      ? clean(xmlText(inventory["owner"]["organization-name"]))
      : undefined;
    const list = inventory["inventory"];
    if (!isXmlObject(list)) return [];
    return xmlNodeToArray(list["inventory-item"]).flatMap((item): Device[] => {
      const id = isXmlObject(item) ? clean(xmlText(item["device-id"])) : undefined;
      if (!isXmlObject(item) || id === undefined) {
        recordSkipped(feed.id, "malformed");
        return [];
      }
      const still = xmlNodeToArray(
        isXmlObject(item["still-images"]) ? item["still-images"]["still-image"] : undefined,
      ).find(isXmlObject);
      const location = isXmlObject(item["location"]) ? item["location"] : {};
      const geo = isXmlObject(location["geo-location"]) ? location["geo-location"] : {};
      const fields = {
        name: clean(xmlText(item["device-name"])),
        owner,
        videoUrl: clean(xmlText(item["video-url"])),
        stillUrl: still === undefined ? undefined : clean(xmlText(still["url"])),
        route: clean(xmlText(location["route-designator"])),
        latitude: clean(xmlText(geo["latitude"])),
        longitude: clean(xmlText(geo["longitude"])),
      };
      return [
        {
          id,
          ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
        } as Device,
      ];
    });
  });
}

const degrees = (micro: string | undefined): number | undefined => {
  const n = micro === undefined ? Number.NaN : Number(micro);
  return Number.isFinite(n) ? n / 1e6 : undefined;
};

/**
 * Castle Rock CARS camera inventories (`cctv.xml`, the North American Hub's
 * CCTV schema): one camera per inventory item, with one view, its still and,
 * where the agency streams it, its HLS video. Positions are microdegrees. A
 * camera without a still on the feed's image hosts that streams no video
 * shows nothing a consumer may load: it is left out and counted as rejected,
 * as the record breaks none of the format's rules. A camera without a
 * position is skipped as having no geometry, or as malformed where its
 * position cannot be read. The images' licence is the feed's access
 * agreement: they are only linked, unless the feed says otherwise.
 */
export function parseCarsCctv(
  feed: CamerasCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const dc: DraftContext = { fetchedAt: ctx.fetchedAt, out };
  const hosts = feed.cameras?.imageHosts ?? [];
  for (const body of payloads["main"] ?? []) {
    for (const device of devicesOf(feed, body)) {
      const point = lonLat(degrees(device.longitude), degrees(device.latitude));
      const still =
        device.stillUrl !== undefined &&
        (hosts.length === 0 || matchesImageHost(device.stillUrl, hosts))
          ? device.stillUrl
          : undefined;
      if (point === undefined) {
        recordSkipped(feed.id, positionSkip(device.longitude, device.latitude));
        continue;
      }
      if (still === undefined && device.videoUrl === undefined) {
        out.rejected = (out.rejected ?? 0) + 1;
        continue;
      }
      // An agency that names no route repeats the camera's name in its place.
      const route = device.route !== device.name ? device.route : undefined;
      out.features.push(
        cameraDraft(feed, dc, {
          cameraId: device.id,
          point,
          names: device.name === undefined ? [] : [{ lang: LANG, text: device.name }],
          type: "traffic",
          ...(route === undefined ? {} : { road: { name: [{ lang: LANG, text: route }] } }),
          ...(device.owner === undefined ? {} : { operator: [{ lang: LANG, text: device.owner }] }),
          imageRedistribution: imageRedistributionOf(feed, "link_only"),
          views: [{ key: "0" }],
        }),
      );
      out.observations.push(
        imageReading(feed, dc, {
          cameraId: device.id,
          viewKey: "0",
          status: "unknown",
          point,
          ...(still === undefined ? {} : { imageUrl: still }),
          ...(device.videoUrl === undefined
            ? {}
            : { streamUrl: device.videoUrl, streamType: "hls" as const }),
        }),
      );
    }
  }
  return out;
}
