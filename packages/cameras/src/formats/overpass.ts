import {
  decodeOverpass,
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import { COMPASS_POINTS } from "@openconditions/model";
import {
  type CameraType,
  cameraDraft,
  type DraftContext,
  imageReading,
  imageRedistributionOf,
  type Mounting,
  type ViewInput,
} from "../camera.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";
import { urlOf } from "../records.js";

/** OSM text is in whatever language the mapper wrote it. */
const UNDETERMINED = "und";

const tag = (tags: Record<string, string>, key: string): string | undefined => {
  const value = tags[key]?.trim();
  return value ? value : undefined;
};

/** The tags that hold a webcam's address, in the order they are read. */
const WEBCAM_TAGS = ["contact:webcam", "webcam", "contact:webcam:1"];

/** A URL whose path names an image file, with or without a query. */
const IMAGE_PATH = /\.(?:jpe?g|png|gif|webp)$/i;

/**
 * What a webcam shows, from the object it is tagged on: a road, then the
 * weather, then the landscape (a tourist place, a natural feature, a tower).
 */
function typeOf(tags: Record<string, string>): CameraType {
  if (tag(tags, "surveillance:zone") === "traffic" || tag(tags, "highway") !== undefined) {
    return "traffic";
  }
  if (
    tag(tags, "monitoring:weather") === "yes" ||
    Object.keys(tags).some((key) => key.startsWith("weather:"))
  ) {
    return "weather";
  }
  if (
    tag(tags, "tourism") !== undefined ||
    tag(tags, "natural") !== undefined ||
    tag(tags, "man_made") === "tower"
  ) {
    return "landscape";
  }
  return "other";
}

const MOUNTINGS: Readonly<Record<string, Mounting>> = {
  pole: "pole",
  street_lamp: "pole",
  bridge: "bridge",
  gantry: "gantry",
};

/** `camera:type`: a fixed camera is not movable, a panning or dome camera is. */
const PTZ: Readonly<Record<string, boolean>> = { fixed: false, panning: true, dome: true };

const COMPASS = new Set<string>(COMPASS_POINTS);

/**
 * The one view of a webcam: a numeric `camera:direction` is its bearing, a
 * compass letter its compass direction; a range or text says nothing. The
 * generic `direction` tag is not read: on a node it may be a road's, a sign's
 * or a viewpoint's, and only a true camera bearing is a view's bearing.
 */
function viewOf(tags: Record<string, string>): ViewInput {
  const raw = tag(tags, "camera:direction");
  if (raw === undefined) return { key: "0" };
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return { key: "0", bearingDeg: Number(raw) };
  const compass = raw.toUpperCase();
  if (COMPASS.has(compass)) {
    return {
      key: "0",
      direction: {
        value: "unknown",
        basis: "compass",
        compass: compass as (typeof COMPASS_POINTS)[number],
      },
    };
  }
  return { key: "0" };
}

/**
 * OpenStreetMap webcams as Overpass answers for a cell: objects with a
 * webcam address or tagged as a webcam, nodes at their position and ways and
 * relations at their centre. The camera id is the element (`way/<id>`), and
 * its `osm:<type>` id the only id linking matches on. A webcam address that
 * names an image file is the still of the camera's one view; any other is
 * the camera's page. OSM says nothing of whether the camera works, and the
 * image belongs to the camera's operator, not to OSM.
 */
export function parseOverpassCameras(
  feed: CamerasCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const dc: DraftContext = { fetchedAt: ctx.fetchedAt, out };
  for (const payload of payloads["main"] ?? []) {
    for (const element of decodeOverpass(payload)) {
      const { tags } = element;
      const address = WEBCAM_TAGS.map((key) => tag(tags, key)).find((v) => v !== undefined);
      const isWebcam = tag(tags, "surveillance:type") === "webcam";
      if (address === undefined && !isWebcam) continue;
      const url = urlOf(address);
      const isImage = url !== undefined && IMAGE_PATH.test(new URL(url).pathname);
      const description = tag(tags, "description");
      const name =
        tag(tags, "name") ??
        (description === undefined || urlOf(description) ? undefined : description);
      const mount = tag(tags, "camera:mount");
      const ptz = PTZ[tag(tags, "camera:type") ?? ""];
      const operator = tag(tags, "operator");
      const cameraId = `${element.type}/${element.id}`;
      const point = [element.lon, element.lat] as const;
      out.features.push(
        cameraDraft(feed, dc, {
          cameraId,
          providerId: false,
          externalIds: [{ scheme: `osm:${element.type}`, id: String(element.id) }],
          point,
          names: name === undefined ? [] : [{ lang: UNDETERMINED, text: name }],
          type: typeOf(tags),
          // The operator is the camera's, which linking compares with the
          // publishers' cameras; it also names who provides the image.
          ...(operator === undefined
            ? {}
            : { operator: [{ lang: UNDETERMINED, text: operator }], provider: operator }),
          ...(url === undefined || isImage ? {} : { detailUrl: url }),
          ...(ptz === undefined ? {} : { ptz }),
          ...(mount === undefined ? {} : { mounting: MOUNTINGS[mount] ?? "unknown" }),
          imageRedistribution: imageRedistributionOf(feed, "unknown"),
          views: [viewOf(tags)],
        }),
      );
      out.observations.push(
        imageReading(feed, dc, {
          cameraId,
          viewKey: "0",
          status: "unknown",
          point,
          ...(isImage ? { imageUrl: url } : {}),
        }),
      );
    }
  }
  return out;
}
