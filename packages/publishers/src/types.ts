import type { ConditionEvent, Observation } from "@openconditions/core";

/** Feed-level metadata carried by every emitter (foreign members / headers). */
export interface FeedInfo {
  /** Human-readable publisher, e.g. "OpenConditions". */
  attribution?: string;
  /** SPDX or short license id for the aggregate feed. */
  license?: string;
  url?: string;
  /** Generation timestamp (ISO 8601). Pass it in — emitters are pure. */
  timestamp?: string;
}

/** Road-domain fields that live on `RoadEvent`/`RoadFlow`. Read defensively so
 * this package depends only on `@openconditions/core`; mirrors the shape in
 * `@openconditions/roads`. */
export interface RoadFields {
  isPlanned?: boolean;
  roadState?: "open" | "some_lanes_closed" | "single_lane_alternating" | "closed";
  direction?: string;
  roads?: {
    name: string;
    ref?: string;
    roadClass?: string;
    direction?: string;
    from?: string;
    to?: string;
    milepostFrom?: number;
    milepostTo?: number;
  }[];
  lanesAffected?: {
    total?: number;
    closed?: number;
    lanes?: { index: number; status: string; type?: string }[];
    vehicleImpact?: string;
  };
  speedLimitKph?: number;
  restrictions?: { type: string; value?: number; unit?: string }[];
  vehiclesAffected?: string[];
  detour?: string;
  delaySeconds?: number;
  queueLengthMeters?: number;
  workersPresent?: boolean;
  workZoneType?: "static" | "moving" | "area";
  regions?: string[];
  externalRefs?: {
    openlr?: string;
    tmc?: { country: string; table: number; code: number; direction?: number; extent?: number };
  };
  // RoadFlow (measurement) fields.
  los?: string;
  speedKph?: number;
  freeFlowKph?: number;
  speedRatio?: number;
  jamFactor?: number;
}

export function isEvent(o: Observation): o is ConditionEvent {
  return o.kind === "event";
}

export function roadFields(o: Observation): RoadFields {
  return o as unknown as RoadFields;
}
