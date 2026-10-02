import type {
  ConditionEvent,
  LineStringGeometry,
  Measurement,
  MultiLineStringGeometry,
  PointGeometry,
  Severity,
} from "@openconditions/core";
import type { Text, Validity } from "@openconditions/model";
import type { RoadClassification, RoadRestrictionDetailsV1 } from "@openconditions/model-roads";

/**
 * Declarative field mapping for the generic GeoJSON parser. A feed serving a
 * plain GeoJSON FeatureCollection (or an Esri ArcGIS `f=geojson` export) is
 * ingested by naming which `properties` keys carry each field — so a new such
 * source is a config entry, not new code. Geometry is taken verbatim from each
 * feature (GeoJSON is WGS84 by RFC 7946). Field names may be dotted paths into
 * nested `properties`. A feed's type strings are its own vocabulary: the
 * feed's `typeMap` says what each one means.
 */
export interface GeoJsonMapping {
  /** properties key for the feature's stable id (falls back to the feed index). */
  idField?: string;
  /** properties key whose value is mapped to a RoadEventType. */
  typeField?: string;
  /**
   * This feed's type values → what they mean: a coarse RoadEventType, or a
   * registered roads situation code (`roadworks.works.bridge_work`) where the
   * value names a classification, whose coarse type follows from it. Keys are
   * matched case-insensitively; an unmapped value takes `defaultType`.
   */
  typeMap?: Record<string, RoadEventType | `${string}.${string}`>;
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
  /**
   * properties keys carrying the validity window. Values go through
   * `toIsoTimestamp`, so epoch numbers and parseable date strings both work; an
   * unparseable value becomes null rather than dropping the record.
   *
   * A source publishing a zone-less local time (MTQ's "2026/02/09 06:30:00") is
   * read in the server's local zone — an hours-level approximation, fine for a
   * days-granularity horizon filter but not for reasoning about the exact
   * minute a work starts.
   */
  validFromField?: string;
  validToField?: string;
  /**
   * Drop records the feed publishes but the overlay shouldn't carry — e.g.
   * Iceland's ~1,300 "Easily passable" baseline segments. A feature must
   * satisfy EVERY entry. Values compare as strings; a missing value passes an
   * `exclude` entry and fails an `include` one.
   */
  filter?: GeoJsonRecordFilter[];
  /**
   * When the feature carries no usable geometry and all four parse to finite
   * numbers, synthesise `LineString [[startLon,startLat],[endLon,endLat]]`.
   * Values must already be WGS84 — properties are never reprojected, unlike the
   * feature's own geometry.
   */
  startLonField?: string;
  startLatField?: string;
  endLonField?: string;
  endLatField?: string;
}

/** One clause of {@link GeoJsonMapping.filter}. */
export interface GeoJsonRecordFilter {
  field: string;
  include?: string[];
  exclude?: string[];
}

/**
 * The canonical set of road-event types — the single source of truth.
 *
 * Declared as a runtime tuple (not just a TS union) so the full set is
 * iterable at runtime: validating an inbound `type` string and driving consumer UIs
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
  /** Source comparison semantics, retained verbatim until every operator can be normalized safely. */
  operator?: string;
  /** Minimal source tokens used to derive this normalized restriction. */
  raw?: Record<string, unknown>;
  /** Validity window for this specific restriction, when the source scopes it
   * to a sub-period of the event (e.g. a digitraffic roadwork-phase restriction
   * active only on certain dates). */
  validFrom?: string;
  validTo?: string;
}

/**
 * What a parser knows for the situation model that the RoadEvent fields cannot
 * carry. The situation assembler prefers these over the legacy fields.
 */
export interface SituationHints {
  /** The classification from the source's own codes, via the roads crosswalk. */
  classification?: RoadClassification;
  /**
   * The publisher's timestamp for this record. Absent when the source gives
   * none: `dataUpdatedAt` falls back to other times, this never does.
   */
  sourceUpdatedAt?: string;
  /** False when the parser synthesised `headline` because the source has none. */
  headlineFromSource?: false;
  /**
   * Set on a situation OpenConditions derived from a measurement rather than
   * read from the source: the local id of the measurement site it came from.
   */
  derivedFromSite?: string;
  /** The headline in every language the source wrote it in, its primary first. */
  headline?: Text;
  /** The description in every language the source wrote it in. */
  description?: Text;
  /** The source's further comments, each in every language it wrote it in. */
  comments?: { type?: "public" | "operator" | "detour" | "internal"; text: Text }[];
  /** The severity token exactly as the source declared it. */
  severityRaw?: string;
  /** The source's lifecycle where it says more than active or ended (DATEX `suspended`). */
  validityStatus?: Validity["status"];
}

/**
 * What a flow parse record says about the measurement site behind it, beyond
 * the old fields: the site is the feature, the record one reading of it.
 */
export interface FlowSiteHints {
  /** The site's source-local id; every reading of one site shares it. */
  id: string;
  /** The stream within the site when the source reports directions separately (its own numbering). */
  channel?: string;
  /** Set when `los` was computed from speed and free-flow speed rather than stated by the source. */
  losDerived?: true;
}

export interface RoadEvent extends ConditionEvent {
  domain: "roads";
  situation?: SituationHints;
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
  /**
   * The normalized vehicle-restriction display contract. Its presence — even
   * of a partial or empty-fact envelope — is restriction evidence, so the
   * record is withheld from shared routing and from exporters that cannot
   * represent its scope. Legacy `restrictions` stays for existing parsers and
   * is never the authority for these facts.
   */
  restrictionDetails?: RoadRestrictionDetailsV1;
  /**
   * Set when a present restriction envelope could not be validated. Consumers
   * must treat it exactly like present details: an uninterpretable claim about
   * vehicle applicability is not the same as no claim at all.
   */
  restrictionDetailsUnsupported?: true;
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
  /** Stable identity of the enclosing DATEX situation; not a record or lineage id. */
  situationId?: string;
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
  /**
   * Set when the geometry did not come from the feed but was derived from a TMC
   * location table. It records which table placed the event, both because the
   * table's licence requires attribution wherever its data travels, and because
   * such geometry is only as precise as the table's coded points (a few hundred
   * metres) — consumers should be able to tell it apart from a feed coordinate.
   */
  locationTable?: {
    /** e.g. "TMC 58/1" — country and table code. */
    ref: string;
    version: string;
    attribution?: string;
    license?: string;
    /**
     * Set when the record named a different table edition and was placed only
     * because its codes resolved onto the road it claims to be about. Such a
     * placement rests on that cross-check rather than on matching editions.
     */
    viaRoadMatch?: boolean;
  };
}

/** Provenance of a resolved free-flow baseline; matches sensor_baseline.method. */
export type BaselineMethod = "native" | "derived" | "osm_maxspeed";

export interface RoadFlow extends Measurement {
  domain: "roads";
  metric: "flow";
  site?: FlowSiteHints;
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
  /** Traffic volume q in vehicles per hour, where the feed reports it (DATEX
   * TrafficFlow / vehicleFlowRate). Independent of speed/los. */
  volume?: number;
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
 * Map flow-specific fields from a RoadFlow measurement into a plain object for
 * the store's `attributes` JSONB column (metric/value/level/unit/aggregation
 * go to typed columns).
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
  if (flow.volume != null) attrs["volume"] = flow.volume;
  return attrs;
}
