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

/** The roads FeedSource schema: the base shape plus road-specific mapping/transport fields. */
export const roadFeedSchema = z
  .object({
    ...feedSourceBaseShape,
    geojson: geoJsonMappingSchema.optional(),
    posListLonLat: z.boolean().optional(),
    siteTable: z
      .object({ url: z.string().url(), gzip: z.boolean().optional() })
      .strict()
      .optional(),
    stationRegistry: z
      .object({
        url: z.string().url(),
        format: z.enum(["fintraffic-stations", "webtris-sites", "miv-config"]),
      })
      .strict()
      .optional(),
    openlrResolver: z.boolean().optional(),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  })
  .strict();
