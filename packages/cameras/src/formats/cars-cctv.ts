import { isXmlObject, parseXmlDocument, xmlNodeToArray, xmlText } from "@openconditions/datex2";
import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { DirectionRef } from "@openconditions/model";
import {
  cameraDraft,
  type DraftContext,
  imageReading,
  imageRedistributionOf,
  matchesImageHost,
  type ViewInput,
} from "../camera.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";
import { clean, lonLat, numberOf, positionSkip } from "../records.js";

const LANG = "en";

interface Device {
  id: string;
  name?: string;
  owner?: string;
  videoUrl?: string;
  stills: { name?: string; url: string }[];
  route?: string;
  /** The position along the route in CARS's own linear referencing. */
  linearReference?: number;
  linkDirection?: string;
  /** The item lists presets or the limits of its pan, tilt and zoom: a movable camera. */
  movable: boolean;
  /** Microdegrees, as the inventory writes them. */
  latitude?: string;
  longitude?: string;
}

/**
 * The directions of the hub's `Link-direction`, by name and by its number
 * (`FEU-g.xsd`): a compass point, or the direction along the link's linear
 * referencing. "any other" and "not directional" give none.
 */
const COMPASS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;
const ALONG: Readonly<Record<string, DirectionRef>> = {
  "positive direction": { value: "positive", basis: "road_reference" },
  "negative direction": { value: "negative", basis: "road_reference" },
  "both directions": { value: "both", basis: "road_reference" },
};
const LINK_DIRECTION_NAMES = [
  "any other",
  ...COMPASS,
  "not directional",
  "positive direction",
  "negative direction",
  "both directions",
] as const;

/**
 * A link direction as the model holds it: undefined for "any other" and
 * "not directional", and for a value the schema does not define, which is
 * counted as unknown.
 */
function directionOf(feed: CamerasCatalogFeed, value: string): DirectionRef | undefined {
  const code = /^\d+$/.test(value) ? Number(value) : undefined;
  const name = code === undefined ? value.toLowerCase() : LINK_DIRECTION_NAMES[code];
  if (name === undefined || !(LINK_DIRECTION_NAMES as readonly string[]).includes(name)) {
    recordSkipped(feed.id, "unknown_value");
    return undefined;
  }
  const compass = COMPASS.find((point) => point === name);
  if (compass !== undefined) {
    return {
      value: "unknown",
      basis: "compass",
      compass: compass.toUpperCase() as Uppercase<typeof compass>,
    };
  }
  return ALONG[name];
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
      const stills = xmlNodeToArray(
        isXmlObject(item["still-images"]) ? item["still-images"]["still-image"] : undefined,
      ).flatMap((still) => {
        const url = isXmlObject(still) ? clean(xmlText(still["url"])) : undefined;
        if (!isXmlObject(still) || url === undefined) return [];
        const name = clean(xmlText(still["name"]));
        return [{ url, ...(name === undefined ? {} : { name }) }];
      });
      const location = isXmlObject(item["location"]) ? item["location"] : {};
      const geo = isXmlObject(location["geo-location"]) ? location["geo-location"] : {};
      const presets = isXmlObject(item["presets"]) ? xmlNodeToArray(item["presets"]["preset"]) : [];
      const fields = {
        name: clean(xmlText(item["device-name"])),
        owner,
        videoUrl: clean(xmlText(item["video-url"])),
        route: clean(xmlText(location["route-designator"])),
        linearReference: numberOf(xmlText(location["linear-reference"])),
        linkDirection: clean(xmlText(location["link-direction"])),
        latitude: clean(xmlText(geo["latitude"])),
        longitude: clean(xmlText(geo["longitude"])),
      };
      return [
        {
          id,
          stills,
          movable: presets.length > 0 || isXmlObject(item["range"]),
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
 * CCTV schema): one camera per inventory item, with a view per still image,
 * named by the still's name where it differs from the camera's, and, where
 * the agency streams it, its HLS video on the first view. The location's
 * link direction is the camera's facing, its linear reference its position
 * along the route, and an item listing presets or pan, tilt and zoom limits
 * a movable camera. Positions are microdegrees. A
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
      const stills = device.stills.filter(
        (still) => hosts.length === 0 || matchesImageHost(still.url, hosts),
      );
      if (point === undefined) {
        recordSkipped(feed.id, positionSkip(device.longitude, device.latitude));
        continue;
      }
      if (stills.length === 0 && device.videoUrl === undefined) {
        out.rejected = (out.rejected ?? 0) + 1;
        continue;
      }
      // An agency that names no route repeats the camera's name in its place.
      const route = device.route !== device.name ? device.route : undefined;
      const direction =
        device.linkDirection === undefined ? undefined : directionOf(feed, device.linkDirection);
      const shown = stills.length === 0 ? [undefined] : stills;
      const views: ViewInput[] = shown.map((still, i) => ({
        key: String(i),
        ...(still?.name === undefined || still.name === device.name
          ? {}
          : { name: [{ lang: LANG, text: still.name }] }),
      }));
      out.features.push(
        cameraDraft(feed, dc, {
          cameraId: device.id,
          point,
          names: device.name === undefined ? [] : [{ lang: LANG, text: device.name }],
          type: "traffic",
          ...(route === undefined ? {} : { road: { name: [{ lang: LANG, text: route }] } }),
          ...(direction === undefined ? {} : { direction }),
          ...(route === undefined || device.linearReference === undefined
            ? {}
            : {
                // CARS's own linear referencing along the route; the schema states no unit.
                linear: {
                  system: "provider" as const,
                  ref: route,
                  from: device.linearReference,
                  authority: "cars",
                },
              }),
          ...(device.movable ? { ptz: true } : {}),
          ...(device.owner === undefined ? {} : { operator: [{ lang: LANG, text: device.owner }] }),
          imageRedistribution: imageRedistributionOf(feed, "link_only"),
          views,
        }),
      );
      shown.forEach((still, i) => {
        out.observations.push(
          imageReading(feed, dc, {
            cameraId: device.id,
            viewKey: String(i),
            status: "unknown",
            point,
            ...(still === undefined ? {} : { imageUrl: still.url }),
            ...(i > 0 || device.videoUrl === undefined
              ? {}
              : { streamUrl: device.videoUrl, streamType: "hls" as const }),
          }),
        );
      });
    }
  }
  return out;
}
