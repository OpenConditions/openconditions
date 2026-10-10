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
  | "srsName"
  | "timezone"
>;

/**
 * Maps a roads feed to the minimal SourceDescriptor that parsers receive at
 * call time. Keeps parsers decoupled from the full catalogue feed shape.
 */
export function feedToSourceDescriptor(feed: DescribedFeed): SourceDescriptor {
  return {
    id: feed.id,
    attribution: feed.attribution,
    ...(feed.country !== undefined ? { country: feed.country } : {}),
    license: feed.license,
    licenseUrl: feed.licenseUrl,
    ...(feed.accessMode ? { accessMode: feed.accessMode } : {}),
    ...(feed.laneNumbering ? { laneNumbering: feed.laneNumbering } : {}),
    ...(feed.extrasAllow ? { extrasAllow: feed.extrasAllow } : {}),
    ...(feed.geojson ? { geojson: feed.geojson } : {}),
    ...(feed.flowMap ? { flowMap: feed.flowMap } : {}),
    ...(feed.posListLonLat ? { posListLonLat: true } : {}),
    ...(feed.srsName ? { srsName: feed.srsName } : {}),
    ...(feed.timezone ? { timeZone: feed.timezone } : {}),
  };
}
