import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
  recordSkipped,
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
import { isRecord, jsonOf, lonLat, numberOf, positionSkip, textOf } from "../records.js";

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
 * The documented station states that say nothing of a fault: no fault, a
 * doubted fault, a doubt cancelled, a repair done or interrupted.
 */
const OTHER_STATES: ReadonlySet<string> = new Set([
  "OK",
  "OK_FAULT_DOUBT_CANCELLED",
  "FAULT_DOUBT",
  "REPAIR_MAINTENANCE_DONE",
  "REPAIR_INTERRUPTED",
]);

/**
 * The camera type a station's stated purpose gives: road weather (`keli`),
 * or traffic (`liikenne`) and tunnel (`tunneli`), whose cameras watch the
 * traffic in it. Without details, or for another purpose, the station is a
 * weather camera, as the service is a weather camera service.
 */
const PURPOSES: Readonly<Record<string, CameraType>> = {
  keli: "weather",
  liikenne: "traffic",
  tunneli: "traffic",
};

/**
 * The ISO 3166-2:FI code of each region (`maakunta`) by the Finnish name the
 * details give as `province`; ISO names the regions by their Finnish names.
 */
const PROVINCES: Readonly<Record<string, string>> = {
  Ahvenanmaa: "FI-01",
  "Ahvenanmaan maakunta": "FI-01",
  "Etelä-Karjala": "FI-02",
  "Etelä-Pohjanmaa": "FI-03",
  "Etelä-Savo": "FI-04",
  Kainuu: "FI-05",
  "Kanta-Häme": "FI-06",
  "Keski-Pohjanmaa": "FI-07",
  "Keski-Suomi": "FI-08",
  Kymenlaakso: "FI-09",
  Lappi: "FI-10",
  Pirkanmaa: "FI-11",
  Pohjanmaa: "FI-12",
  "Pohjois-Karjala": "FI-13",
  "Pohjois-Pohjanmaa": "FI-14",
  "Pohjois-Savo": "FI-15",
  "Päijät-Häme": "FI-16",
  Satakunta: "FI-17",
  Uusimaa: "FI-18",
  "Varsinais-Suomi": "FI-19",
};

/** The `province` of Finavia's airports, which lie in no one region. */
const AIRPORTS = "Finavia lentokentät";

/** The road number of stations on no road (airports, Åland): the address places them nowhere. */
const NO_ROAD = "99999";

/** A preset's direction along the station's road address; crossing roads and special views have none on it. */
const DIRECTIONS: Readonly<Record<string, DirectionRef>> = {
  INCREASING_DIRECTION: { value: "positive", basis: "road_reference" },
  DECREASING_DIRECTION: { value: "negative", basis: "road_reference" },
};

/**
 * The documented preset directions that give none along the station's road:
 * an unknown one, either direction of the crossing road, and the special
 * views (the road surface, a junction).
 */
const NO_DIRECTION: ReadonlySet<string> = new Set([
  "UNKNOWN",
  "CROSSING_ROAD_INCREASING_DIRECTION",
  "CROSSING_ROAD_DECREASING_DIRECTION",
  "SPECIAL_DIRECTION",
]);

/** The documented collection statuses: gathering, or removed for a while or for good. */
const COLLECTION_STATUSES: ReadonlySet<string> = new Set([
  "GATHERING",
  "REMOVED_TEMPORARILY",
  "REMOVED_PERMANENTLY",
]);

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
  /** The road address's section and the distance from its start, in metres. */
  roadSection?: number;
  sectionDistanceM?: number;
  /** What the station is for, as the publisher states it (`keli`, `liikenne`). */
  purpose?: string;
  municipality?: string;
  province?: string;
  /** The station's id in the road register (`Livi…`). */
  liviId?: string;
  presets: Map<string, { name?: string; direction?: string }>;
}

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * The stations of the `sites` list; one without an id or a place is skipped,
 * and so is a preset without an id.
 */
function stationsOf(feed: CamerasCatalogFeed, body: Buffer): Station[] {
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
    if (!isRecord(props) || id === undefined) {
      recordSkipped(feed.id, "malformed");
      return [];
    }
    if (point === undefined) {
      recordSkipped(feed.id, positionSkip(coordinates[0], coordinates[1]));
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
          if (presetId === undefined) {
            recordSkipped(feed.id, "malformed");
            return [];
          }
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
 * is skipped as malformed and its station keeps the list's data: the details
 * are fetched one by one, and one bad answer must not cost the others. A
 * preset of the details without an id is skipped too, its view keeping the
 * list's data.
 */
function detailsOf(
  feed: CamerasCatalogFeed,
  bodies: readonly Buffer[],
): Map<string, StationDetails> {
  const details = new Map<string, StationDetails>();
  for (const body of bodies) {
    let doc: unknown;
    try {
      doc = JSON.parse(body.toString("utf8"));
    } catch {
      recordSkipped(feed.id, "malformed");
      continue;
    }
    const props = isRecord(doc) ? doc["properties"] : undefined;
    const id = isRecord(props) ? textOf(props["id"]) : undefined;
    if (!isRecord(props) || id === undefined) {
      recordSkipped(feed.id, "malformed");
      continue;
    }
    const names = isRecord(props["names"]) ? props["names"] : {};
    const address = isRecord(props["roadAddress"]) ? props["roadAddress"] : {};
    const number = textOf(address["roadNumber"]);
    const road = number === NO_ROAD ? undefined : number;
    const roadSection = numberOf(address["roadSection"]);
    const sectionDistanceM = numberOf(address["distanceFromRoadSectionStart"]);
    const refreshSec = numberOf(props["collectionInterval"]);
    const purpose = textOf(props["purpose"]);
    const municipality = textOf(props["municipality"]);
    const province = textOf(props["province"]);
    const liviId = textOf(props["liviId"]);
    details.set(id, {
      names: NAME_LANGUAGES.flatMap((lang) => {
        const text = textOf(names[lang]);
        return text === undefined ? [] : [{ lang, text }];
      }),
      ...(refreshSec === undefined || refreshSec <= 0 ? {} : { refreshSec }),
      ...(road === undefined ? {} : { roadNumber: road }),
      ...(roadSection === undefined ? {} : { roadSection }),
      ...(sectionDistanceM === undefined ? {} : { sectionDistanceM }),
      ...(purpose === undefined ? {} : { purpose }),
      ...(municipality === undefined ? {} : { municipality }),
      ...(province === undefined ? {} : { province }),
      ...(liviId === undefined ? {} : { liviId }),
      presets: new Map(
        listOf(props["presets"]).flatMap((preset) => {
          const presetId = isRecord(preset) ? textOf(preset["id"]) : undefined;
          if (presetId === undefined) {
            recordSkipped(feed.id, "malformed");
            return [];
          }
          const name = textOf((preset as Record<string, unknown>)["presentationName"]);
          const direction = textOf((preset as Record<string, unknown>)["direction"]);
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
 * malformed document fails the read, unless `lenient`: the daily full parse
 * still has its stations and presets to write, so there it is skipped as
 * malformed and the presets are read without image times. A preset entry
 * without an id, or whose image time cannot be read, is skipped as malformed;
 * one with no image time yet is not.
 */
function imageTimesOf(
  feed: CamerasCatalogFeed,
  bodies: readonly Buffer[],
  lenient = false,
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
      if (!lenient) throw error;
      recordSkipped(feed.id, "malformed");
      continue;
    }
    for (const station of doc["stations"]) {
      for (const preset of listOf(isRecord(station) ? station["presets"] : undefined)) {
        const id = isRecord(preset) ? textOf(preset["id"]) : undefined;
        if (id === undefined) {
          recordSkipped(feed.id, "malformed");
          continue;
        }
        const at = textOf((preset as Record<string, unknown>)["measuredTime"]);
        if (at === undefined) continue;
        if (!Number.isFinite(Date.parse(at))) {
          recordSkipped(feed.id, "malformed");
          continue;
        }
        times.set(id, at);
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
 * each preset and give its direction on the road, the collection interval,
 * the road address, the municipality and region, and the road-register id.
 * A station without details keeps the list's technical name.
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
  const details = detailsOf(feed, payloads["details"] ?? []);
  const index = new Map<string, PresetSubject[]>();
  for (const station of sites.flatMap((body) => stationsOf(feed, body))) {
    const detail = details.get(station.id);
    if (
      station.collectionStatus !== undefined &&
      !COLLECTION_STATUSES.has(station.collectionStatus)
    ) {
      recordSkipped(feed.id, "unknown_value");
    }
    if (
      station.state !== undefined &&
      !FAULT_STATES.has(station.state) &&
      !OTHER_STATES.has(station.state)
    ) {
      recordSkipped(feed.id, "unknown_value");
    }
    if (detail?.purpose !== undefined && PURPOSES[detail.purpose] === undefined) {
      recordSkipped(feed.id, "unknown_value");
    }
    const subdivision = PROVINCES[detail?.province ?? ""];
    if (
      detail?.province !== undefined &&
      detail.province !== AIRPORTS &&
      subdivision === undefined
    ) {
      recordSkipped(feed.id, "unknown_value");
    }
    const stationOffline =
      (station.collectionStatus?.startsWith("REMOVED") ?? false) ||
      FAULT_STATES.has(station.state ?? "");
    const views: ViewInput[] = station.presets.map((preset) => {
      const own = detail?.presets.get(preset.id);
      const direction = DIRECTIONS[own?.direction ?? ""];
      if (
        own?.direction !== undefined &&
        direction === undefined &&
        !NO_DIRECTION.has(own.direction)
      ) {
        recordSkipped(feed.id, "unknown_value");
      }
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
        ...(detail?.roadNumber === undefined ||
        detail.roadSection === undefined ||
        detail.sectionDistanceM === undefined
          ? {}
          : {
              // The Finnish road address: road, section, and metres from the section's start.
              linear: {
                system: "provider" as const,
                ref: `${detail.roadNumber}/${detail.roadSection}`,
                from: detail.sectionDistanceM,
                authority: "fi:tieosoite",
              },
            }),
        ...(detail === undefined
          ? {}
          : {
              admin: {
                country: "FI",
                ...(subdivision === undefined ? {} : { subdivision }),
                ...(detail.municipality === undefined ? {} : { municipality: detail.municipality }),
              },
            }),
        ...(detail?.liviId === undefined
          ? {}
          : { external: [{ system: "fi:livi", code: detail.liviId }] }),
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
    ...readingsOf(feed, dc, index, imageTimesOf(feed, payloads["status"] ?? [], true)),
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
  const observations = readingsOf(feed, dc, index, imageTimesOf(feed, payloads["status"] ?? []));
  return { observations, rejected: out.rejected };
}
