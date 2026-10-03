import type { RoutingRights } from "@openconditions/model";
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

export type Severity = "low" | "medium" | "high" | "critical" | "unknown";

export type Confidence = "observed" | "likely" | "possible" | "unknown";

/**
 * How precisely a parsed record's geometry/extent is known. `exact` is the
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
 * The privacy tier a record was produced under. Governs how it may be
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
