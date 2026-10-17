import {
  decodeOverpass,
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordSkipReason,
  recordSkipped,
} from "@openconditions/ingest-framework";
import { COMPASS_POINTS, type LocalizedText } from "@openconditions/model";
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

/**
 * `camera:mount`: a pole, a street lamp's or a traffic signal's pole (the
 * wiki shows a camera on a pole fixed to a traffic light), a bridge, a
 * gantry, and the wiki's `wall`, `ceiling`, `building` and `doorbell` as
 * themselves. Any other value (a `roof`, which the wiki does not document)
 * reads `unknown` and is counted.
 */
const MOUNTINGS: Readonly<Record<string, Mounting>> = {
  pole: "pole",
  street_lamp: "pole",
  traffic_signal: "pole",
  bridge: "bridge",
  gantry: "gantry",
  wall: "wall",
  ceiling: "ceiling",
  building: "building",
  doorbell: "doorbell",
};

/** An OSM `ele`: metres, written as a bare number or with an `m`. */
const ELEVATION = /^(-?\d+(?:\.\d+)?)\s*(?:m)?$/;

/** A `name:<lang>` key whose suffix is a language tag the model holds. */
const NAME_LANG = /^name:([a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*)$/;

/** The names of an element: `name` first, in no stated language, then each `name:<lang>`. */
function namesOf(tags: Record<string, string>, fallback: string | undefined): LocalizedText[] {
  const primary = tag(tags, "name") ?? fallback;
  return [
    ...(primary === undefined ? [] : [{ lang: UNDETERMINED, text: primary }]),
    ...Object.keys(tags)
      .sort()
      .flatMap((key) => {
        const lang = NAME_LANG.exec(key)?.[1];
        const text = lang === undefined ? undefined : tag(tags, key);
        return lang === undefined || text === undefined ? [] : [{ lang, text }];
      }),
  ];
}

/** `camera:type`: a fixed camera is not movable, a panning or dome camera is. */
const PTZ: Readonly<Record<string, boolean>> = { fixed: false, panning: true, dome: true };

const COMPASS = new Set<string>(COMPASS_POINTS);

/**
 * The one view of a webcam: a numeric `camera:direction` is its bearing, a
 * compass letter its compass direction; a range or text says nothing. The
 * generic `direction` tag is not read: on a node it may be a road's, a sign's
 * or a viewpoint's, and only a true camera bearing is a view's bearing. A
 * `camera:direction` that is neither is counted as unknown.
 */
function viewOf(tags: Record<string, string>, unknown: () => void): ViewInput {
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
  unknown();
  return { key: "0" };
}

/**
 * OpenStreetMap webcams as Overpass answers for a cell: objects with a
 * webcam address or tagged as a webcam, nodes at their position and ways and
 * relations at their centre. The camera id is the element (`way/<id>`), and
 * its `osm:<type>` id the only id linking matches on. A webcam address that
 * names an image file is the still of the camera's one view; any other is
 * the camera's page, which `contact:website` (or `website`) gives where the
 * address is an image. `name` and each `name:<lang>` name the camera, `ele`
 * is its elevation in metres. OSM says nothing of whether the camera works, and the
 * image belongs to the camera's operator, not to OSM. A `camera:mount` or
 * `camera:type` value not read here counts as unknown.
 */
export function parseOverpassCameras(
  feed: CamerasCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const dc: DraftContext = { fetchedAt: ctx.fetchedAt, out };
  const skip = (reason: RecordSkipReason) => recordSkipped(feed.id, reason);
  const unknown = () => recordSkipped(feed.id, "unknown_value");
  for (const payload of payloads["main"] ?? []) {
    for (const element of decodeOverpass(payload, skip)) {
      const { tags } = element;
      const address = WEBCAM_TAGS.map((key) => tag(tags, key)).find((v) => v !== undefined);
      const isWebcam = tag(tags, "surveillance:type") === "webcam";
      if (address === undefined && !isWebcam) continue;
      const url = urlOf(address);
      const isImage = url !== undefined && IMAGE_PATH.test(new URL(url).pathname);
      const description = tag(tags, "description");
      const describes = description !== undefined && urlOf(description) === undefined;
      // A description names a webcam that has no name, else it describes it.
      const names = namesOf(tags, describes ? description : undefined);
      const named = tag(tags, "name") !== undefined;
      const website = urlOf(tag(tags, "contact:website") ?? tag(tags, "website"));
      const page = url === undefined || isImage ? website : url;
      const ele = ELEVATION.exec(tag(tags, "ele") ?? "");
      const mount = tag(tags, "camera:mount");
      const mounting =
        mount !== undefined && Object.hasOwn(MOUNTINGS, mount) ? MOUNTINGS[mount] : undefined;
      if (mount !== undefined && mounting === undefined) unknown();
      const cameraType = tag(tags, "camera:type");
      const ptz =
        cameraType !== undefined && Object.hasOwn(PTZ, cameraType) ? PTZ[cameraType] : undefined;
      if (cameraType !== undefined && ptz === undefined) unknown();
      const operator = tag(tags, "operator");
      const cameraId = `${element.type}/${element.id}`;
      const point = [element.lon, element.lat] as const;
      out.features.push(
        cameraDraft(feed, dc, {
          cameraId,
          providerId: false,
          externalIds: [{ scheme: `osm:${element.type}`, id: String(element.id) }],
          point,
          names,
          ...(named && describes
            ? { description: [{ lang: UNDETERMINED, text: description }] }
            : {}),
          ...(ele === null ? {} : { elevationM: Number(ele[1]) }),
          type: typeOf(tags),
          // The operator is the camera's, which linking compares with the
          // publishers' cameras; it also names who provides the image.
          ...(operator === undefined
            ? {}
            : { operator: [{ lang: UNDETERMINED, text: operator }], provider: operator }),
          ...(page === undefined ? {} : { detailUrl: page }),
          ...(ptz === undefined ? {} : { ptz }),
          ...(mount === undefined ? {} : { mounting: mounting ?? "unknown" }),
          imageRedistribution: imageRedistributionOf(feed, "unknown"),
          views: [viewOf(tags, unknown)],
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
