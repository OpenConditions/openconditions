import type { CatalogFeed, RecordDraft } from "@openconditions/ingest-framework";
import { observationId } from "@openconditions/model";

/** What a hazard record takes from its feed: its identity, its format and its terms. */
export type HazardsFeed = Pick<
  CatalogFeed,
  "id" | "format" | "attribution" | "license" | "licenseUrl" | "country"
>;

/**
 * A publisher's id as a record's local id takes it: every character outside
 * `[A-Za-z0-9._:#-]` becomes `_`.
 */
export const localKey = (id: string): string => id.replace(/[^A-Za-z0-9._:#-]/g, "_");

/** The id of a situation of the feed. */
export function situationId(feed: Pick<HazardsFeed, "id">, localId: string): string {
  return `oc:situation:${feed.id}:${localKey(localId)}`;
}

/**
 * A record's provenance: the feed is its source, in the feed's format, read
 * in bulk; `recordId` is the publisher's own id of the record.
 */
export function provenance(
  feed: HazardsFeed,
  recordId: string,
  sourceUpdatedAt?: string,
): Record<string, unknown> {
  return {
    origin: "feed",
    sourceId: feed.id,
    sourceFormat: feed.format,
    accessMode: "bulk",
    recordId,
    ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
    attribution: {
      provider: feed.attribution,
      license: feed.license,
      ...(feed.licenseUrl === undefined ? {} : { licenseUrl: feed.licenseUrl }),
    },
    privacy: { class: "authoritative" },
  };
}

/** When the poll read the record, and when the publisher says it stops being current. */
export function freshness(fetchedAt: string, expiresAt?: string): Record<string, unknown> {
  return expiresAt === undefined ? { fetchedAt } : { fetchedAt, expiresAt };
}

/** A record placed at one position the publisher gives. */
export function pointLocation(
  point: readonly [number, number],
  fuzziness = "exact",
): Record<string, unknown> {
  return {
    geometry: { type: "Point", coordinates: [point[0], point[1]] },
    extent: "point",
    geometryOrigin: "source",
    fuzziness,
  };
}

/** A record that names no place at all. */
export const UNLOCATED = {
  geometry: null,
  extent: "none",
  geometryOrigin: "none",
  fuzziness: "extent_unknown",
} as const;

/** An observation draft with its id, which names its series and instant. */
export function withObservationId(feed: Pick<HazardsFeed, "id">, draft: RecordDraft): RecordDraft {
  return { id: observationId(feed.id, draft as never), ...draft };
}

/** An instant in UTC at second precision, as the drafts carry it. */
export function utcInstant(at: Date): string {
  return at.toISOString().replace(/\.000Z$/, "Z");
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
