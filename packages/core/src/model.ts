import type { RoutingRights, Schedule } from "@openconditions/model";
import type { Geometry, LineString, MultiLineString, Point } from "geojson";

export type GeoJsonGeometry = Geometry;
export type LineStringGeometry = LineString;
export type MultiLineStringGeometry = MultiLineString;
export type PointGeometry = Point;

export interface Attribution {
  provider: string;
  license: string;
  url?: string;
  parentSourceId?: string;
  childSourceId?: string;
  policyIds?: string[];
  rights?: RoutingRights;
}

export type ObservationDomain = "roads" | "transit" | "places" | string;

export type Severity = "low" | "medium" | "high" | "critical" | "unknown";

export type Confidence = "observed" | "likely" | "possible" | "unknown";

/**
 * How precisely an observation's geometry/extent is known. `exact` is the
 * default; the `*_res` values mark deliberately coarsened geometry and the
 * `*_unknown` values mark an open-ended or missing extent boundary.
 */
export type Fuzziness =
  | "exact"
  | "low_res"
  | "medium_res"
  | "end_unknown"
  | "start_unknown"
  | "extent_unknown";

/**
 * The privacy tier an observation was produced under. Governs how it may be
 * exposed/aggregated. (The DB carries an extra `unknown` legacy default that is
 * intentionally NOT part of this enum — a defaulting seam assigns a real class.)
 */
export type PrivacyClass =
  | "authoritative"
  | "aggregate"
  | "k_anon"
  | "dp_noised"
  | "crowd_pseudonym";

/** Outcome of binding an event to the directed segment spine (derived, never parser-supplied). */
export type BindingStatus =
  | "exact"
  | "likely"
  | "ambiguous"
  | "unresolved"
  | "no_coverage"
  | "not_applicable"
  | "obsolete";

/** Whether the resolver could decide the travel direction. `both` = bound in both directions of a bidirectional way. */
export type DirectionMode = "single" | "both" | "unknown";

/** One directed segment an event occupies, with the occupied fraction range along its geometry. */
export interface SegmentSpan {
  segmentId: string;
  wayId: number;
  dir: "f" | "b";
  startFraction: number;
  endFraction: number;
}

export interface SubjectRef {
  type: "geo" | "osm" | "gtfs-stop" | "gtfs-trip" | "gtfs-route" | "place" | "segment";
  id: string;
  role?: string;
}

export interface Provenance {
  kind: "feed";
  attribution: Attribution;
}

export interface Observation {
  id: string;
  source: string;
  /** The wire format the parser read; registry-validated in the new model, a plain string here. */
  sourceFormat: string;
  domain: ObservationDomain;
  kind: "event" | "measurement";

  subject?: SubjectRef[];
  geometry: GeoJsonGeometry;

  status: "active" | "inactive" | "archived" | "cancelled";
  validFrom?: string | null;
  validTo?: string | null;
  schedule?: Schedule[];
  confidence?: Confidence;
  isForecast?: boolean;

  label?: string;

  origin: Provenance;
  dataUpdatedAt: string;
  fetchedAt: string;
  expiresAt?: string;
  isStale: boolean;

  relatedIds?: string[];

  /** Stable id of the instance that wrote this observation. */
  instanceId?: string;
  /** Exact, source-stable record identity (see `canonicalId`). */
  canonicalId?: string;
  /** How precisely the geometry/extent is known (defaults to `exact`). */
  fuzziness?: Fuzziness;
  /** Privacy tier this observation was produced under. */
  privacyClass?: PrivacyClass;
  /** k for k-anonymity, when the observation is a k-anonymized aggregate. */
  kAnonymity?: number;
  /** Differential-privacy epsilon budget spent, when DP-noised. */
  dpEpsilon?: number;
  /** Differential-privacy delta parameter, when DP-noised. */
  dpDelta?: number;
  /** Transit entities this observation informs (modes/routes/stops/trips). */
  informed?: { modes?: string[]; routes?: string[]; stops?: string[]; trips?: string[] };
  /** Canonical URI of the upstream record this observation derives from. */
  sourceUri?: string;
  /** SPDX license the upstream source is published under. */
  sourceLicense?: string;
}

export interface Measurement extends Observation {
  kind: "measurement";
  metric: string;
  value?: number;
  level?: string;
  unit?: string;
  scale?: { min: number; max: number } | string;
  aggregation: "live" | "typical" | "forecast";
  window?: { start: string; end: string };
}
