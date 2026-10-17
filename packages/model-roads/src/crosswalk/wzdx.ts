/**
 * WZDx 4.x road events → roads classification. Keys are `<event_type>`,
 * `work-zone:<WorkTypeName>` or `restriction:<RestrictionType>`. A `detour`
 * road event is never a situation: it becomes a `detour` effect on the
 * related situation, so it maps to `null`.
 */
export const WZDX_SITUATIONS: Readonly<Record<string, string | null>> = {
  "work-zone": "roadworks.works",
  detour: null,
  restriction: "restriction.access",
  "work-zone:maintenance": "roadworks.works.maintenance",
  "work-zone:minor-road-defect-repair": "roadworks.works.maintenance",
  "work-zone:roadside-work": "roadworks.works.roadside_work",
  "work-zone:overhead-work": "roadworks.works.overhead_work",
  "work-zone:below-road-work": "roadworks.works.utility_work",
  "work-zone:barrier-work": "roadworks.works.barrier_work",
  "work-zone:surface-work": "roadworks.works.resurfacing",
  "work-zone:painting": "roadworks.works.line_marking",
  "work-zone:roadway-relocation": "roadworks.works.construction",
  "work-zone:roadway-creation": "roadworks.works.construction",
  "restriction:no-trucks": "restriction.access.truck_ban",
  "restriction:travel-peak-hours-only": null,
  "restriction:hov-3": "restriction.access.hov",
  "restriction:hov-2": "restriction.access.hov",
  "restriction:no-parking": "restriction.access.no_parking",
  "restriction:reduced-width": "restriction.dimension.width",
  "restriction:reduced-height": "restriction.dimension.height",
  "restriction:reduced-length": "restriction.dimension.length",
  "restriction:reduced-weight": "restriction.dimension.weight",
  "restriction:axle-load-limit": "restriction.dimension.axle_load",
  "restriction:gross-weight-limit": "restriction.dimension.weight",
  "restriction:towing-prohibited": "restriction.access.towing_prohibited",
  "restriction:permitted-oversize-loads-prohibited": "restriction.access.oversize_prohibited",
  "restriction:local-access-only": "restriction.access.local_access_only",
  "restriction:no-passing": "restriction.access.no_overtaking",
};

/** WZDx `vehicle_impact` → the kernel `lane_restriction.vehicleImpact` (WZDx snake_cased). */
export const WZDX_VEHICLE_IMPACTS: Readonly<Record<string, string>> = {
  "all-lanes-closed": "all_lanes_closed",
  "some-lanes-closed": "some_lanes_closed",
  "all-lanes-open": "all_lanes_open",
  "alternating-one-way": "alternating_one_way",
  "some-lanes-closed-merge-left": "some_lanes_closed_merge_left",
  "some-lanes-closed-merge-right": "some_lanes_closed_merge_right",
  "all-lanes-open-shift-left": "all_lanes_open_shift_left",
  "all-lanes-open-shift-right": "all_lanes_open_shift_right",
  "some-lanes-closed-split": "some_lanes_closed_split",
  flagging: "flagging",
  "temporary-traffic-signal": "temporary_traffic_signal",
  unknown: "unknown",
};

/** WZDx lane `status` → the kernel lane status of a `lane_restriction` lane. */
export const WZDX_LANE_STATUSES: Readonly<Record<string, string>> = {
  open: "open",
  closed: "closed",
  "shift-left": "shift_left",
  "shift-right": "shift_right",
  "merge-left": "merge_left",
  "merge-right": "merge_right",
  "alternating-flow": "alternating",
};

/**
 * WZDx lane `type` → the kernel lane type; `null` = no kernel equivalent.
 * Both the 4.x `LaneType` and the 3.1 one are listed. A lane's position is
 * its `order`, so the kernel type says only what the lane is for.
 */
export const WZDX_LANE_TYPES: Readonly<Record<string, string | null>> = {
  general: "general",
  "exit-lane": "exit",
  "exit-ramp": "ramp",
  "entrance-lane": "entrance",
  "entrance-ramp": "ramp",
  sidewalk: "sidewalk",
  "bike-lane": "bicycle",
  shoulder: "shoulder",
  parking: "parking",
  median: "median",
  "two-way-center-turn-lane": "center_turn",
  // Deprecated in 4.1 for `two-way-center-turn-lane`, which it defines the
  // same: the centre lane traffic from both directions turns left from.
  "center-left-turn-lane": "center_turn",
  // 3.1: the generic drivable lane, and the deprecated left, right, middle and
  // centre lanes 3.1 tells producers to give as `lane`.
  lane: "general",
  "left-lane": "general",
  "right-lane": "general",
  "middle-lane": "general",
  "center-lane": "general",
  // 3.1: "a lane where right (left) turns are permissible".
  "right-turning-lane": "turn",
  "left-turning-lane": "turn",
  "right-exit-lane": "exit",
  "left-exit-lane": "exit",
  // 3.1 deprecated the second ramps for the exit and entrance lanes.
  "right-second-exit-ramp": "exit",
  "left-second-exit-ramp": "exit",
  "right-exit-ramp": "ramp",
  "left-exit-ramp": "ramp",
  "right-entrance-lane": "entrance",
  "left-entrance-lane": "entrance",
  "right-second-entrance-ramp": "entrance",
  "left-second-entrance-ramp": "entrance",
  "right-entrance-ramp": "ramp",
  "left-entrance-ramp": "ramp",
  "right-shoulder": "shoulder",
  "left-shoulder": "shoulder",
  // 3.1: "a high-occupancy vehicle lane"; which occupancy it needs is a lane
  // restriction (`hov-2`, `hov-3`).
  "hov-lane": "hov",
  // 3.1 deprecated these for a lane `status` (`merge-left`, `merge-right`,
  // `alternating-flow`); the lane itself is a travel lane.
  "right-merging-lane": "general",
  "left-merging-lane": "general",
  "alternating-flow-lane": "general",
  "reversible-lane": "general",
};

/**
 * WZDx `UnitOfMeasurement` (3.1 `LaneRestrictionUnit`) → the kernel's
 * canonical dimension unit and the factor to it. WZDx calls `tons` the
 * "Imperial system 'tons'", as it calls feet, inches and pounds; WZDx is a US
 * standard, whose ton is the short ton of 2000 lb (NIST Handbook 44, Appendix
 * C), the ton of US weight-limit signs, not the British long ton.
 */
export const WZDX_UNITS: Readonly<Record<string, readonly ["m" | "kg", number]>> = {
  feet: ["m", 0.3048],
  inches: ["m", 0.0254],
  centimeters: ["m", 0.01],
  pounds: ["kg", 0.45359237],
  tons: ["kg", 2000 * 0.45359237],
  kilograms: ["kg", 1],
};

/** A WZDx `WorkerPresenceMethod` → the roadworks details' `workerPresenceMethod`. */
export const WZDX_WORKER_PRESENCE_METHODS: Readonly<Record<string, string>> = {
  "camera-monitoring": "camera_monitoring",
  "arrow-board-present": "arrow_board_present",
  "cones-present": "cones_present",
  "maintenance-vehicle-present": "maintenance_vehicle_present",
  "wearables-present": "wearables_present",
  "mobile-device-present": "mobile_device_present",
  "check-in-app": "check_in_app",
  "check-in-verbal": "check_in_verbal",
  scheduled: "scheduled",
};

/** A WZDx `WorkerPresenceDefinition` → the roadworks details' `workerPresenceDefinition`. */
export const WZDX_WORKER_PRESENCE_DEFINITIONS: Readonly<Record<string, string>> = {
  "workers-in-work-zone-working": "workers_working",
  "workers-in-work-zone-not-working": "workers_not_working",
  "mobile-equipment-in-work-zone-moving": "mobile_equipment_moving",
  // The schema's value; the 4.2 page names it `...-not-moving` and defines it
  // as equipment in the work zone that is not moving.
  "mobile-equipment-in-work-zone-not-working": "mobile_equipment_not_moving",
  "fixed-equipment-in-work-zone": "fixed_equipment",
  "humans-behind-barrier": "humans_behind_barrier",
  "humans-in-right-of-way": "humans_in_right_of_way",
};

/**
 * WZDx `related_road_events[].type` → the kernel relation. The sequence
 * values link the road events that together make up one work zone or detour
 * along the road, so they group; only the occurrence values are recurrences
 * in time.
 */
export const WZDX_RELATIONS: Readonly<Record<string, string>> = {
  "first-in-sequence": "group",
  "next-in-sequence": "group",
  "first-occurrence": "first_occurrence",
  "next-occurrence": "next_occurrence",
  "related-work-zone": "related_work_zone",
  "related-detour": "related",
  "planned-moving-operation": "group",
  "active-moving-operation": "group",
};
