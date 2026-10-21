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

/** An RFC 3339 date, with a time of day or without, and an offset or none. */
const RFC3339 = /^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d+)?)?(Z|[+-]\d\d:?\d\d)?)?$/i;

/**
 * Whether a time's `YYYY-MM-DD` names a day of the calendar: Date.parse rolls
 * a day the month does not have into the next (30 February is 2 March).
 */
function isCalendarDate(value: string): boolean {
  const [year, month, day] = [value.slice(0, 4), value.slice(5, 7), value.slice(8, 10)].map(Number);
  const at = new Date(Date.UTC(2000, month! - 1, day));
  at.setUTCFullYear(year!);
  return at.getUTCMonth() === month! - 1 && at.getUTCDate() === day;
}

/**
 * A publisher's time in milliseconds since the epoch, or undefined when it
 * is not one a record can carry. A time written without an offset is read as
 * UTC, never in the host's zone, so every instance reads a payload alike.
 */
export function epochOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = RFC3339.exec(value);
  if (match === null || !isCalendarDate(value)) return undefined;
  const offsetless = value.includes("T") && match[1] === undefined;
  const at = new Date(Date.parse(offsetless ? `${value}Z` : value));
  const year = at.getUTCFullYear();
  return Number.isFinite(at.getTime()) && year >= 0 && year <= 9999 ? at.getTime() : undefined;
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
