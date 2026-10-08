import type { CatalogFeed } from "@openconditions/ingest-framework";
import type { ImageRedistribution } from "./camera.js";

/**
 * An encoded dot, slash or backslash, which an upstream may decode into a
 * segment climbing out of an image host's path prefix: refused in a feed's
 * `imageHosts` entry and in a still's path below one.
 */
export const ENCODED_SEPARATOR = /%(?:2e|2f|5c)/i;

/**
 * What a camera record takes from its feed: its identity, its terms, the
 * hosts its stills live on, and what the images' licence allows where the
 * feed says so itself.
 */
export type CamerasFeed = Pick<
  CatalogFeed,
  "id" | "format" | "attribution" | "license" | "licenseUrl" | "accessMode" | "onDemand" | "region"
> & {
  cameras?: { imageHosts?: readonly string[]; imageRedistribution?: ImageRedistribution };
};

/** An instant in UTC at second precision, as the drafts carry it. */
export function utcInstant(at: Date): string {
  return at.toISOString().replace(/\.000Z$/, "Z");
}

/**
 * A publisher's camera id as a feature id takes it: every character outside
 * `[A-Za-z0-9._:-]` becomes `_`.
 */
export const cameraKey = (cameraId: string): string => cameraId.replace(/[^A-Za-z0-9._:-]/g, "_");

/** The id of a camera's feature. */
export function cameraFeatureId(feed: Pick<CamerasFeed, "id">, cameraId: string): string {
  return `oc:feature:${feed.id}:${cameraKey(cameraId)}`;
}

/**
 * When an on-demand feed's answer fetched at `fetchedAt` stops being current:
 * `onDemand.ttlSec` later. Undefined for a bulk feed, whose next poll replaces
 * the answer.
 */
export function freshness(feed: CamerasFeed, fetchedAt: string): Record<string, unknown> {
  const ttlSec = feed.onDemand?.ttlSec;
  if (ttlSec === undefined) return { fetchedAt };
  return { fetchedAt, expiresAt: utcInstant(new Date(Date.parse(fetchedAt) + ttlSec * 1000)) };
}

/**
 * A record's provenance. `upstream` credits the publisher a relaying feed
 * took the record from, beside the feed's own attribution.
 */
export function provenance(
  feed: CamerasFeed,
  recordId: string,
  upstream?: string,
): Record<string, unknown> {
  return {
    origin: "feed",
    sourceId: feed.id,
    sourceFormat: feed.format,
    accessMode: feed.accessMode ?? "bulk",
    recordId,
    attribution: {
      provider: feed.attribution,
      license: feed.license,
      ...(feed.licenseUrl === undefined ? {} : { licenseUrl: feed.licenseUrl }),
    },
    ...(upstream === undefined ? {} : { upstream: [{ publisher: upstream }] }),
    privacy: { class: "authoritative" },
  };
}

export function pointLocation(point: readonly [number, number]): Record<string, unknown> {
  return {
    geometry: { type: "Point", coordinates: [point[0], point[1]] },
    extent: "point",
    geometryOrigin: "source",
    fuzziness: "exact",
  };
}

export const UNLOCATED = {
  geometry: null,
  extent: "none",
  geometryOrigin: "none",
  fuzziness: "exact",
} as const;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A payload's JSON document; a body that is not JSON fails the parse. */
export function jsonOf(body: Buffer, what: string): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new Error(`${what} is not JSON: ${(error as Error).message}`);
  }
}

/** A string field, trimmed; a number is read as its decimal text, anything else is absent. */
export function textOf(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? clean(value) : undefined;
}

/** A finite number, or a string holding one; anything else is absent. */
export function numberOf(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** A `[lon, lat]` the model can place: finite, in range, and not the null island a missing position reads as. */
export function lonLat(lon: unknown, lat: unknown): [number, number] | undefined {
  const x = numberOf(lon);
  const y = numberOf(lat);
  if (x === undefined || y === undefined) return undefined;
  if (Math.abs(x) > 180 || Math.abs(y) > 90 || (x === 0 && y === 0)) return undefined;
  return [x, y];
}

export const clean = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text ? text : undefined;
};

/** A URL the model can hold with one of `protocols`; anything else is undefined. */
export function urlOf(
  value: string | undefined,
  protocols: readonly string[] = ["http:", "https:"],
): string | undefined {
  const text = clean(value);
  if (text === undefined || !URL.canParse(text)) return undefined;
  return protocols.includes(new URL(text).protocol) ? text : undefined;
}
