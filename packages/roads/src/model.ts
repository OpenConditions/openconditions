import type {
  ConditionEvent,
  LineStringGeometry,
  Measurement,
  MultiLineStringGeometry,
  PointGeometry,
  Severity,
} from "@openconditions/core";

/**
 * Declarative field mapping for the generic GeoJSON parser. A feed serving a
 * plain GeoJSON FeatureCollection (or an Esri ArcGIS `f=geojson` export) is
 * ingested by naming which `properties` keys carry each field — so a new such
 * source is a config entry, not new code. Geometry is taken verbatim from each
 * feature (GeoJSON is WGS84 by RFC 7946). Field names may be dotted paths into
 * nested `properties`. Unmapped type strings route through the shared taxonomy
 * crosswalk; extend that (not a per-source map) for new vocabularies.
 */
export interface GeoJsonMapping {
  /** properties key for the feature's stable id (falls back to the feed index). */
  idField?: string;
  /** properties key whose value is mapped to a RoadEventType. */
  typeField?: string;
  /**
   * Source-specific value → RoadEventType overrides for this feed's own
   * vocabulary (checked before the shared crosswalk). Keeps a feed's idiosyncratic
   * type strings out of the global taxonomy. Keys are matched case-insensitively.
   */
  typeMap?: Record<string, RoadEventType>;
  /** type to use when the feed has no per-feature type (e.g. a closures-only feed). */
  defaultType?: RoadEventType;
  /** properties key for the human headline/title. */
  headlineField?: string;
  /** properties key for the longer description. */
  descriptionField?: string;
  /** properties key for a severity string, mapped through {@link GeoJsonMapping.severityMap}. */
  severityField?: string;
  /** maps a feed's severity values to the canonical Severity scale. */
  severityMap?: Record<string, Severity>;
  /** properties key for the road name/ref. */
  roadField?: string;
  /** properties key for a last-updated ISO timestamp. */
  updatedField?: string;
  /**
   * For `format: "flatjson"` — dotted path to the records array within the JSON
   * response (e.g. "value" for LTA-style `{value:[…]}`). Omit when the response
   * is a bare array. Combine with lonField/latField for geometry.
   */
  arrayPath?: string;
  /**
   * When both are set, build Point geometry from these WGS84 lon/lat property
   * values instead of the feature's `geometry`. Use when a feed's geometry is in
   * a national grid (not WGS84/Web-Mercator) but it also exposes lon/lat columns
   * (e.g. Iceland's EPSG:3057 features carry WGS84 X/Y properties).
   */
  lonField?: string;
  latField?: string;
}

/**
 * The canonical set of road-event types — the single source of truth.
 *
 * Declared as a runtime tuple (not just a TS union) so the full set is
 * iterable at runtime: validating an inbound `type` string, asserting the
 * taxonomy crosswalk only targets known types, and driving consumer UIs
 * (legends, per-type icons) all read from this one list. `RoadEventType` is
 * derived from it, so the compile-time type and the runtime list cannot drift.
 */
export const ROAD_EVENT_TYPES = [
  "accident",
  "congestion",
  "roadworks",
  "lane_closure",
  "road_closure",
  "contraflow",
  "detour",
  "hazard",
  "weather",
  "road_condition",
  "obstruction",
  "broken_down_vehicle",
  "public_event",
  "authority",
  "speed_restriction",
  "dimension_restriction",
  "equipment_fault",
  "security",
  "transit_disruption",
  "other",
] as const;

export type RoadEventType = (typeof ROAD_EVENT_TYPES)[number];

const ROAD_EVENT_TYPE_SET: ReadonlySet<string> = new Set(ROAD_EVENT_TYPES);

/** Runtime guard: is `value` one of the canonical {@link RoadEventType} values? */
export function isRoadEventType(value: unknown): value is RoadEventType {
  return typeof value === "string" && ROAD_EVENT_TYPE_SET.has(value);
}

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
  /** Validity window for this specific restriction, when the source scopes it
   * to a sub-period of the event (e.g. a digitraffic roadwork-phase restriction
   * active only on certain dates). */
  validFrom?: string;
  validTo?: string;
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
  /** Diversion/alternative-route geometry, when the source provides one
   * (DATEX `alternativeRoute`); the `detour` string is its prose counterpart. */
  detourGeometry?: LineStringGeometry | MultiLineStringGeometry;
  /** Quantified impact, when the source gives it. */
  delaySeconds?: number;
  queueLengthMeters?: number;
  /** WZDx: are workers present in the zone. */
  workersPresent?: boolean;
  /**
   * Provenance of the freeFlowKph baseline behind a derived congestion event
   * (copied from the flow by derivedCongestionEvent): "native" for a feed-carried
   * free-flow reference, "derived" for a history-derived DB baseline, or
   * "osm_maxspeed" for the coarse speed-limit proxy. Records where the baseline
   * came from, independent of how the flow's los was resolved (a los read from a
   * trafficStatus can still rest on a native feed baseline). Unset only when no
   * baseline (inline or DB-resolved) was applied at all — that absence is
   * meaningful: "no free-flow reference behind this event", distinct from
   * severitySource:"derived".
   */
  freeFlowSource?: BaselineMethod;
  /** WZDx work-zone kind. */
  workZoneType?: "static" | "moving" | "area";
  /** Administrative areas the condition sits in (municipality/province/district). */
  regions?: string[];
  /** Related events with their relationship kind (e.g. WZDx `related_road_events`:
   * next-occurrence / first-occurrence / related-work-zone). `relatedIds` keeps
   * the bare ids; this preserves the relationship type alongside each id. */
  relatedEvents?: { id: string; type?: string }[];
  externalRefs?: {
    openlr?: string;
    tmc?: {
      country: string;
      table: number;
      code: number;
      direction?: number;
      extent?: number;
    };
    /** A provider-specific external location code (e.g. NDW's RIS-index, the
     * Dutch road-register reference) — the closest thing some feeds give to a
     * road identity, decodable only against that provider's network dataset. */
    external?: { system: string; code: string };
    linear?: unknown;
  };
  /** The original provider record, verbatim — a lossless passthrough so no
   * source field is ever dropped, even if not (yet) mapped to a typed field.
   * Persisted under `attributes.sourceRaw`. */
  sourceRaw?: Record<string, unknown>;
}

/** Provenance of a resolved free-flow baseline; matches sensor_baseline.method. */
export type BaselineMethod = "native" | "derived" | "osm_maxspeed";

export interface RoadFlow extends Measurement {
  domain: "roads";
  metric: "flow";
  geometry: PointGeometry | LineStringGeometry;
  los: "free_flow" | "heavy" | "queuing" | "stationary" | "blocked" | "unknown";
  speedKph?: number;
  freeFlowKph?: number;
  /**
   * Which provenance produced freeFlowKph (native > derived > osm_maxspeed),
   * independent of how los was resolved. Unset only when no baseline (inline
   * feed reference or DB-resolved) was applied.
   */
  freeFlowSource?: BaselineMethod;
  /** Carriageway direction where the feed carries it; unset otherwise. */
  direction?: string;
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
  if (ev.detourGeometry != null) attrs["detourGeometry"] = ev.detourGeometry;
  if (ev.delaySeconds != null) attrs["delaySeconds"] = ev.delaySeconds;
  if (ev.queueLengthMeters != null) attrs["queueLengthMeters"] = ev.queueLengthMeters;
  if (ev.workersPresent != null) attrs["workersPresent"] = ev.workersPresent;
  if (ev.workZoneType != null) attrs["workZoneType"] = ev.workZoneType;
  if (ev.regions != null && ev.regions.length > 0) attrs["regions"] = ev.regions;
  if (ev.relatedEvents != null && ev.relatedEvents.length > 0) {
    attrs["relatedEvents"] = ev.relatedEvents;
  }
  if (ev.externalRefs != null) attrs["externalRefs"] = ev.externalRefs;
  // Keyed "sourceRaw" (not "source") so it never clobbers the top-level
  // Observation.source when readObservations spreads attributes back.
  if (ev.sourceRaw != null) attrs["sourceRaw"] = ev.sourceRaw;
  if (ev.freeFlowSource != null) attrs["freeFlowSource"] = ev.freeFlowSource;

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
  if (flow.freeFlowSource != null) attrs["freeFlowSource"] = flow.freeFlowSource;
  if (flow.direction != null) attrs["direction"] = flow.direction;
  if (flow.speedRatio != null) attrs["speedRatio"] = flow.speedRatio;
  if (flow.delaySeconds != null) attrs["delaySeconds"] = flow.delaySeconds;
  if (flow.jamFactor != null) attrs["jamFactor"] = flow.jamFactor;
  return attrs;
}
