import { z } from "zod";
import { CountryCode, Geometry, Text, type valueObjectSchemas } from "./scalars.js";
import type { Vocab } from "./vocab.js";

export const ROAD_CLASSES = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "local",
  "service",
  "other",
] as const;
export const CARRIAGEWAYS = [
  "main",
  "entry",
  "exit",
  "ramp",
  "connector",
  "service",
  "collector",
  "parallel",
] as const;
export const DIRECTION_VALUES = ["positive", "negative", "both", "unknown"] as const;
export const DIRECTION_BASES = [
  "road_reference",
  "alert_c",
  "openlr",
  "geometry",
  "bearing",
  "compass",
  "text",
  "unknown",
] as const;
export const COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
/**
 * The two carriageways of a ring road or beltway, as signs name them. Where
 * traffic keeps right the inner loop runs clockwise and the outer loop
 * counter-clockwise; where it keeps left, the other way round.
 */
export const DIRECTION_LOOPS = ["inner", "outer"] as const;
export const LANE_TYPES = [
  "general",
  "hov",
  "bus",
  "bicycle",
  "shoulder",
  "hard_shoulder",
  "emergency",
  "turn",
  "exit",
  "entrance",
  "median",
  "center_turn",
  "ramp",
  "parking",
  "sidewalk",
] as const;
export const LINEAR_SYSTEMS = ["milepost", "kilometre_post", "tpeg_olr", "provider"] as const;
export const EXTENTS = ["point", "linear", "area", "network", "none"] as const;
export const GEOMETRY_ORIGINS = [
  "source",
  "site_table",
  "tmc_table",
  "openlr_decoded",
  "osm",
  "crowd_device",
  "derived",
  "none",
] as const;
export const FUZZINESS = [
  "exact",
  "low_res",
  "medium_res",
  "end_unknown",
  "start_unknown",
  "extent_unknown",
] as const;

/**
 * DirectionRef.value is read against `basis`: road_reference → positive =
 * increasing milepost/km; alert_c → TMC positive direction; openlr → along the
 * reference; geometry → positive = the order the geometry of the location it
 * applies to is drawn in, first coordinate to last, which a point does not
 * have; unknown → positive or negative is one direction of an axis the source
 * did not identify, which no consumer can apply to a carriageway (a DATEX
 * measure `aligned` or `opposite` at a location stating no direction).
 * bearing/compass/text carry no axis, so `value` stays "both" or
 * "unknown" unless ingest resolved it against a road reference. `loop` names
 * the loop of a ring road the direction is on; it is no axis either, so a
 * consumer that does not know the ring cannot apply it to one carriageway.
 */
export const DirectionRef = z
  .strictObject({
    value: z.enum(DIRECTION_VALUES),
    basis: z.enum(DIRECTION_BASES),
    compass: z.enum(COMPASS_POINTS).optional(),
    bearingDeg: z.number().min(0).lt(360).optional(),
    loop: z.enum(DIRECTION_LOOPS).optional(),
    toward: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
  })
  .superRefine((d, ctx) => {
    const axisless = d.basis === "bearing" || d.basis === "compass" || d.basis === "text";
    if (axisless && (d.value === "positive" || d.value === "negative")) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `basis "${d.basis}" has no reference axis: value must be "both" or "unknown"`,
      });
    }
  });

/**
 * OC lane convention: index 1 = leftmost position in travel direction, shoulders
 * counted when the source lists them (= WZDx `order`). DATEX counts from the
 * hard shoulder; ingest converts (see `datexLaneToIndex`).
 */
export const LaneRef = z.strictObject({
  index: z.number().int().min(1),
  type: z.enum(LANE_TYPES).optional(),
});

/**
 * An Alert-C (TMC) location reference. `code` is the primary location; a
 * linear reference also names its `secondary` location. `direction` is the
 * coded direction along the table's axis (0 positive, 1 negative) and
 * `affectedDirection` which way of the road it affects relative to the
 * location's own (DATEX `alertCAffectedDirection`). Method 4 places a
 * location some metres from its point (`primaryOffsetM`, `secondaryOffsetM`).
 */
export const AlertCRef = z.strictObject({
  country: z.string().min(1),
  table: z.number().int().nonnegative(),
  version: z.string().min(1).optional(),
  code: z.number().int().nonnegative(),
  secondary: z.number().int().nonnegative().optional(),
  direction: z.union([z.literal(0), z.literal(1)]).optional(),
  affectedDirection: z.enum(["aligned", "opposite", "both", "unknown"]).optional(),
  extent: z.number().int().nonnegative().optional(),
  method: z.union([z.literal(2), z.literal(4)]).optional(),
  primaryOffsetM: z.number().nonnegative().optional(),
  secondaryOffsetM: z.number().nonnegative().optional(),
});

/** A position along a referenced linear feature: a road number or a waterway name. */
export const LinearRef = z.strictObject({
  system: z.enum(LINEAR_SYSTEMS),
  ref: z.string().min(1),
  from: z.number(),
  /** Source-reported distance; it does not establish an end chainage or road geometry. */
  reportedLengthM: z.number().nonnegative().optional(),
  to: z.number().optional(),
  authority: z.string().min(1).optional(),
});

export function locationSchemas(vocab: Vocab, vo: ReturnType<typeof valueObjectSchemas>) {
  const RoadRef = z.strictObject({
    name: Text.optional(),
    ref: z.string().min(1).optional(),
    class: z.enum(ROAD_CLASSES).optional(),
    designation: z
      .strictObject({ scheme: vocab("road_designation_scheme"), ref: z.string().min(1) })
      .optional(),
    carriageway: z.enum(CARRIAGEWAYS).optional(),
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    at: z.string().min(1).optional(),
    junctionFrom: z.string().min(1).optional(),
    junctionTo: z.string().min(1).optional(),
    milepostFrom: z.number().optional(),
    milepostTo: z.number().optional(),
    kmFrom: z.number().optional(),
    kmTo: z.number().optional(),
  });

  const locationShape = {
    geometry: Geometry.nullable(),
    extent: z.enum(EXTENTS),
    geometryOrigin: z.enum(GEOMETRY_ORIGINS),
    fuzziness: z.enum(FUZZINESS),
    roads: z.array(RoadRef).min(1).optional(),
    direction: DirectionRef.optional(),
    lanes: z.array(LaneRef).min(1).optional(),
    linear: LinearRef.optional(),
    tmc: AlertCRef.optional(),
    openlr: z.string().min(1).optional(),
    osm: z.array(vo.ExternalId).min(1).optional(),
    admin: z
      .strictObject({
        country: CountryCode,
        subdivision: z.string().min(1).optional(),
        municipality: z.string().min(1).optional(),
        geocodes: z
          .array(z.strictObject({ scheme: vocab("admin_geocode_scheme"), code: z.string().min(1) }))
          .min(1)
          .optional(),
      })
      .optional(),
    areaDescription: Text.optional(),
    address: vo.Address.optional(),
    level: z.string().min(1).optional(),
    elevationM: z.number().optional(),
    locationTable: z
      .strictObject({
        ref: z.string().min(1),
        version: z.string().min(1),
        attribution: z.string().min(1).optional(),
        license: z.string().min(1).optional(),
        viaRoadMatch: z.boolean().optional(),
      })
      .optional(),
    external: z
      .array(z.strictObject({ system: z.string().min(1), code: z.string().min(1) }))
      .min(1)
      .optional(),
  };

  const LocationRef = z.strictObject(locationShape).superRefine((l, ctx) => {
    if (l.extent === "none" && (l.geometry !== null || l.geometryOrigin !== "none")) {
      ctx.addIssue({
        code: "custom",
        path: ["extent"],
        message: 'extent "none" requires geometry null and geometryOrigin "none"',
      });
    }
    if (l.geometry === null && l.geometryOrigin !== "none") {
      ctx.addIssue({
        code: "custom",
        path: ["geometryOrigin"],
        message: 'a null geometry has geometryOrigin "none"',
      });
    }
    if (l.osm?.some((id) => !id.scheme.startsWith("osm:"))) {
      ctx.addIssue({ code: "custom", path: ["osm"], message: "osm holds osm:* ids only" });
    }
  });
  /** Effect-level location override: any subset of the fields, no whole-object rules. */
  const PartialLocationRef = z.strictObject(locationShape).partial();

  return { RoadRef, LocationRef, PartialLocationRef };
}

export type Fuzziness = (typeof FUZZINESS)[number];
export type DirectionRef = z.infer<typeof DirectionRef>;
export type LaneRef = z.infer<typeof LaneRef>;
export type LinearRef = z.infer<typeof LinearRef>;

/**
 * DATEX lane number → OC `LaneRef.index`. DATEX v3 `laneNumber` / v2 `lane1…9`
 * count from the hard shoulder/verge toward the central reservation, i.e. from
 * the right in right-hand traffic; OC counts from the left. `left_first`
 * sources (NDW) already number from the left. Returns null when the
 * conversion needs `lanesTotal` and it is unknown (the effect then stays
 * `partial` with issue `unresolved_lane`).
 */
export function datexLaneToIndex(
  laneNumber: number,
  opts: {
    drivingSide: "right" | "left";
    lanesTotal?: number;
    numbering?: "standard" | "left_first";
  },
): number | null {
  if (!Number.isInteger(laneNumber) || laneNumber < 1) return null;
  if (opts.numbering === "left_first" || opts.drivingSide === "left") return laneNumber;
  if (opts.lanesTotal === undefined || laneNumber > opts.lanesTotal) return null;
  return opts.lanesTotal + 1 - laneNumber;
}
