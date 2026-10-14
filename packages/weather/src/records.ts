import type { CatalogFeed } from "@openconditions/ingest-framework";

/** What a weather record takes from its feed: its identity and its terms. */
export type WeatherFeed = Pick<
  CatalogFeed,
  "id" | "format" | "attribution" | "license" | "licenseUrl" | "accessMode"
>;

/** An instant in UTC at second precision, as the drafts carry it. */
export function utcInstant(at: Date): string {
  return at.toISOString().replace(/\.000Z$/, "Z");
}

/**
 * A publisher's station id as a feature id takes it: every character outside
 * `[A-Za-z0-9._:-]` becomes `_`.
 */
export const stationKey = (stationId: string): string =>
  stationId.replace(/[^A-Za-z0-9._:-]/g, "_");

/** The id of a station's feature. */
export function stationFeatureId(feed: Pick<WeatherFeed, "id">, stationId: string): string {
  return `oc:feature:${feed.id}:${stationKey(stationId)}`;
}

/** A record's provenance, crediting the feed's publisher under its licence. */
export function provenance(feed: WeatherFeed, recordId: string): Record<string, unknown> {
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

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

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
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text : undefined;
}

/** A finite number; anything else, a numeric string included, is absent. */
export function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A `[lon, lat]` the model can place: finite, in range, and not the null island a missing position reads as. */
export function lonLat(lon: unknown, lat: unknown): [number, number] | undefined {
  const x = numberOf(lon);
  const y = numberOf(lat);
  if (x === undefined || y === undefined) return undefined;
  if (Math.abs(x) > 180 || Math.abs(y) > 90 || (x === 0 && y === 0)) return undefined;
  return [x, y];
}
