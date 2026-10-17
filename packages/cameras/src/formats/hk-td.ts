import { isXmlObject, parseXmlDocument, xmlNodeToArray, xmlText } from "@openconditions/datex2";
import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { LocalizedText } from "@openconditions/model";
import { cameraDraft, type DraftContext, imageReading, imageRedistributionOf } from "../camera.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";
import { clean, lonLat, positionSkip } from "../records.js";

interface Image {
  /** Absent for an entry that names no camera. */
  key?: string;
  /** The territory's part (`Hong Kong Island`, `Kowloon`, `New Territories`) and the district in it. */
  region?: string;
  district?: string;
  description?: string;
  latitude?: string;
  longitude?: string;
  url?: string;
}

/** The `<image>` entries of a camera list; one that is no element reads as an entry without a key. */
function imagesOf(body: Buffer): Image[] {
  const doc = parseXmlDocument(body);
  const list = doc["image-list"];
  if (!isXmlObject(list)) throw new Error("the camera list has no image-list root");
  return xmlNodeToArray(list["image"]).flatMap((image): Image[] => {
    if (!isXmlObject(image)) return [{}];
    const field = (name: string) => clean(xmlText(image[name]));
    const key = field("key");
    const region = field("region");
    const district = field("district");
    const description = field("description");
    const latitude = field("latitude");
    const longitude = field("longitude");
    const url = field("url");
    return [
      {
        ...(key === undefined ? {} : { key }),
        ...(region === undefined ? {} : { region }),
        ...(district === undefined ? {} : { district }),
        ...(description === undefined ? {} : { description }),
        ...(latitude === undefined ? {} : { latitude }),
        ...(longitude === undefined ? {} : { longitude }),
        ...(url === undefined ? {} : { url }),
      },
    ];
  });
}

/** A description without the ` [key]` the publisher appends to every one. */
function nameOf(image: Image): string | undefined {
  const suffix = ` [${image.key}]`;
  const text = image.description;
  if (image.key === undefined) return clean(text);
  return clean(text?.endsWith(suffix) ? text.slice(0, -suffix.length) : text);
}

/** The department publishes that every snapshot is renewed every two minutes. */
const SNAPSHOT_REFRESH_SEC = 120;

/**
 * The Transport Department's traffic snapshot cameras: the English camera
 * list (`main`), and the same list in Traditional Chinese (`names`) for the
 * Chinese names. A camera has one view, its snapshot, which the publisher
 * renews every two minutes; the list says nothing of whether it works. Its
 * district is the camera's municipality, and its region describes the area. An
 * entry of the English list without a key is skipped as malformed, one
 * without a position as having no geometry.
 */
export function parseHkTdCameras(
  feed: CamerasCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const dc: DraftContext = { fetchedAt: ctx.fetchedAt, out };
  const chinese = new Map<string, string>();
  for (const body of payloads["names"] ?? []) {
    for (const image of imagesOf(body)) {
      const name = nameOf(image);
      if (image.key !== undefined && name !== undefined) chinese.set(image.key, name);
    }
  }
  for (const body of payloads["main"] ?? []) {
    for (const image of imagesOf(body)) {
      const key = image.key;
      const point = lonLat(image.longitude, image.latitude);
      if (key === undefined) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      if (point === undefined) {
        recordSkipped(feed.id, positionSkip(image.longitude, image.latitude));
        continue;
      }
      const english = nameOf(image);
      const zh = chinese.get(key);
      const names: LocalizedText[] = [
        ...(english === undefined ? [] : [{ lang: "en", text: english }]),
        ...(zh === undefined ? [] : [{ lang: "zh-Hant", text: zh }]),
      ];
      out.features.push(
        cameraDraft(feed, dc, {
          cameraId: key,
          point,
          names,
          type: "traffic",
          admin: {
            country: "HK",
            ...(image.district === undefined ? {} : { municipality: image.district }),
          },
          ...(image.region === undefined
            ? {}
            : { areaDescription: [{ lang: "en", text: image.region }] }),
          refreshSec: SNAPSHOT_REFRESH_SEC,
          imageRedistribution: imageRedistributionOf(feed, "allowed"),
          views: [{ key: "0" }],
        }),
      );
      out.observations.push(
        imageReading(feed, dc, {
          cameraId: key,
          viewKey: "0",
          status: "unknown",
          point,
          ...(image.url === undefined ? {} : { imageUrl: image.url }),
        }),
      );
    }
  }
  return out;
}
