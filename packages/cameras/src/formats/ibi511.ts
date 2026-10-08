import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import type { DirectionRef } from "@openconditions/model";
import {
  type CameraStatus,
  cameraDraft,
  type DraftContext,
  imageReading,
  imageRedistributionOf,
  type ViewInput,
} from "../camera.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";
import { isRecord, jsonOf, lonLat, numberOf, textOf } from "../records.js";

/** The IBI 511 systems OpenConditions reads publish in English. */
const LANG = "en";

/**
 * The compass words of a camera's `Direction`. "Inbound" and "Outbound" are
 * kept as the publisher's words; "Both Directions", "All Directions", "None"
 * and "Unknown" say nothing of where it looks.
 */
const COMPASS: Readonly<Record<string, DirectionRef>> = Object.fromEntries(
  (
    [
      ["N", ["Northbound", "North"]],
      ["E", ["Eastbound", "East"]],
      ["S", ["Southbound", "South"]],
      ["W", ["Westbound", "West"]],
    ] as const
  ).flatMap(([compass, words]) =>
    words.map((word) => [word, { value: "unknown", basis: "compass", compass }] as const),
  ),
);
const WORDS = new Set(["Inbound", "Outbound"]);

function directionOf(value: string | undefined): DirectionRef | undefined {
  if (value === undefined) return undefined;
  const compass = COMPASS[value];
  if (compass !== undefined) return compass;
  return WORDS.has(value) ? { value: "unknown", basis: "text", text: value } : undefined;
}

/** `Enabled` says a view is configured, not that its image is current; `Disabled` that it delivers none. */
const VIEW_STATUSES: Readonly<Record<string, CameraStatus>> = {
  Enabled: "unknown",
  Disabled: "offline",
};

interface View {
  key: string;
  sortId?: number;
  url?: string;
  videoUrl?: string;
  status: CameraStatus;
  description?: string;
}

/** A camera's views by `SortId`, those without one after, in the publisher's order. */
function viewsOf(value: unknown): View[] {
  const views = (Array.isArray(value) ? value : []).flatMap((view): View[] => {
    if (!isRecord(view)) return [];
    const key = textOf(view["Id"]);
    if (key === undefined) return [];
    const sortId = numberOf(view["SortId"]);
    const url = textOf(view["Url"]);
    const videoUrl = textOf(view["VideoUrl"]);
    const description = textOf(view["Description"]);
    return [
      {
        key,
        ...(sortId === undefined ? {} : { sortId }),
        ...(url === undefined ? {} : { url }),
        ...(videoUrl === undefined ? {} : { videoUrl }),
        status: VIEW_STATUSES[textOf(view["Status"]) ?? ""] ?? "unknown",
        ...(description === undefined ? {} : { description }),
      },
    ];
  });
  return views
    .map((view, order) => ({ view, order }))
    .sort(
      (a, b) =>
        (a.view.sortId ?? Number.POSITIVE_INFINITY) - (b.view.sortId ?? Number.POSITIVE_INFINITY) ||
        a.order - b.order,
    )
    .map(({ view }) => view);
}

/**
 * The IBI 511 camera list (`/api/v2/get/cameras`), as Ontario and the US
 * state systems serve it: a camera per record, a view per `Views[]` entry
 * keyed by the view's id, each with its still and, where the system has
 * one, its HLS stream. The camera carries the system's id and the id its
 * upstream `Source` gives it, under that source's own authority, so a
 * system relaying another's cameras can still link to them. The images'
 * licence is not stated: they are only linked, unless the feed says
 * otherwise.
 */
export function parseIbi511(
  feed: CamerasCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const dc: DraftContext = { fetchedAt: ctx.fetchedAt, out };
  for (const body of payloads["main"] ?? []) {
    const doc = jsonOf(body, "the camera list");
    if (!Array.isArray(doc)) throw new Error("the camera list is not an array");
    for (const record of doc) {
      const camera = isRecord(record) ? record : {};
      const cameraId = textOf(camera["Id"]);
      const point = lonLat(camera["Longitude"], camera["Latitude"]);
      if (cameraId === undefined || point === undefined) {
        out.rejected = (out.rejected ?? 0) + 1;
        continue;
      }
      const name = textOf(camera["Name"]);
      const location = textOf(camera["Location"]);
      const roadway = textOf(camera["Roadway"]);
      const source = textOf(camera["Source"]);
      const sourceId = textOf(camera["SourceId"]);
      const views = viewsOf(camera["Views"]);
      // The camera's direction is a view's only where the camera has one view.
      const direction = views.length === 1 ? directionOf(textOf(camera["Direction"])) : undefined;
      const viewInputs: ViewInput[] = views.map((view) => ({
        key: view.key,
        ...(view.description === undefined
          ? {}
          : { name: [{ lang: LANG, text: view.description }] }),
        ...(direction === undefined ? {} : { direction }),
      }));
      const names = name ?? location;
      out.features.push(
        cameraDraft(feed, dc, {
          cameraId,
          point,
          names: names === undefined ? [] : [{ lang: LANG, text: names }],
          ...(name !== undefined && location !== undefined
            ? { description: [{ lang: LANG, text: location }] }
            : {}),
          type: "traffic",
          ...(roadway === undefined ? {} : { road: { name: [{ lang: LANG, text: roadway }] } }),
          ...(source === undefined ? {} : { provider: source }),
          ...(source === undefined || sourceId === undefined
            ? {}
            : {
                externalIds: [
                  { scheme: "provider", id: sourceId, authority: `${feed.id}/${source}` },
                ],
              }),
          imageRedistribution: imageRedistributionOf(feed, "link_only"),
          views: viewInputs,
        }),
      );
      const seen = new Set<string>();
      for (const view of views.length === 0 ? [{ key: "0", status: "unknown" as const }] : views) {
        if (seen.has(view.key)) continue;
        seen.add(view.key);
        out.observations.push(
          imageReading(feed, dc, {
            cameraId,
            viewKey: view.key,
            status: view.status,
            point,
            ...("url" in view && view.url !== undefined ? { imageUrl: view.url } : {}),
            ...("videoUrl" in view && view.videoUrl !== undefined
              ? { streamUrl: view.videoUrl, streamType: "hls" as const }
              : {}),
          }),
        );
      }
    }
  }
  return out;
}
