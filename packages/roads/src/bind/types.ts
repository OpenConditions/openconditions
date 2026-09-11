/**
 * Shared types and tuning constants for binding road events to the directed
 * segment spine. The ingest resolver, the scoring step and the emitters all
 * speak these shapes; nothing here has behaviour beyond the defaults.
 */

import type { Geometry } from "geojson";
import type { BindingStatus, DirectionMode, SegmentSpan } from "@openconditions/core";
import type { LngLat } from "./geo.js";

/** Bumped whenever the resolver's inputs or maths change a stored binding. */
export const RESOLVER_VERSION = "1.2.0";

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
  direction?: string;
  roadState?: string;
}

export interface Candidate {
  segment: SpineSegment;
  offsetM: number;
  fraction: number;
  bearingDelta: number | null;
  refScore: number;
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
