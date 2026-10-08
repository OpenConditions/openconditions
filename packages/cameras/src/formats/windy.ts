import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import {
  type CameraStatus,
  type CameraType,
  cameraDraft,
  type DraftContext,
  imageReading,
  imageRedistributionOf,
} from "../camera.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";
import { isRecord, jsonOf, lonLat, textOf } from "../records.js";

/** An active webcam renews its image at least daily; one that did not is stale. */
const ACTIVE_WITHIN_MS = 24 * 3600 * 1000;

/** What a webcam shows, from the categories Windy files it under. */
const TYPES: Readonly<Record<string, CameraType>> = {
  landscape: "landscape",
  mountain: "landscape",
  forest: "landscape",
  lake: "landscape",
  river: "landscape",
  coast: "landscape",
  traffic: "traffic",
  city: "city",
  building: "city",
  square: "city",
  village: "city",
  port: "city",
  airport: "city",
  meteo: "weather",
  observatory: "weather",
  beach: "beach",
  sportArea: "other",
  indoor: "other",
};

/** The type of the first category Windy files the webcam under that is a known one. */
function typeOf(categories: unknown): CameraType {
  for (const category of Array.isArray(categories) ? categories : []) {
    const type = isRecord(category) ? TYPES[textOf(category["id"]) ?? ""] : undefined;
    if (type !== undefined) return type;
  }
  return "other";
}

/**
 * `active` webcams are online while their image is under a day old and stale
 * after that; `inactive` and `disabled` ones are offline. Any other status
 * (unapproved, rejected, duplicate, merged) is no webcam to show: undefined.
 */
function statusOf(
  status: string | undefined,
  updated: string | undefined,
  fetchedAt: string,
): CameraStatus | undefined {
  if (status === "inactive" || status === "disabled") return "offline";
  if (status !== "active") return undefined;
  const at = updated === undefined ? Number.NaN : Date.parse(updated);
  if (!Number.isFinite(at)) return "unknown";
  return Date.parse(fetchedAt) - at <= ACTIVE_WITHIN_MS ? "online" : "stale";
}

/** Whether `[lon, lat]` lies in the cell; a cell owns its west and south edges. */
const inCell = (point: readonly [number, number], cell: NonNullable<ParseContext["cell"]>) =>
  point[0] >= cell.west && point[0] < cell.east && point[1] >= cell.south && point[1] < cell.north;

/**
 * Windy's webcam list (`/webcams?bbox=`), one page per payload, read per grid
 * cell. A bbox answer reaches past the cell's edges, so only the webcams
 * inside the cell stay: the next cell keeps its own. A webcam has one view,
 * its current image, whose address carries a token that dies within minutes;
 * the terms let it be shown only linked to Windy's page or player.
 */
export function parseWindy(
  feed: CamerasCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const dc: DraftContext = { fetchedAt: ctx.fetchedAt, out };
  const seen = new Set<string>();
  for (const body of payloads["main"] ?? []) {
    const doc = jsonOf(body, "the webcam list");
    if (!isRecord(doc) || !Array.isArray(doc["webcams"])) {
      throw new Error("the webcam list carries no webcams");
    }
    for (const record of doc["webcams"]) {
      const webcam = isRecord(record) ? record : {};
      const cameraId = textOf(webcam["webcamId"]);
      const updated = textOf(webcam["lastUpdatedOn"]);
      const status = statusOf(textOf(webcam["status"]), updated, ctx.fetchedAt);
      if (cameraId === undefined || status === undefined || seen.has(cameraId)) continue;
      const location = isRecord(webcam["location"]) ? webcam["location"] : {};
      const point = lonLat(location["longitude"], location["latitude"]);
      if (point === undefined) {
        out.rejected = (out.rejected ?? 0) + 1;
        continue;
      }
      if (ctx.cell !== undefined && !inCell(point, ctx.cell)) continue;
      seen.add(cameraId);
      const current =
        isRecord(webcam["images"]) && isRecord(webcam["images"]["current"])
          ? webcam["images"]["current"]
          : {};
      const player = isRecord(webcam["player"]) ? webcam["player"] : {};
      const urls = isRecord(webcam["urls"]) ? webcam["urls"] : {};
      const title = textOf(webcam["title"]);
      const detailUrl = textOf(urls["detail"]);
      const embed = textOf(player["day"]) ?? textOf(player["live"]);
      const image = textOf(current["preview"]);
      const thumbnail = textOf(current["thumbnail"]);
      out.features.push(
        cameraDraft(feed, dc, {
          cameraId,
          point,
          names: title === undefined ? [] : [{ lang: "und", text: title }],
          type: typeOf(webcam["categories"]),
          ...(detailUrl === undefined ? {} : { detailUrl }),
          ...(embed === undefined ? {} : { playerEmbedUrl: embed }),
          imageRedistribution: imageRedistributionOf(feed, "link_only"),
          views: [{ key: "0" }],
        }),
      );
      out.observations.push(
        imageReading(feed, dc, {
          cameraId,
          viewKey: "0",
          status,
          point,
          ...(image === undefined ? {} : { imageUrl: image }),
          ...(thumbnail === undefined ? {} : { thumbnailUrl: thumbnail }),
          ...(updated === undefined ? {} : { imageAt: updated }),
        }),
      );
    }
  }
  return out;
}
