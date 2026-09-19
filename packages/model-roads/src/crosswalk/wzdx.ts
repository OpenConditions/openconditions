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

/** WZDx lane `type` → the kernel lane type; `null` = no kernel equivalent. */
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
  "center-left-turn-lane": "turn",
};

/** WZDx `related_road_events[].type` → the kernel relation. */
export const WZDX_RELATIONS: Readonly<Record<string, string>> = {
  "first-in-sequence": "group",
  "next-in-sequence": "next_occurrence",
  "first-occurrence": "first_occurrence",
  "next-occurrence": "next_occurrence",
  "related-work-zone": "related_work_zone",
  "related-detour": "related",
  "planned-moving-operation": "group",
  "active-moving-operation": "group",
};
