import { defineKind, defineVocabulary, LOS } from "@openconditions/model";
import { z } from "zod";
import { roadsSeverity } from "./severity.js";

/** Road surface states (DATEX RoadSurfaceConditionMeasurements, weather-related road conditions). */
export const SURFACE_STATES = [
  "dry",
  "damp",
  "wet",
  "frost",
  "ice",
  "black_ice",
  "snow",
  "packed_snow",
  "slush",
  "standing_water",
  "flooded",
  "chemically_wet",
  "unknown",
] as const;

export const surfaceStateVocabulary = defineVocabulary({
  code: "surface_state",
  values: SURFACE_STATES,
  extensible: false,
  description: "Road surface states.",
});

const DOMAIN = "roads";
const V = "1.0";
const Intensity = z.enum(["light", "moderate", "heavy", "extreme"]);

/**
 * The roads situation kinds. `type` is the nature, causes and effects are
 * separate facets: a lane closure is a `lane_restriction` effect on whatever
 * situation causes it, and only a record whose nature is the rule itself is a
 * `restriction` situation.
 */
export const ROADS_SITUATION_KINDS = [
  defineKind({
    class: "situation",
    code: "incident",
    domain: DOMAIN,
    version: V,
    description: "An unplanned event on the road: accident, breakdown, obstruction, fire.",
    types: {
      accident: [
        "multi_vehicle",
        "jackknifed_truck",
        "overturned",
        "pedestrian_involved",
        "cyclist_involved",
        "motorcycle_involved",
        "bus_involved",
        "heavy_vehicle_involved",
        "train_involved",
        "animal_collision",
        "hazmat_spill",
        "secondary",
        "fatal",
      ],
      breakdown: ["disabled_vehicle", "abandoned_vehicle", "stuck_vehicle", "wrong_way_driver"],
      vehicle_hazard: [
        "slow_vehicle",
        "abnormal_load",
        "oversize_vehicle",
        "hazmat_vehicle",
        "emergency_vehicle",
        "maintenance_vehicle",
        "reckless_driver",
        "high_speed_chase",
        "unlit_vehicle",
        "prohibited_vehicle",
      ],
      obstruction: [
        "debris",
        "spill",
        "animal",
        "object",
        "people_on_road",
        "fallen_tree",
        "infrastructure_damage",
        "pothole",
        "sinkhole",
        "landslide",
        "rockfall",
        "stranded_vehicle",
      ],
      fire: ["vehicle_fire", "roadside_fire", "tunnel_fire"],
    },
    details: (k) => ({
      vehiclesInvolved: z.number().int().nonnegative().optional(),
      vehicleTypes: z.array(k.vocab("vehicle_class")).min(1).optional(),
      casualties: z.number().int().nonnegative().optional(),
      emergencyServicesPresent: z.boolean().optional(),
    }),
    deriveSeverity: roadsSeverity({ accident: "major", fire: "major", obstruction: "moderate" }),
  }),
  defineKind({
    class: "situation",
    code: "roadworks",
    domain: DOMAIN,
    version: V,
    description: "Planned or active construction and maintenance works.",
    types: {
      works: [
        "construction",
        "maintenance",
        "resurfacing",
        "bridge_work",
        "utility_work",
        "tree_work",
        "line_marking",
        "inspection",
        "winter_service",
        "emergency_repair",
        "roadside_work",
        "overhead_work",
        "barrier_work",
        "demolition",
        "blasting",
        "cleaning",
      ],
    },
    details: (k) => ({
      workZoneType: z.enum(["static", "moving", "planned_moving_area"]).optional(),
      workersPresent: z.boolean().optional(),
      workerPresenceConfidence: z.enum(["low", "medium", "high"]).optional(),
      typesOfWork: z
        .array(
          z.strictObject({
            name: z.string().min(1),
            architecturalChange: z.boolean().optional(),
          }),
        )
        .min(1)
        .optional(),
      locationMethod: z
        .enum(["channel_device_method", "sign_method", "junction_method", "other", "unknown"])
        .optional(),
      phases: z
        .array(
          z.strictObject({
            id: z.string().min(1),
            name: k.Text.optional(),
            validity: k.Validity,
            effects: z.array(k.Effect),
            /** Display only; never constrains the phase's effects. */
            workingHours: z.array(k.Schedule).min(1).optional(),
            restrictionsLiftable: z.boolean().optional(),
          }),
        )
        .min(1)
        .optional(),
    }),
    nestedEffects: (d) =>
      ((d["phases"] as { effects: { id: string }[] }[] | undefined) ?? []).flatMap(
        (p) => p.effects,
      ),
    deriveSeverity: roadsSeverity({ works: "minor" }),
  }),
  defineKind({
    class: "situation",
    code: "closure",
    domain: DOMAIN,
    version: V,
    description:
      "A record whose nature is the closure itself. A closure caused by something else is a closure effect on that situation.",
    types: {
      closure: [
        "full",
        "carriageway",
        "ramp",
        "lane",
        "bridge",
        "tunnel",
        "seasonal",
        "night",
        "weekend",
        "emergency",
        "intermittent",
      ],
    },
    details: () => ({}),
    deriveSeverity: roadsSeverity({ closure: "major" }),
  }),
  defineKind({
    class: "situation",
    code: "restriction",
    domain: DOMAIN,
    version: V,
    description:
      "A traffic regulation whose nature is the rule itself: a standing dimension limit, a seasonal load ban, a temporary speed limit.",
    types: {
      dimension: ["height", "width", "length", "weight", "axle_load", "axle_count"],
      access: [
        "truck_ban",
        "hazmat",
        "hov",
        "local_access_only",
        "permit_only",
        "no_overtaking",
        "no_parking",
        "towing_prohibited",
        "oversize_prohibited",
        "convoy",
        "low_emission_zone",
      ],
      speed: ["temporary", "variable", "advisory"],
      seasonal_load: ["spring_thaw", "frost_law"],
    },
    details: (k) => ({
      basis: z.enum(["temporary", "standing_rule", "seasonal", "structural"]),
      structureRef: k.RecordRef.optional(),
      legalRef: z.string().min(1).optional(),
      enforcement: z.enum(["signed", "legal", "unknown"]).optional(),
    }),
    deriveSeverity: roadsSeverity({
      dimension: "minor",
      access: "minor",
      speed: "minor",
      seasonal_load: "minor",
    }),
  }),
  defineKind({
    class: "situation",
    code: "weather_condition",
    domain: DOMAIN,
    version: V,
    description: "Weather affecting driving, reported as traffic information.",
    types: {
      weather: [
        "ice",
        "snow",
        "freezing_rain",
        "rain",
        "heavy_rain",
        "hail",
        "fog",
        "high_wind",
        "storm",
        "thunderstorm",
        "dust",
        "black_ice",
        "blizzard",
        "extreme_heat",
        "extreme_cold",
        "low_sun",
        "reduced_visibility",
        "pollution",
      ],
    },
    details: (k) => ({
      intensity: Intensity.optional(),
      visibility: k.Quantity.optional(),
      windSpeed: k.Quantity.optional(),
      windGust: k.Quantity.optional(),
      precipitationRate: k.Quantity.optional(),
    }),
    deriveSeverity: roadsSeverity({ weather: "minor" }),
  }),
  defineKind({
    class: "situation",
    code: "road_condition",
    domain: DOMAIN,
    version: V,
    description: "The state of the road surface or the overall driving condition.",
    types: {
      surface: [
        "icy",
        "snow_covered",
        "slush",
        "wet",
        "dry",
        "frost",
        "standing_water",
        "mud",
        "oil",
        "gravel",
        "loose_chippings",
        "leaves",
        "rough",
      ],
      driving_condition: [
        "good",
        "fair",
        "poor",
        "hazardous",
        "impassable",
        "no_winter_maintenance",
      ],
    },
    details: (k) => ({
      /** `["unknown"]` when the source names a condition without a surface state. */
      surface: z.array(k.vocab("surface_state")).min(1),
      treatment: z.enum(["salted", "sanded", "plowed", "untreated", "unknown"]).optional(),
      friction: z.number().min(0).max(1).optional(),
      drivingCondition: z
        .enum(["good", "fair", "poor", "hazardous", "impassable", "unknown"])
        .optional(),
    }),
    deriveSeverity: roadsSeverity({ surface: "minor", driving_condition: "minor" }),
  }),
  defineKind({
    class: "situation",
    code: "road_hazard",
    domain: DOMAIN,
    version: V,
    description: "A natural or environmental hazard at the road.",
    types: {
      hazard: [
        "avalanche_risk",
        "flooding",
        "wildfire_near_road",
        "smoke",
        "low_visibility",
        "wildlife",
        "ice_fall",
        "high_water",
        "storm_surge",
      ],
    },
    details: () => ({ obstructionSide: z.enum(["left", "right", "centre", "unknown"]).optional() }),
    deriveSeverity: roadsSeverity({ hazard: "moderate" }),
  }),
  defineKind({
    class: "situation",
    code: "public_event",
    domain: DOMAIN,
    version: V,
    description: "A public event affecting traffic.",
    types: {
      event: [
        "sporting",
        "parade",
        "concert",
        "demonstration",
        "market",
        "festival",
        "exhibition",
        "filming",
        "procession",
        "state_visit",
        "fireworks",
      ],
    },
    details: (k) => ({
      name: k.Text.optional(),
      expectedAttendance: z.number().int().nonnegative().optional(),
    }),
    deriveSeverity: roadsSeverity({}),
  }),
  defineKind({
    class: "situation",
    code: "authority",
    domain: DOMAIN,
    version: V,
    description: "Police, customs or other authority activity on the road.",
    types: {
      operation: [
        "police_checkpoint",
        "police_activity",
        "customs",
        "escort",
        "enforcement",
        "vehicle_inspection",
        "weighing",
        "survey",
        "emergency_services",
        "military_convoy",
      ],
    },
    details: () => ({}),
    deriveSeverity: roadsSeverity({}),
  }),
  defineKind({
    class: "situation",
    code: "equipment_fault",
    domain: DOMAIN,
    version: V,
    description: "Roadside equipment out of order.",
    types: {
      fault: [
        "traffic_signal",
        "vms",
        "tunnel_system",
        "lighting",
        "lift",
        "barrier",
        "camera",
        "weather_station",
        "communications",
        "emergency_phone",
        "level_crossing",
        "toll_system",
        "power",
      ],
    },
    details: (k) => ({ equipmentRef: k.RecordRef.optional() }),
    deriveSeverity: roadsSeverity({}),
  }),
  defineKind({
    class: "situation",
    code: "security",
    domain: DOMAIN,
    version: V,
    description: "A security incident or alert affecting the road.",
    types: {
      incident: ["bomb_alert", "unattended_object", "evacuation", "civil_unrest", "attack"],
    },
    details: () => ({}),
    deriveSeverity: roadsSeverity({}),
  }),
  defineKind({
    class: "situation",
    code: "winter_operation",
    domain: DOMAIN,
    version: V,
    description: "Winter driving requirements published as events (chain controls).",
    types: { chain_control: ["R1", "R2", "R3", "chains_all", "winter_tyres"] },
    details: () => ({ chainLevel: z.enum(["none", "R1", "R2", "R3"]).optional() }),
    deriveSeverity: roadsSeverity({ chain_control: "minor" }),
  }),
  defineKind({
    class: "situation",
    code: "pass_status",
    domain: DOMAIN,
    version: V,
    description: "Mountain pass status published as events, where the source has no pass registry.",
    types: { pass: ["open", "closed", "restricted"] },
    details: (k) => ({ seasonal: z.boolean().optional(), passRef: k.RecordRef.optional() }),
    deriveSeverity: roadsSeverity({}),
  }),
  defineKind({
    class: "situation",
    code: "congestion",
    domain: DOMAIN,
    version: V,
    description: "Abnormal traffic: queues, slow or stationary traffic.",
    types: { congestion: ["queuing", "stationary", "stop_and_go", "heavy", "slow"] },
    details: (k) => ({
      los: z.enum(LOS),
      derivedFrom: k.RecordRef.optional(),
      freeFlowSource: z.enum(["native", "derived", "osm_maxspeed", "typical_profile"]).optional(),
    }),
    deriveSeverity: roadsSeverity({ congestion: "moderate" }),
  }),
  defineKind({
    class: "situation",
    code: "other",
    domain: DOMAIN,
    version: V,
    description:
      "A record whose nature the source does not classify; its effects still say what it does.",
    types: { other: [] },
    details: () => ({}),
    deriveSeverity: roadsSeverity({}),
  }),
] as const;
