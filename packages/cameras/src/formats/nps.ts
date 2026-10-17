import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import { cameraDraft, type DraftContext, imageReading, imageRedistributionOf } from "../camera.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";
import { isRecord, jsonOf, lonLat, positionSkip, textOf } from "../records.js";

/** The page the air quality cameras share; their descriptions speak of air quality and weather. */
const AIR_QUALITY_PAGE = "/subjects/air/webcams.htm";

/** The statuses NPS gives a webcam. */
const STATUSES = new Set(["Active", "Inactive"]);

/** NPS writes some addresses with its host in front of an absolute address. */
const DOUBLED_HOST = /^https?:\/\/[^/]*?(?=https?:\/\/)/;

/**
 * The ISO 3166-2 code of the one state the camera's parks lie in; none where
 * they lie in several (`NC,TN`), as the camera is in only one of them.
 */
function stateOf(parks: unknown): string | undefined {
  const states = new Set(
    (Array.isArray(parks) ? parks : []).flatMap((park) =>
      (isRecord(park) ? (textOf(park["states"]) ?? "") : "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^[A-Z]{2}$/.test(s)),
    ),
  );
  return states.size === 1 ? `US-${[...states][0]}` : undefined;
}

/**
 * The National Park Service's webcam list: a camera per record, its NPS page
 * as the camera's link. The API has no live image: a record's `images` are
 * stock photos of the place, kept as the camera's site images, so no reading
 * carries an image address, and the live view is the page. The camera's
 * `credit` is credited as its upstream, and its parks' one state places it. `Active` says no more than that the page lists the
 * camera, so it reads unknown, while `Inactive` reads offline; any other
 * status reads unknown and is skipped as an unknown value. The park's own
 * status message ("Please excuse our mess!…") rides with the reading. The
 * list repeats
 * a record under one id now and then; the first stands. A record without an
 * id is skipped as malformed, one without coordinates as having no geometry.
 */
export function parseNps(
  feed: CamerasCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const dc: DraftContext = { fetchedAt: ctx.fetchedAt, out };
  const seen = new Set<string>();
  for (const body of payloads["main"] ?? []) {
    const doc = jsonOf(body, "the webcam list");
    if (!isRecord(doc) || !Array.isArray(doc["data"])) {
      throw new Error("the webcam list carries no data");
    }
    for (const record of doc["data"]) {
      const webcam = isRecord(record) ? record : {};
      const cameraId = textOf(webcam["id"]);
      if (cameraId === undefined) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      if (seen.has(cameraId)) continue;
      const point = lonLat(webcam["longitude"], webcam["latitude"]);
      if (point === undefined) {
        recordSkipped(feed.id, positionSkip(webcam["longitude"], webcam["latitude"]));
        continue;
      }
      seen.add(cameraId);
      const title = textOf(webcam["title"]);
      const description = textOf(webcam["description"]);
      const page = textOf(webcam["url"])?.replace(DOUBLED_HOST, "");
      const status = textOf(webcam["status"]);
      if (status !== undefined && !STATUSES.has(status)) recordSkipped(feed.id, "unknown_value");
      const credit = textOf(webcam["credit"]);
      const message = textOf(webcam["statusMessage"]);
      const state = stateOf(webcam["relatedParks"]);
      const images = (Array.isArray(webcam["images"]) ? webcam["images"] : []).flatMap((image) => {
        const url = isRecord(image) ? textOf(image["url"])?.replace(DOUBLED_HOST, "") : undefined;
        return url === undefined ? [] : [{ url, category: "site" as const }];
      });
      out.features.push(
        cameraDraft(feed, dc, {
          cameraId,
          point,
          names: title === undefined ? [] : [{ lang: "en", text: title }],
          ...(description === undefined
            ? {}
            : { description: [{ lang: "en", text: description }] }),
          type: page?.includes(AIR_QUALITY_PAGE) ? "weather" : "landscape",
          ...(page === undefined ? {} : { detailUrl: page }),
          admin: { country: "US", ...(state === undefined ? {} : { subdivision: state }) },
          images,
          ...(credit === undefined ? {} : { upstream: credit }),
          imageRedistribution: imageRedistributionOf(feed, "allowed"),
          views: [{ key: "0" }],
        }),
      );
      out.observations.push(
        imageReading(feed, dc, {
          cameraId,
          viewKey: "0",
          status: status === "Inactive" ? "offline" : "unknown",
          ...(message === undefined ? {} : { statusText: [{ lang: "en", text: message }] }),
          point,
          ...(credit === undefined ? {} : { upstream: credit }),
        }),
      );
    }
  }
  return out;
}
