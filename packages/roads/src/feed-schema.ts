import { feedSourceBaseShape } from "@openconditions/ingest-framework";
import { z } from "zod";
import { ROAD_EVENT_TYPES } from "./model.js";

const roadEventType = z.enum(ROAD_EVENT_TYPES);
const severity = z.enum(["low", "medium", "high", "critical", "unknown"]);

/** Declarative GeoJSON field mapping — mirrors GeoJsonMapping in model.ts. */
const geoJsonMappingSchema = z
  .object({
    idField: z.string().optional(),
    typeField: z.string().optional(),
    // Values are constrained to the canonical taxonomy: a typo like
    // "roadwroks" fails the lint instead of silently defaulting.
    typeMap: z.record(z.string(), roadEventType).optional(),
    defaultType: roadEventType.optional(),
    headlineField: z.string().optional(),
    descriptionField: z.string().optional(),
    severityField: z.string().optional(),
    severityMap: z.record(z.string(), severity).optional(),
    roadField: z.string().optional(),
    updatedField: z.string().optional(),
    arrayPath: z.string().optional(),
    lonField: z.string().optional(),
    latField: z.string().optional(),
  })
  .strict();

/** Matches a well-formed feed id: dash-joined lower-case alphanumeric tokens. */
const FEED_ID_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Derives the feed id from its region-first identity parts. */
export function deriveFeedId(feed: {
  country: string;
  subdivision?: string;
  operator: string;
  stream?: string;
}): string {
  return [feed.country.toLowerCase(), feed.subdivision, feed.operator, feed.stream]
    .filter(Boolean)
    .join("-");
}

/**
 * The roads FeedSource schema: the base shape plus road-specific mapping/transport
 * fields. The `id` is DERIVED from country/subdivision/operator/stream by the
 * trailing transform, so feed data files omit it. A serialized feed (atlas /
 * remote snapshot) may still carry an `id`; it is accepted and then re-derived,
 * never trusted. Applied identically to every load layer via the schema, so the
 * baked-in, operator-mounted, and remote-pulled sets all derive ids the same way.
 */
export const roadFeedSchema = z
  .object({
    ...feedSourceBaseShape,
    // Derived — accept a serialized id round-trip, but always re-derive below.
    id: z.string().min(1).optional(),
    geojson: geoJsonMappingSchema.optional(),
    posListLonLat: z.boolean().optional(),
    siteTable: z
      .object({
        url: z.string().url(),
        gzip: z.boolean().optional(),
        format: z.enum(["datex-site-table", "datex-predefined-locations"]).optional(),
      })
      .strict()
      .optional(),
    stationRegistry: z
      .object({
        url: z.string().url(),
        format: z.enum([
          "fintraffic-stations",
          "webtris-sites",
          "miv-config",
          "france-comptage-csv",
          "hk-detector-csv",
        ]),
      })
      .strict()
      .optional(),
    openlrResolver: z.boolean().optional(),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  })
  .strict()
  .transform((feed, ctx) => {
    const id = deriveFeedId(feed);
    if (!FEED_ID_SLUG.test(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `derived feed id "${id}" is not a valid slug (^[a-z0-9]+(-[a-z0-9]+)*$)`,
      });
      return z.NEVER;
    }
    return { ...feed, id };
  });
