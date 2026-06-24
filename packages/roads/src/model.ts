import type {
  ConditionEvent,
  LineStringGeometry,
  Measurement,
  PointGeometry,
} from "@openconditions/core";

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
  restrictions?: Restriction[];
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
  /** Quantified impact, when the source gives it. */
  delaySeconds?: number;
  queueLengthMeters?: number;
  /** WZDx: are workers present in the zone. */
  workersPresent?: boolean;
  /** WZDx work-zone kind. */
  workZoneType?: "static" | "moving" | "area";
  /** Administrative areas the condition sits in (municipality/province/district). */
  regions?: string[];
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
  /** The original provider record, verbatim — a lossless passthrough so no
   * source field is ever dropped, even if not (yet) mapped to a typed field.
   * Persisted under `attributes.sourceRaw`. */
  sourceRaw?: Record<string, unknown>;
}

export interface RoadFlow extends Measurement {
  domain: "roads";
  metric: "flow";
  geometry: PointGeometry | LineStringGeometry;
  los: "free_flow" | "heavy" | "queuing" | "stationary" | "blocked" | "unknown";
  speedKph?: number;
  freeFlowKph?: number;
  speedRatio?: number;
  delaySeconds?: number;
  jamFactor?: number;
}

/**
 * A RoadEvent that carries an OpenLR reference but whose geometry has not yet
 * been resolved. Emitted by the DATEX II parser when a situationRecord has an
 * OpenLR binary location but no coordinate geometry. The ingest resolve stage
 * either promotes it to a full RoadEvent (by filling in geometry) or drops it.
 *
 * Using `geometry?: undefined` (rather than a cast) ensures TypeScript catches
 * any code that treats an UnresolvedRoadEvent as having real geometry without
 * first narrowing on the presence of the geometry field.
 */
export type UnresolvedRoadEvent = Omit<RoadEvent, "geometry"> & {
  geometry?: undefined;
  externalRefs: NonNullable<RoadEvent["externalRefs"]> & { openlr: string };
};

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
  if (ev.delaySeconds != null) attrs["delaySeconds"] = ev.delaySeconds;
  if (ev.queueLengthMeters != null) attrs["queueLengthMeters"] = ev.queueLengthMeters;
  if (ev.workersPresent != null) attrs["workersPresent"] = ev.workersPresent;
  if (ev.workZoneType != null) attrs["workZoneType"] = ev.workZoneType;
  if (ev.regions != null && ev.regions.length > 0) attrs["regions"] = ev.regions;
  if (ev.externalRefs != null) attrs["externalRefs"] = ev.externalRefs;
  // Keyed "sourceRaw" (not "source") so it never clobbers the top-level
  // Observation.source when readObservations spreads attributes back.
  if (ev.sourceRaw != null) attrs["sourceRaw"] = ev.sourceRaw;

  return attrs;
}

/**
 * Map flow-specific fields from a RoadFlow measurement into a plain object for
 * the store's `attributes` JSONB column (the measurement counterpart to
 * roadAttributes; metric/value/level/unit/aggregation go to typed columns).
 */
export function roadFlowAttributes(flow: RoadFlow): Record<string, unknown> {
  const attrs: Record<string, unknown> = { los: flow.los };
  if (flow.speedKph != null) attrs["speedKph"] = flow.speedKph;
  if (flow.freeFlowKph != null) attrs["freeFlowKph"] = flow.freeFlowKph;
  if (flow.speedRatio != null) attrs["speedRatio"] = flow.speedRatio;
  if (flow.delaySeconds != null) attrs["delaySeconds"] = flow.delaySeconds;
  if (flow.jamFactor != null) attrs["jamFactor"] = flow.jamFactor;
  return attrs;
}
