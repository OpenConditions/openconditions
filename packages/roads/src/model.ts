import type { ConditionEvent, Measurement } from "@openconditions/core";

export type RoadEventType =
  | "accident"
  | "congestion"
  | "roadworks"
  | "lane_closure"
  | "road_closure"
  | "contraflow"
  | "detour"
  | "hazard"
  | "weather"
  | "road_condition"
  | "obstruction"
  | "broken_down_vehicle"
  | "public_event"
  | "authority"
  | "speed_restriction"
  | "dimension_restriction"
  | "equipment_fault"
  | "security"
  | "transit_disruption"
  | "other";

export interface RoadRef {
  name: string;
  ref?: string;
  roadClass?: string;
  direction?: string;
  from?: string;
  to?: string;
  milepostFrom?: number;
  milepostTo?: number;
}

export interface LaneStatus {
  index: number;
  status: "open" | "closed" | "alternating";
  type?: string;
}

export interface Restriction {
  type: string;
  value?: number;
  unit?: string;
}

export interface RoadEvent extends ConditionEvent {
  domain: "roads";
  type: RoadEventType;
  isPlanned: boolean;
  direction?: string;
  roads: RoadRef[];
  roadState?: "open" | "some_lanes_closed" | "single_lane_alternating" | "closed";
  lanesAffected?: {
    total?: number;
    closed?: number;
    lanes?: LaneStatus[];
    vehicleImpact?: string;
  };
  speedLimitKph?: number;
  restrictions?: Restriction[];
  vehiclesAffected?: string[];
  detour?: string;
  externalRefs?: {
    openlr?: string;
    tmc?: {
      country: string;
      table: number;
      code: number;
      direction?: number;
      extent?: number;
    };
    linear?: unknown;
  };
}

export interface RoadFlow extends Measurement {
  domain: "roads";
  metric: "flow";
  los:
    | "free_flow"
    | "heavy"
    | "queuing"
    | "stationary"
    | "blocked"
    | "unknown";
  speedKph?: number;
  freeFlowKph?: number;
  speedRatio?: number;
  delaySeconds?: number;
  jamFactor?: number;
}

/**
 * Map road-specific fields from a RoadEvent into a plain object for
 * the store's `attributes` JSONB column.
 */
export function roadAttributes(ev: RoadEvent): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    roads: ev.roads,
    isPlanned: ev.isPlanned,
  };

  if (ev.direction != null) attrs["direction"] = ev.direction;
  if (ev.roadState != null) attrs["roadState"] = ev.roadState;
  if (ev.lanesAffected != null) attrs["lanesAffected"] = ev.lanesAffected;
  if (ev.speedLimitKph != null) attrs["speedLimitKph"] = ev.speedLimitKph;
  if (ev.restrictions != null && ev.restrictions.length > 0) {
    attrs["restrictions"] = ev.restrictions;
  }
  if (ev.vehiclesAffected != null && ev.vehiclesAffected.length > 0) {
    attrs["vehiclesAffected"] = ev.vehiclesAffected;
  }
  if (ev.detour != null) attrs["detour"] = ev.detour;
  if (ev.externalRefs != null) attrs["externalRefs"] = ev.externalRefs;

  return attrs;
}
