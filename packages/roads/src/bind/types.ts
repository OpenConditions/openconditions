/**
 * Shared types and tuning constants for binding road events to the directed
 * segment spine. The ingest resolver, the scoring step and the emitters all
 * speak these shapes; nothing here has behaviour beyond the defaults.
 */

import type { BindingStatus, DirectionMode, SegmentSpan } from "@openconditions/core";
import type { Geometry } from "geojson";
import type { TravelDirection } from "./direction.js";
import type { LngLat } from "./geo.js";

/** Bumped whenever the resolver's inputs or maths change a stored binding. */
export const RESOLVER_VERSION = "2.6.0";

export const BIND_DEFAULTS = {
  /** Candidate search radius around a sample, in metres. */
  maxOffsetM: 40,
  /** Spacing used when densifying event geometry into samples, in metres. */
  sampleSpacingM: 25,
  /** Upper bound on the spine subgraph loaded for one event. */
  maxSubgraphSegments: 5000,
  /** Lines shorter than this have no usable bearing. */
  minBearingLengthM: 20,
} as const;

export interface BindOptions {
  maxOffsetM?: number;
  sampleSpacingM?: number;
}

export interface SpineSegment {
  segmentId: string;
  wayId: number;
  dir: "f" | "b";
  highway: string;
  ref: string | null;
  /** The way's OSM `name`; absent from spines captured before names were read. */
  name?: string | null;
  /** Directed geometry: coordinates run in travel direction. */
  coords: LngLat[];
  lengthM: number;
}

export interface SpineSubgraph {
  segments: SpineSegment[];
}

export interface BindInput {
  id: string;
  geometry: Geometry;
  type: string;
  /** Already normalized (see refs.ts). */
  refs: string[];
  /** Street names the location states, normalized (see identity.ts); absent when none. */
  names?: string[];
  /** The record's prose, normalized, where its names were read from it (see identity.ts). */
  prose?: string;
  /** The source's direction as text; kept for inspection, not interpreted. */
  direction?: string;
  /**
   * The direction of travel the location applies to (`travelDirectionOf`).
   * It narrows a binding to one carriageway, or keeps it from routing where
   * the geometry cannot place it; absent, the geometry alone decides.
   */
  travel?: TravelDirection;
  roadState?: string;
  /**
   * The location stands for a slip road (a closure of a ramp): only the
   * `*_link` ways of its path are bound. A source draws such a location on
   * into the carriageway the ramp merges with or leaves, and that carriageway
   * stays open.
   */
  slipRoadOnly?: boolean;
}

export interface Candidate {
  segment: SpineSegment;
  offsetM: number;
  fraction: number;
  bearingDelta: number | null;
  identity: number;
  score: number;
}

export interface BindDebug {
  samples: Array<{ point: LngLat; candidates: Candidate[] }>;
  pathScore: number | null;
  coverage: number | null;
  meanOffsetM: number | null;
  ambiguity: number | null;
}

export interface BindResult {
  status: BindingStatus;
  confidence: number | null;
  directionMode: DirectionMode;
  candidateCount: number;
  /**
   * Confidence the runner-up would have carried: `ambiguity × confidence`,
   * where `ambiguity` is the best rejected score divided by the chosen one.
   * `null` when nothing competed for this event.
   */
  alternativeConfidence: number | null;
  reason?: string;
  segments: SegmentSpan[];
  debug: BindDebug;
}
