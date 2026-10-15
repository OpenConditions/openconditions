import type { CatalogFeed, RecordDraft } from "@openconditions/ingest-framework";
import { observationId } from "@openconditions/model";

/** What a vehicle record takes from its feed: its identity, its format and its terms. */
export type VehiclesFeed = Pick<
  CatalogFeed,
  "id" | "format" | "attribution" | "license" | "licenseUrl"
>;

/**
 * A record's provenance: the feed is its source, in the feed's format, read
 * in bulk; `recordId` is the publisher's own id of the record, and
 * `upstream` credits the system or owner the publisher took it from.
 */
export function provenance(
  feed: VehiclesFeed,
  recordId: string,
  upstream?: string,
): Record<string, unknown> {
  return {
    origin: "feed",
    sourceId: feed.id,
    sourceFormat: feed.format,
    accessMode: "bulk",
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

/** A record placed at the position the publisher gives. */
export function pointLocation(point: readonly [number, number]): Record<string, unknown> {
  return {
    geometry: { type: "Point", coordinates: [point[0], point[1]] },
    extent: "point",
    geometryOrigin: "source",
    fuzziness: "exact",
  };
}

/** An observation draft with its id, which names its series and instant. */
export function withObservationId(feed: Pick<VehiclesFeed, "id">, draft: RecordDraft): RecordDraft {
  return { id: observationId(feed.id, draft as never), ...draft };
}

/** An instant in UTC, without milliseconds when it has none, as the drafts carry it. */
export function utcInstant(at: Date): string {
  return at.toISOString().replace(/\.000Z$/, "Z");
}

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

/** A `[lon, lat]` the model can place: finite, in range, and not the null island a missing position reads as. */
export function lonLat(position: unknown): [number, number] | undefined {
  if (!Array.isArray(position)) return undefined;
  const [x, y] = position as unknown[];
  if (typeof x !== "number" || typeof y !== "number") return undefined;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  if (Math.abs(x) > 180 || Math.abs(y) > 90 || (x === 0 && y === 0)) return undefined;
  return [x, y];
}
