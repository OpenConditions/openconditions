import type { CatalogFeed } from "@openconditions/ingest-framework";
import { Bcp47 } from "@openconditions/model";

/** What a charging record takes from its feed. */
export type ChargingFeed = Pick<
  CatalogFeed,
  "id" | "format" | "attribution" | "license" | "licenseUrl" | "accessMode" | "onDemand" | "region"
>;

/** The upstream publishers an aggregator took a record from. */
export type Upstream = NonNullable<import("@openconditions/model").MergedSource["upstream"]>;

/** An instant in UTC at second precision, as the drafts carry it. */
export function utcInstant(at: Date): string {
  return at.toISOString().replace(/\.000Z$/, "Z");
}

/** 0000-01-01T00:00:00Z and the last millisecond of 9999: the instants RFC 3339's four-digit years reach. */
const FIRST_INSTANT_MS = -62_167_219_200_000;
const LAST_INSTANT_MS = 253_402_300_799_999;

/**
 * {@link utcInstant} of a time in milliseconds; undefined for one that is
 * not a time, or whose year RFC 3339 cannot write (a source's `+012026`).
 */
export function utcInstantOf(ms: number): string | undefined {
  return Number.isFinite(ms) && ms >= FIRST_INSTANT_MS && ms <= LAST_INSTANT_MS
    ? utcInstant(new Date(ms))
    : undefined;
}

/** The id of a site's feature. */
export function siteId(feed: Pick<ChargingFeed, "id">, stationId: string): string {
  return `oc:feature:${feed.id}:${stationId}`;
}

/**
 * When an on-demand feed's answer fetched at `fetchedAt` stops being current:
 * `onDemand.ttlSec` later. Undefined for a bulk feed, whose next poll replaces
 * the answer.
 */
export function freshness(feed: ChargingFeed, fetchedAt: string): Record<string, unknown> {
  const ttlSec = feed.onDemand?.ttlSec;
  if (ttlSec === undefined) return { fetchedAt };
  return { fetchedAt, expiresAt: utcInstant(new Date(Date.parse(fetchedAt) + ttlSec * 1000)) };
}

export function provenance(
  feed: ChargingFeed,
  recordId: string,
  upstream?: Upstream,
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
    ...(upstream === undefined || upstream.length === 0
      ? {}
      : { upstream: structuredClone(upstream) }),
    privacy: { class: "authoritative" },
  };
}

export function pointLocation(point: [number, number]): Record<string, unknown> {
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

/**
 * A copy of `text` that shares no memory with the document it was cut from:
 * a substring of a parsed XML document can keep the whole decoded document
 * alive, and a status index outlives the poll.
 */
export const detached = (text: string): string => Buffer.from(text, "utf8").toString("utf8");

/**
 * A code table's own entry for `key`: a source value that names an
 * inherited property (`constructor`, `toString`, `__proto__`) is no entry.
 */
export function own<T>(table: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

export const clean = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text ? text : undefined;
};

/**
 * A source's language tag as the model holds it: a well-formed BCP 47 tag,
 * else `und`. A malformed tag says nothing about the text's language, and
 * the text is still worth keeping.
 */
export function languageOf(value: string | undefined): string {
  const tag = clean(value);
  return tag !== undefined && Bcp47.safeParse(tag).success ? tag : "und";
}

/** A web page the model can hold: http(s) only, a bare `www.` host taken as https. */
export function webUrl(value: string | undefined): string | undefined {
  const text = clean(value);
  if (text === undefined) return undefined;
  const url = /^www\./i.test(text) ? `https://${text}` : text;
  if (!URL.canParse(url)) return undefined;
  const { protocol } = new URL(url);
  return protocol === "http:" || protocol === "https:" ? url : undefined;
}
