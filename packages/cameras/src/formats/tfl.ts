import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import type { COMPASS_POINTS, DirectionRef } from "@openconditions/model";
import { cameraDraft, type DraftContext, imageReading, imageRedistributionOf } from "../camera.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";
import { isRecord, jsonOf, lonLat, textOf } from "../records.js";

/** TfL says its images refresh every three minutes. */
const REFRESH_SEC = 180;

interface Property {
  value: string;
}

/** A place's `additionalProperties` by key; a key listed twice keeps its first entry. */
function propertiesOf(place: Record<string, unknown>): Map<string, Property> {
  const properties = new Map<string, Property>();
  for (const entry of Array.isArray(place["additionalProperties"])
    ? place["additionalProperties"]
    : []) {
    if (!isRecord(entry)) continue;
    const key = textOf(entry["key"]);
    const value = textOf(entry["value"]);
    if (key === undefined || value === undefined || properties.has(key)) continue;
    properties.set(key, { value });
  }
  return properties;
}

const COMPASS: Readonly<Record<string, (typeof COMPASS_POINTS)[number]>> = {
  north: "N",
  south: "S",
  east: "E",
  west: "W",
  northeast: "NE",
  northwest: "NW",
  southeast: "SE",
  southwest: "SW",
};

/** Words a view adds to its direction without changing it. */
const FILLER = new Set(["facing", "home", "zoom", "view", "looking"]);

/**
 * A view that is only a compass word ("North", "West Facing", "East Facing
 * (Home)") looks that way. One that names roads or junctions beside it
 * ("Zoom west - Westbourne Terrace jct", "WEST-A13 Commercial Rd ...") says
 * where the camera is or what it covers, not a certain direction, and stays
 * text.
 */
function directionOf(view: string): DirectionRef {
  const words = view
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .match(/[a-z]+/g)
    ?.filter((word) => !FILLER.has(word));
  const compass = words === undefined ? undefined : COMPASS[words.join("")];
  return compass === undefined
    ? { value: "unknown", basis: "text", text: view }
    : { value: "unknown", basis: "compass", compass };
}

/**
 * TfL's JamCam list (`/Place/Type/JamCam`): a place per camera whose
 * `additionalProperties` hold, by key, its availability, still, clip and
 * view. The list is cached at the CDN for up to a day, so an available
 * camera's state is unknown: only an explicit `available=false` reads
 * offline. A property's `modified` is when TfL last edited the record (days
 * or weeks back), not when the still was taken, so no reading carries an
 * image time. A camera has one view. The view text hints at presets of a movable
 * camera, but it is free text, so no camera is flagged ptz from it.
 */
export function parseTfl(
  feed: CamerasCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const dc: DraftContext = { fetchedAt: ctx.fetchedAt, out };
  for (const body of payloads["main"] ?? []) {
    const doc = jsonOf(body, "the JamCam list");
    if (!Array.isArray(doc)) throw new Error("the JamCam list is no array of places");
    for (const record of doc) {
      const place = isRecord(record) ? record : {};
      const cameraId = textOf(place["id"]);
      const point = lonLat(place["lon"], place["lat"]);
      if (cameraId === undefined || point === undefined) {
        out.rejected = (out.rejected ?? 0) + 1;
        continue;
      }
      const properties = propertiesOf(place);
      const name = textOf(place["commonName"]);
      const view = properties.get("view")?.value;
      const available = properties.get("available");
      const image = properties.get("imageUrl");
      const clip = properties.get("videoUrl");
      out.features.push(
        cameraDraft(feed, dc, {
          cameraId,
          point,
          names: name === undefined ? [] : [{ lang: "en", text: name }],
          type: "traffic",
          refreshSec: REFRESH_SEC,
          imageRedistribution: imageRedistributionOf(feed, "allowed"),
          views: [
            view === undefined
              ? { key: "0" }
              : { key: "0", name: [{ lang: "en", text: view }], direction: directionOf(view) },
          ],
        }),
      );
      out.observations.push(
        imageReading(feed, dc, {
          cameraId,
          viewKey: "0",
          status: available?.value.toLowerCase() === "false" ? "offline" : "unknown",
          point,
          ...(image === undefined ? {} : { imageUrl: image.value }),
          ...(clip === undefined ? {} : { streamUrl: clip.value, streamType: "mp4" as const }),
        }),
      );
    }
  }
  return out;
}
