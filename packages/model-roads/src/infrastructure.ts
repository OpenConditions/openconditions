import {
  defineKind,
  defineProperty,
  defineResultSchema,
  defineVocabulary,
  Iso8601,
  VEHICLE_CLASSES,
} from "@openconditions/model";
import { z } from "zod";

const DOMAIN = "roads";
const V = "1.0";

export const CAMERA_STATUSES = ["online", "offline", "stale", "unknown"] as const;
export const VMS_WORKING_STATUSES = [
  "in_service",
  "out_of_service",
  "fault",
  "blank",
  "unknown",
] as const;
export const DEVICE_STATUSES = ["ok", "warning", "error", "offline", "unknown"] as const;

export const cameraStatusVocabulary = defineVocabulary({
  code: "camera_status",
  values: CAMERA_STATUSES,
  extensible: false,
  description: "Whether a camera delivers current images.",
});
export const vmsWorkingStatusVocabulary = defineVocabulary({
  code: "vms_working_status",
  values: VMS_WORKING_STATUSES,
  extensible: false,
  description: "The operating state of a variable message sign.",
});
export const deviceStatusVocabulary = defineVocabulary({
  code: "device_status",
  values: DEVICE_STATUSES,
  extensible: false,
  description: "The operating state a field device reports about itself.",
});

const Mounting = (values: readonly [string, ...string[]]) => z.enum(values).optional();
const Pictogram = (k: { Text: z.ZodType; Quantity: z.ZodType }) =>
  z.strictObject({
    area: z.number().int().nonnegative(),
    code: z.string().min(1),
    codeSystem: z.enum(["iso14823", "datex", "vienna", "wzdx", "provider"]),
    description: k.Text.optional(),
    value: k.Quantity.optional(),
  });

/** The roads infrastructure kinds: signs, cameras, measurement sites and their components. */
export const ROADS_INFRASTRUCTURE_KINDS = [
  defineKind({
    class: "component",
    code: "sign_face",
    version: V,
    description: "One display of a variable message sign (DATEX `vmsIndex`).",
    details: (k) => ({
      vmsIndex: z.number().int().nonnegative(),
      direction: k.DirectionRef.optional(),
      lanes: z.array(k.LaneRef).min(1).optional(),
      textRows: z.number().int().positive().optional(),
      charsPerRow: z.number().int().positive().optional(),
      pictogramAreas: z.number().int().nonnegative().optional(),
      supplementaryPanel: z.boolean().optional(),
    }),
  }),
  defineKind({
    class: "component",
    code: "camera_view",
    version: V,
    description: "One view of a camera: a fixed direction, or a preset of a movable camera.",
    details: (k) => ({
      name: k.Text.optional(),
      bearingDeg: z.number().min(0).lt(360).optional(),
      direction: k.DirectionRef.optional(),
      road: k.RoadRef.optional(),
    }),
  }),
  defineKind({
    class: "feature",
    code: "vms",
    domain: DOMAIN,
    version: V,
    description: "A variable message sign, arrow board or flashing beacon.",
    types: {
      textual: [],
      pictogram: [],
      matrix: [],
      lane_control: [],
      hybrid: [],
      arrow_board: [],
      flashing_beacon: [],
      other: [],
    },
    components: ["sign_face"],
    traits: ["field_device"],
    details: () => ({
      controllerId: z.string().min(1).optional(),
      mounting: Mounting(["gantry", "cantilever", "roadside", "portable", "vehicle", "unknown"]),
      supplementaryPanel: z.boolean().optional(),
      laneCount: z.number().int().positive().optional(),
    }),
  }),
  defineKind({
    class: "feature",
    code: "camera",
    domain: DOMAIN,
    version: V,
    description: "A traffic, weather or landscape camera publishing images or a stream.",
    types: { traffic: [], landscape: [], city: [], weather: [], beach: [], other: [] },
    components: ["camera_view"],
    traits: ["field_device"],
    details: () => ({
      refreshSec: z.number().positive().optional(),
      provider: z.string().min(1).optional(),
      detailUrl: z.url().optional(),
      playerEmbedUrl: z.url().optional(),
      ptz: z.boolean().optional(),
      mounting: Mounting(["gantry", "pole", "bridge", "vehicle", "unknown"]),
      /** What the image licence allows: republish the image, or only link to it. */
      imageRedistribution: z.enum(["allowed", "link_only", "unknown"]),
    }),
  }),
  defineKind({
    class: "feature",
    code: "measurement_site",
    domain: DOMAIN,
    version: V,
    description:
      "A traffic measurement site: a detector station, a probe-measured link, a counting point.",
    types: { traffic: [], combined: [] },
    components: ["sensor_channel"],
    traits: ["field_device", "weather_sensing"],
    details: () => ({
      equipment: z
        .enum(["loop", "radar", "camera", "bluetooth", "anpr", "probe", "unknown"])
        .optional(),
      laneCount: z.number().int().positive().optional(),
      sideOfRoad: z.enum(["left", "right", "median"]).optional(),
      /** The properties the site reports; registered property codes. */
      measuredProperties: z.array(z.string().min(1)).min(1),
      siteVersion: z.string().min(1).optional(),
      heightAboveRoadM: z.number().optional(),
    }),
  }),
];

/** Structured results of the roads properties. */
export const ROADS_RESULT_SCHEMAS = [
  defineResultSchema({
    code: "vms_display",
    version: V,
    description: "What a sign face shows: text pages, pictograms, lane signals.",
    shape: (k) => ({
      workingStatus: k.vocab("vms_working_status"),
      messages: z.array(
        z.strictObject({
          index: z.number().int().nonnegative(),
          text: z
            .array(z.strictObject({ page: z.number().int().positive(), lines: z.array(k.Text) }))
            .min(1)
            .optional(),
          pictograms: z.array(Pictogram(k)).min(1).optional(),
          /**
           * The message is a bitmap (NDW route panels publish free graphics); its
           * bytes stay in the archived raw payload the record's `rawRef` points to.
           */
          graphic: z.strictObject({ mediaType: z.string().min(1) }).optional(),
          supplementary: k.Text.optional(),
          speedLimit: k.Quantity.optional(),
          flashing: z.boolean().optional(),
          laneSignals: z
            .array(
              z.strictObject({
                lane: k.LaneRef,
                signal: z.enum([
                  "open",
                  "closed",
                  "merge_left",
                  "merge_right",
                  "speed",
                  "hazard",
                  "blank",
                ]),
                speed: k.Quantity.optional(),
              }),
            )
            .min(1)
            .optional(),
          reasonRef: k.RecordRef.optional(),
          validity: k.Validity.optional(),
        }),
      ),
      /** NTCIP 1203 MULTI markup, verbatim. */
      multiString: z.string().min(1).optional(),
    }),
  }),
  defineResultSchema({
    code: "camera_image",
    version: V,
    description: "A camera's current image or stream, per view.",
    shape: (k) => ({
      status: k.vocab("camera_status"),
      imageUrl: z.url().optional(),
      imageAt: Iso8601.optional(),
      thumbnailUrl: z.url().optional(),
      streamUrl: z.url().optional(),
      streamType: z.enum(["hls", "rtsp", "mjpeg", "webrtc", "mp4"]).optional(),
      views: z
        .array(
          z.strictObject({
            key: z.string().min(1),
            imageUrl: z.url(),
            imageAt: Iso8601.optional(),
          }),
        )
        .min(1)
        .optional(),
    }),
  }),
];

const SITE = {
  kind: "feature",
  featureKinds: ["measurement_site"],
  componentKinds: ["sensor_channel"],
} as const;
const MINUTE = 60;

/** The traffic, sign, camera and device properties. */
export const ROADS_PROPERTIES = [
  defineProperty({
    code: "traffic.speed",
    domain: DOMAIN,
    version: V,
    description: "Average vehicle speed over the site's measurement period.",
    result: { type: "quantity", unit: "km/h" },
    subjects: [SITE, { kind: "segments" }],
    freshnessWindowSec: 15 * MINUTE,
    retention: {
      rawDays: 3,
      componentHistory: false,
      rollup: { period: "hourly", histogram: { binWidth: 2 } },
    },
    routingRelevant: true,
  }),
  defineProperty({
    code: "traffic.volume",
    domain: DOMAIN,
    version: V,
    description: "Vehicle flow rate.",
    result: { type: "quantity", unit: "1/h" },
    subjects: [SITE],
    freshnessWindowSec: 15 * MINUTE,
    retention: { rawDays: 2, componentHistory: false, rollup: { period: "hourly" } },
  }),
  defineProperty({
    code: "traffic.occupancy",
    domain: DOMAIN,
    version: V,
    description: "Share of the measurement period a detector was occupied.",
    result: { type: "quantity", unit: "%" },
    subjects: [SITE],
    freshnessWindowSec: 15 * MINUTE,
    retention: { rawDays: 2, componentHistory: false, rollup: { period: "hourly" } },
  }),
  defineProperty({
    code: "traffic.los",
    domain: DOMAIN,
    version: V,
    description: "Level of service as the source states it.",
    result: { type: "category", vocabulary: "los" },
    /** Travel-time publications state a level of service per route too (DATEX `TrafficStatus` on a predefined itinerary). */
    subjects: [
      SITE,
      { kind: "feature", featureKinds: ["travel_time_route"] },
      { kind: "segments" },
    ],
    freshnessWindowSec: 15 * MINUTE,
    retention: { changeOnly: true, rawDays: 7, componentHistory: false },
    routingRelevant: true,
  }),
  defineProperty({
    code: "traffic.vehicle_class_speed",
    domain: DOMAIN,
    version: V,
    description: "Average speed per vehicle class on one channel.",
    result: { type: "vector", unit: "km/h", keys: VEHICLE_CLASSES },
    subjects: [SITE],
    freshnessWindowSec: 15 * MINUTE,
    retention: { rawDays: 2, componentHistory: false },
  }),
  defineProperty({
    code: "vms.display",
    domain: DOMAIN,
    version: V,
    description: "What a sign shows.",
    result: { type: "structured", schema: "vms_display" },
    subjects: [{ kind: "feature", featureKinds: ["vms"], componentKinds: ["sign_face"] }],
    retention: { changeOnly: true, rawDays: 30 },
  }),
  defineProperty({
    code: "camera.image",
    domain: DOMAIN,
    version: V,
    description: "A camera's current image or stream.",
    result: { type: "structured", schema: "camera_image" },
    subjects: [{ kind: "feature", featureKinds: ["camera"], componentKinds: ["camera_view"] }],
    retention: { latestOnly: true },
  }),
  defineProperty({
    code: "device.status",
    domain: DOMAIN,
    version: V,
    description: "The operating state a field device reports about itself.",
    result: { type: "category", vocabulary: "device_status" },
    subjects: [{ kind: "feature", traits: ["field_device"] }],
    retention: { changeOnly: true },
  }),
];
