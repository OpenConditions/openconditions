import { type CatalogFeed, feedBaseShape } from "@openconditions/ingest-framework";
import { ROADS_SITUATION_KINDS } from "@openconditions/model-roads";
import { z } from "zod";
import { ROAD_EVENT_TYPES } from "./model.js";

/**
 * How a DATEX feed numbers lanes: `standard` (default) counts from the hard
 * shoulder, `left_first` from the left, as NDW documents.
 */
export const LANE_NUMBERINGS = ["standard", "left_first"] as const;
export type LaneNumbering = (typeof LANE_NUMBERINGS)[number];

const roadEventType = z.enum(ROAD_EVENT_TYPES);
/** Every registered roads situation code: `kind.type` and `kind.type.subtype`. */
const SITUATION_CODES = ROADS_SITUATION_KINDS.flatMap((kind) =>
  Object.entries((kind.types ?? {}) as Readonly<Record<string, readonly string[]>>).flatMap(
    ([type, subtypes]) => [
      `${kind.code}.${type}`,
      ...subtypes.map((subtype) => `${kind.code}.${type}.${subtype}`),
    ],
  ),
) as [`${string}.${string}`, ...`${string}.${string}`[]];
// A closed list rather than a predicate, so the catalogue's JSON Schema lists the codes too.
const situationCode = z.enum(SITUATION_CODES, {
  error: "not a registered roads situation code (kind.type[.subtype])",
});
const severity = z.enum(["low", "medium", "high", "critical", "unknown"]);

/** Declarative GeoJSON field mapping — mirrors GeoJsonMapping in model.ts. */
const geoJsonMappingSchema = z
  .object({
    idField: z.string().optional(),
    typeField: z.string().optional(),
    // Values are a coarse type or a registered situation code: a typo like
    // "roadwroks" or "roadworks.works.knitting" fails the lint instead of
    // silently defaulting.
    typeMap: z.record(z.string(), z.union([roadEventType, situationCode])).optional(),
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
    validFromField: z.string().optional(),
    validToField: z.string().optional(),
    filter: z
      .array(
        z
          .object({
            field: z.string(),
            include: z.array(z.string()).optional(),
            exclude: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .optional(),
    startLonField: z.string().optional(),
    startLatField: z.string().optional(),
    endLonField: z.string().optional(),
    endLatField: z.string().optional(),
  })
  .strict();

/** Declarative field mapping for the GeoJSON flow parser — mirrors GeojsonFlowMapping in types.ts. */
const geojsonFlowMappingSchema = z
  .object({
    idField: z.string(),
    speedField: z.string().optional(),
    freeFlowField: z.string().optional(),
    statusField: z.string().optional(),
    statusMap: z.record(z.string(), z.string()).optional(),
    updatedField: z.string().optional(),
  })
  .strict();

/**
 * The fields a roads feed adds to the base feed: how its parser reads the
 * payload. Reference data (a site table, a station registry) is not a field
 * but an endpoint with a decoder.
 */
const roadsFeedExtension = {
  /** Field mapping for `format: "geojson"` and `"flatjson"` feeds. */
  geojson: geoJsonMappingSchema.optional(),
  /** Field mapping for `format: "geojson-flow"` feeds. */
  flowMap: geojsonFlowMappingSchema.optional(),
  /**
   * For DATEX feeds whose GML `posList` is "lon lat" rather than the WGS84
   * "lat lon" default (e.g. Trafikverket).
   */
  posListLonLat: z.boolean().optional(),
  /**
   * CRS for DATEX feeds publishing a projected grid that declare no `srsName`
   * in the payload (e.g. Mecklenburg-Vorpommern's UTM zone 33).
   */
  srsName: z.string().min(1).optional(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  /**
   * Marks a reference-only feed whose records carry OpenLR but no coordinate,
   * so the ingest resolve stage map-matches them via the openlr-resolver
   * service. No current feed sets this: the open feeds we ingest carry
   * coordinates or Alert-C/TMC, not OpenLR (which is largely a commercial-feed
   * scheme). See services/openlr-resolver/README.md "Status".
   */
  openlrResolver: z.boolean().optional(),
  laneNumbering: z.enum(LANE_NUMBERINGS).optional(),
} as const;

/**
 * Raw per-field shape of a roads feed: the base shape plus the roads fields.
 * The catalogue builds `.strict()` region-file schemas from it.
 */
export const roadsFeedShape = { ...feedBaseShape, ...roadsFeedExtension } as const;

/** A loaded roads feed: the catalogue feed plus the roads fields. */
export type RoadFeed = CatalogFeed & z.infer<z.ZodObject<typeof roadsFeedExtension>>;
