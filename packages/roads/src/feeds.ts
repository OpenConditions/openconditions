import { resolveAttribution } from "@openconditions/ingest-framework";
import type { RoadFeed } from "./feed-schema.js";
import type { SourceDescriptor } from "./types.js";

/** The catalogue fields a parser's source descriptor is made of. */
export type DescribedFeed = Pick<
  RoadFeed,
  | "id"
  | "attribution"
  | "country"
  | "license"
  | "licenseUrl"
  | "accessMode"
  | "laneNumbering"
  | "extrasAllow"
  | "geojson"
  | "flowMap"
  | "posListLonLat"
  | "excludeMessageTypes"
  | "srsName"
  | "timezone"
  | "localTimesMarkedUtc"
  | "speedUnit"
>;

/**
 * Maps a roads feed to the minimal SourceDescriptor that parsers receive at
 * call time. Keeps parsers decoupled from the full catalogue feed shape. The
 * attribution's `{year}` is the year of `at`, the poll.
 */
export function feedToSourceDescriptor(
  feed: DescribedFeed,
  at: Date = new Date(),
): SourceDescriptor {
  return {
    id: feed.id,
    attribution: resolveAttribution(feed.attribution, at),
    ...(feed.country !== undefined ? { country: feed.country } : {}),
    license: feed.license,
    licenseUrl: feed.licenseUrl,
    ...(feed.accessMode ? { accessMode: feed.accessMode } : {}),
    ...(feed.laneNumbering ? { laneNumbering: feed.laneNumbering } : {}),
    ...(feed.extrasAllow ? { extrasAllow: feed.extrasAllow } : {}),
    ...(feed.geojson ? { geojson: feed.geojson } : {}),
    ...(feed.flowMap ? { flowMap: feed.flowMap } : {}),
    ...(feed.posListLonLat ? { posListLonLat: true } : {}),
    ...(feed.excludeMessageTypes ? { excludeMessageTypes: feed.excludeMessageTypes } : {}),
    ...(feed.srsName ? { srsName: feed.srsName } : {}),
    ...(feed.timezone ? { timeZone: feed.timezone } : {}),
    ...(feed.localTimesMarkedUtc ? { localTimesMarkedUtc: true } : {}),
    ...(feed.speedUnit ? { speedUnit: feed.speedUnit } : {}),
  };
}
