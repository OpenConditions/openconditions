import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
  type StatusIndex,
  type StatusOutput,
  type StatusSubject,
} from "@openconditions/ingest-framework";
import type { DirectionRef, LocalizedText } from "@openconditions/model";
import {
  type CameraStatus,
  type CameraType,
  cameraDraft,
  type DraftContext,
  imageReading,
  imageRedistributionOf,
  type ViewInput,
} from "../camera.js";
import type { CamerasCatalogFeed } from "../feed-schema.js";
import { isRecord, jsonOf, lonLat, numberOf, textOf } from "../records.js";

/** Where every preset's still is served; the list and the details name the preset only. */
const IMAGES = "https://weathercam.digitraffic.fi";

/** The names a station's details give, in Finnish, Swedish and English. */
const NAME_LANGUAGES = ["fi", "sv", "en"] as const;

/**
 * Station states of an open fault or a repair not yet done. A doubted fault
 * is not one, and a station whose repair was interrupted has been seen
 * delivering current images: its image time tells whether it does.
 */
const FAULT_STATES: ReadonlySet<string> = new Set([
  "FAULT_CONFIRMED",
  "FAULT_CONFIRMED_NOT_FIXED_IN_NEAR_FUTURE",
  "REPAIR_REQUEST_POSTED",
]);

/**
 * The camera type a station's stated purpose gives: road weather (`keli`)
 * or traffic (`liikenne`). Without details, or for another purpose, the
 * station is a weather camera, as the service is a weather camera service.
 */
const PURPOSES: Readonly<Record<string, CameraType>> = { keli: "weather", liikenne: "traffic" };

/** A preset's direction along the station's road address; crossing roads and special views have none on it. */
const DIRECTIONS: Readonly<Record<string, DirectionRef>> = {
  INCREASING_DIRECTION: { value: "positive", basis: "road_reference" },
  DECREASING_DIRECTION: { value: "negative", basis: "road_reference" },
};

/**
 * Where a preset's image readings belong, as the full parse found the preset:
 * its station, its view, the station's place and collection interval,
 * whether the station's own state already says the preset delivers nothing,
 * and whether the station says it is collecting images.
 */
interface PresetSubject extends StatusSubject {
  componentKey: string;
  offline: boolean;
  /** The station's collection status is `GATHERING`; only then can a preset read online. */
  gathering: boolean;
  /** The station's collection interval in seconds, which its details give. */
  refreshSec?: number;
}

const isPresetSubject = (subject: StatusSubject): subject is PresetSubject =>
  typeof subject.componentKey === "string" && "offline" in subject;

interface Station {
  id: string;
  point: [number, number];
  name?: string;
  collectionStatus?: string;
  state?: string;
  presets: { id: string; inCollection: boolean }[];
}

interface StationDetails {
  names: LocalizedText[];
  refreshSec?: number;
  roadNumber?: string;
  /** What the station is for, as the publisher states it (`keli`, `liikenne`). */
  purpose?: string;
  presets: Map<string, { name?: string; direction?: string }>;
}

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The stations of the `sites` list; one without an id or a place is counted as rejected. */
function stationsOf(body: Buffer, out: ParseOutput): Station[] {
  const doc = jsonOf(body, "the weather camera station list");
  if (!isRecord(doc) || !Array.isArray(doc["features"])) {
    throw new Error("the weather camera station list carries no features");
  }
  return doc["features"].flatMap((feature): Station[] => {
    const props = isRecord(feature) ? feature["properties"] : undefined;
    const geometry = isRecord(feature) ? feature["geometry"] : undefined;
    const coordinates = isRecord(geometry) ? listOf(geometry["coordinates"]) : [];
    const id = isRecord(props) ? textOf(props["id"]) : undefined;
    const point = lonLat(coordinates[0], coordinates[1]);
    if (!isRecord(props) || id === undefined || point === undefined) {
      out.rejected = (out.rejected ?? 0) + 1;
      return [];
    }
    const name = textOf(props["name"]);
    const collectionStatus = textOf(props["collectionStatus"]);
    const state = textOf(props["state"]);
    return [
      {
        id,
        point,
        ...(name === undefined ? {} : { name }),
        ...(collectionStatus === undefined ? {} : { collectionStatus }),
        ...(state === undefined ? {} : { state }),
        presets: listOf(props["presets"]).flatMap((preset) => {
          const presetId = isRecord(preset) ? textOf(preset["id"]) : undefined;
          if (presetId === undefined) return [];
          return [
            {
              id: presetId,
              inCollection: (preset as Record<string, unknown>)["inCollection"] === true,
            },
          ];
        }),
      },
    ];
  });
}

/**
 * Each station's details by station id. A detail answer that cannot be read
 * is counted as rejected and its station keeps the list's data: the details
 * are fetched one by one, and one bad answer must not cost the others.
 */
function detailsOf(bodies: readonly Buffer[], out: ParseOutput): Map<string, StationDetails> {
  const details = new Map<string, StationDetails>();
  for (const body of bodies) {
    let doc: unknown;
    try {
      doc = JSON.parse(body.toString("utf8"));
    } catch {
      out.rejected = (out.rejected ?? 0) + 1;
      continue;
    }
    const props = isRecord(doc) ? doc["properties"] : undefined;
    const id = isRecord(props) ? textOf(props["id"]) : undefined;
    if (!isRecord(props) || id === undefined) {
      out.rejected = (out.rejected ?? 0) + 1;
      continue;
    }
    const names = isRecord(props["names"]) ? props["names"] : {};
    const road = isRecord(props["roadAddress"])
      ? textOf(props["roadAddress"]["roadNumber"])
      : undefined;
    const refreshSec = numberOf(props["collectionInterval"]);
    const purpose = textOf(props["purpose"]);
    details.set(id, {
      names: NAME_LANGUAGES.flatMap((lang) => {
        const text = textOf(names[lang]);
        return text === undefined ? [] : [{ lang, text }];
      }),
      ...(refreshSec === undefined || refreshSec <= 0 ? {} : { refreshSec }),
      ...(road === undefined ? {} : { roadNumber: road }),
      ...(purpose === undefined ? {} : { purpose }),
      presets: new Map(
        listOf(props["presets"]).flatMap((preset) => {
          if (!isRecord(preset)) return [];
          const presetId = textOf(preset["id"]);
          if (presetId === undefined) return [];
          const name = textOf(preset["presentationName"]);
          const direction = textOf(preset["direction"]);
          return [
            [
              presetId,
              {
                ...(name === undefined ? {} : { name }),
                ...(direction === undefined ? {} : { direction }),
              },
            ] as const,
          ];
        }),
      ),
    });
  }
  return details;
}

/**
 * Each preset's latest image time, from the `status` data document. A
 * malformed document fails the read, unless `rejected` is given: the daily
 * full parse still has its stations and presets to write, so there it is
 * counted as rejected and the presets are read without image times.
 */
function imageTimesOf(
  bodies: readonly Buffer[],
  rejected?: Pick<ParseOutput, "rejected">,
): Map<string, string> {
  const times = new Map<string, string>();
  for (const body of bodies) {
    let doc: unknown;
    try {
      doc = jsonOf(body, "the weather camera data document");
      if (!isRecord(doc) || !Array.isArray(doc["stations"])) {
        throw new Error("the weather camera data document carries no stations");
      }
    } catch (error) {
      if (rejected === undefined) throw error;
      rejected.rejected = (rejected.rejected ?? 0) + 1;
      continue;
    }
    for (const station of doc["stations"]) {
      for (const preset of listOf(isRecord(station) ? station["presets"] : undefined)) {
        if (!isRecord(preset)) continue;
        const id = textOf(preset["id"]);
        const at = textOf(preset["measuredTime"]);
        if (id !== undefined && at !== undefined && Number.isFinite(Date.parse(at))) {
          times.set(id, at);
        }
      }
    }
  }
  return times;
}

/**
 * A preset's status: offline when the station's state or the preset's
 * collection says so; else, for a station that says it is gathering, online
 * while its last image is within three collection intervals of the fetch and
 * stale after; unknown without an image time or an interval to judge it by,
 * or when the station's collection status is missing or not one we know.
 */
function statusOf(
  subject: PresetSubject,
  imageAt: string | undefined,
  fetchedAt: string,
): CameraStatus {
  if (subject.offline) return "offline";
  if (imageAt === undefined || subject.refreshSec === undefined) return "unknown";
  const age = (Date.parse(fetchedAt) - Date.parse(imageAt)) / 1000;
  if (age > 3 * subject.refreshSec) return "stale";
  return subject.gathering ? "online" : "unknown";
}

/** The image reading of one preset, as both the full and the status-only parse write it. */
function presetReading(
  feed: CamerasCatalogFeed,
  dc: DraftContext,
  subject: PresetSubject,
  imageAt: string | undefined,
): RecordDraft {
  const still = `${IMAGES}/${encodeURIComponent(subject.componentKey)}.jpg`;
  return imageReading(feed, dc, {
    cameraId: subject.stationId,
    viewKey: subject.componentKey,
    status: statusOf(subject, imageAt, dc.fetchedAt),
    imageUrl: still,
    thumbnailUrl: `${still}?thumbnail=true`,
    ...(imageAt === undefined ? {} : { imageAt }),
    ...(subject.point === undefined ? {} : { point: subject.point }),
  });
}

/**
 * The readings of every preset the index holds, in its order, dated by the
 * data document; a preset the document names that the index does not is
 * counted as rejected.
 */
function readingsOf(
  feed: CamerasCatalogFeed,
  dc: DraftContext,
  index: StatusIndex,
  times: ReadonlyMap<string, string>,
): RecordDraft[] {
  for (const preset of times.keys()) {
    if (!index.has(preset)) dc.out.rejected = (dc.out.rejected ?? 0) + 1;
  }
  return [...index.entries()].flatMap(([preset, subjects]) =>
    subjects.filter(isPresetSubject).map((s) => presetReading(feed, dc, s, times.get(preset))),
  );
}

/**
 * Fintraffic's weather cameras: the station list (`sites`), each station's
 * details (`details`, one answer per station) and the latest image time of
 * every preset (`status`). A station is a camera and each preset one of its
 * views; the details name the station in Finnish, Swedish and English, name
 * each preset and give its direction on the road and the collection
 * interval. A station without details keeps the list's technical name.
 */
export function parseDigitraffic(
  feed: CamerasCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const sites = payloads["sites"] ?? [];
  if (sites.length === 0) return out;
  const dc: DraftContext = { fetchedAt: ctx.fetchedAt, out };
  const details = detailsOf(payloads["details"] ?? [], out);
  const index = new Map<string, PresetSubject[]>();
  for (const station of sites.flatMap((body) => stationsOf(body, out))) {
    const detail = details.get(station.id);
    const stationOffline =
      (station.collectionStatus?.startsWith("REMOVED") ?? false) ||
      FAULT_STATES.has(station.state ?? "");
    const views: ViewInput[] = station.presets.map((preset) => {
      const own = detail?.presets.get(preset.id);
      const direction = DIRECTIONS[own?.direction ?? ""];
      return {
        key: preset.id,
        ...(own?.name === undefined ? {} : { name: [{ lang: "fi", text: own.name }] }),
        ...(direction === undefined ? {} : { direction }),
      };
    });
    const names =
      detail !== undefined && detail.names.length > 0
        ? detail.names
        : station.name === undefined
          ? []
          : [{ lang: "und", text: station.name }];
    out.features.push(
      cameraDraft(feed, dc, {
        cameraId: station.id,
        point: station.point,
        names,
        type: PURPOSES[detail?.purpose ?? ""] ?? "weather",
        ...(detail?.roadNumber === undefined ? {} : { road: { ref: detail.roadNumber } }),
        ...(detail?.refreshSec === undefined ? {} : { refreshSec: detail.refreshSec }),
        imageRedistribution: imageRedistributionOf(feed, "allowed"),
        views,
      }),
    );
    for (const preset of station.presets) {
      if (index.has(preset.id)) continue;
      index.set(preset.id, [
        {
          stationId: station.id,
          componentKey: preset.id,
          point: station.point,
          offline: stationOffline || !preset.inCollection,
          gathering: station.collectionStatus === "GATHERING",
          ...(detail?.refreshSec === undefined ? {} : { refreshSec: detail.refreshSec }),
        },
      ]);
    }
  }
  out.observations.push(
    ...readingsOf(feed, dc, index, imageTimesOf(payloads["status"] ?? [], out)),
  );
  out.statusIndex = index;
  return out;
}

/** The status-only reading of the `status` data document, placed through the last full parse's index. */
export function parseDigitrafficStatus(
  feed: CamerasCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
  index: StatusIndex,
): StatusOutput {
  const out = { rejected: 0 };
  const dc: DraftContext = { fetchedAt: ctx.fetchedAt, out };
  const observations = readingsOf(feed, dc, index, imageTimesOf(payloads["status"] ?? []));
  return { observations, rejected: out.rejected };
}
