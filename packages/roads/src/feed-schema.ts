import { type CatalogFeed, feedBaseShape } from "@openconditions/ingest-framework";
import { isKnownTimeZone } from "@openconditions/model";
import { ROADS_SITUATION_KINDS } from "@openconditions/model-roads";
import { z } from "zod";
import { ROAD_EVENT_TYPES } from "./model.js";

/**
 * How a DATEX feed numbers lanes: `standard` (default) counts from the hard
 * shoulder, `left_first` from the left, as NDW documents.
 */
export const LANE_NUMBERINGS = ["standard", "left_first"] as const;
export type LaneNumbering = (typeof LANE_NUMBERINGS)[number];

/** The units a publisher may write a unitless speed in. */
export const SPEED_UNITS = ["km/h", "mph"] as const;
export type SpeedUnit = (typeof SPEED_UNITS)[number];

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
const severity = z.enum(["none", "low", "medium", "high", "critical", "unknown"]);
/** A regular expression the reader compiles case-insensitively; one that does not compile fails the lint. */
const pattern = z.string().refine(
  (p) => {
    try {
      new RegExp(p, "iu");
      return true;
    } catch {
      return false;
    }
  },
  { error: "not a valid regular expression" },
);

/** Declarative GeoJSON field mapping — mirrors GeoJsonMapping in model.ts. */
const geoJsonMappingSchema = z
  .object({
    idField: z.string().optional(),
    idFields: z.array(z.string()).nonempty().optional(),
    featureId: z.boolean().optional(),
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
    severityStated: z.boolean().optional(),
    severityPatterns: z
      .array(z.object({ match: pattern, severity }).strict())
      .nonempty()
      .optional(),
    roadField: z.string().optional(),
    directionField: z.string().optional(),
    lanesTotalField: z.string().optional(),
    lanesClosedField: z.string().optional(),
    updatedField: z.string().optional(),
    arrayPath: z.string().optional(),
    lonField: z.string().optional(),
    latField: z.string().optional(),
    validFromField: z.string().optional(),
    validToField: z.string().optional(),
    validityDaysAtMidnight: z.literal(true).optional(),
    validityRangeField: z.string().optional(),
    filter: z
      .array(
        z
          .object({
            field: z.string(),
            include: z.array(z.string()).optional(),
            exclude: z.array(z.string()).optional(),
            includeMatching: z.array(pattern).nonempty().optional(),
            excludeMatching: z.array(pattern).nonempty().optional(),
          })
          .strict(),
      )
      .optional(),
    followUp: z
      .object({ field: z.string(), prefixes: z.array(z.string().min(1)).nonempty() })
      .strict()
      .optional(),
    nullValues: z.array(z.string()).nonempty().optional(),
    startLonField: z.string().optional(),
    startLatField: z.string().optional(),
    endLonField: z.string().optional(),
    endLatField: z.string().optional(),
  })
  .strict()
  .refine((m) => m.idField === undefined || m.idFields === undefined, {
    path: ["idFields"],
    message: "a mapping names idField or idFields, not both",
  });

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
   * For `trafikverket` feeds: the deviation `MessageType`s ("Olycka",
   * "Vägarbete") another feed already carries. A Situation keeps all its
   * deviations whichever one a query matched, so these are dropped in parsing.
   */
  excludeMessageTypes: z.array(z.string().min(1)).nonempty().optional(),
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
  /**
   * The IANA zone the publisher writes its times without an offset in
   * (`2026-07-14T09:34:00`, `2026-10-11 03:53:30`). Without it such a time is
   * read as UTC.
   */
  timezone: z.string().refine(isKnownTimeZone, { message: "unknown IANA time zone" }).optional(),
  /**
   * The publisher writes its local times (in `timezone`) with a UTC designator
   * they do not have: `09:00:00Z` for 09:00 local. They are read as local.
   */
  localTimesMarkedUtc: z.literal(true).optional(),
  /**
   * The unit the publisher writes the speeds its format states no unit for
   * in: WZDx 3.1's `reduced_speed_limit`, which its schema leaves without
   * one. Without it such a speed is not read.
   */
  speedUnit: z.enum(SPEED_UNITS).optional(),
} as const;

/**
 * Raw per-field shape of a roads feed: the base shape plus the roads fields.
 * The catalogue builds `.strict()` region-file schemas from it.
 */
export const roadsFeedShape = { ...feedBaseShape, ...roadsFeedExtension } as const;

/** A loaded roads feed: the catalogue feed plus the roads fields. */
export type RoadFeed = CatalogFeed & z.infer<z.ZodObject<typeof roadsFeedExtension>>;
