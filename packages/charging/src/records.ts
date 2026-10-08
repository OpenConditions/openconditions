import type { CatalogFeed } from "@openconditions/ingest-framework";

/** What a charging record takes from its feed. */
export type ChargingFeed = Pick<
  CatalogFeed,
  "id" | "format" | "attribution" | "license" | "licenseUrl" | "accessMode" | "onDemand" | "region"
>;

/** The upstream publishers an aggregator took a record from. */
export type Upstream = { publisher: string; recordId?: string; license?: string }[];

/** An instant in UTC at second precision, as the drafts carry it. */
export function utcInstant(at: Date): string {
  return at.toISOString().replace(/\.000Z$/, "Z");
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
      : { upstream: upstream.map((u) => ({ ...u })) }),
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

export const clean = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text ? text : undefined;
};

/** A web page the model can hold: http(s) only, a bare `www.` host taken as https. */
export function webUrl(value: string | undefined): string | undefined {
  const text = clean(value);
  if (text === undefined) return undefined;
  const url = /^www\./i.test(text) ? `https://${text}` : text;
  if (!URL.canParse(url)) return undefined;
  const { protocol } = new URL(url);
  return protocol === "http:" || protocol === "https:" ? url : undefined;
}
