/**
 * Minimal shim for the host integration surface.
 *
 * The real types come from @openmapx/integration-framework — host-injected at
 * runtime, and re-exported for build-time by the published @openmapx/extension-sdk.
 * When wired into the OpenMapX monorepo, swap this file for that import.
 *
 * `db` mirrors OpenMapX's `DatabaseClient` exactly (positional-parameter `execute`), and is
 * present only when the manifest declares `requires: [{ service: "postgis" }]`.
 *
 * monorepo-wired: swap types.ts for the @openmapx/extension-sdk IntegrationContext
 */

import type { Geometry } from "geojson";

/** Matches OpenMapX `IntegrationContext.db` (DatabaseClient). */
export interface DatabaseClient {
  execute<T = unknown>(query: string, params?: unknown[]): Promise<T>;
}

export type BBox = [west: number, south: number, east: number, north: number];

export type RoadConditionType =
  | "accident"
  | "roadworks"
  | "road_closure"
  | "lane_closure"
  | "hazard"
  | "congestion"
  | "weather"
  | "event"
  | "restriction"
  | "other";

export type RoadConditionSeverity = "low" | "medium" | "high" | "critical" | "unknown";

export type RoadState = "open" | "closed" | "some_lanes_closed" | "single_lane_alternating";

export interface RoadConditionAttribution {
  provider: string;
  license?: string;
  url?: string;
}

export interface RoadConditionRoadRef {
  name: string;
  direction?: string;
}

/**
 * A recurring validity rule, shaped after schema.org `Schedule`. Local fields
 * (`startTime`, `startDate`/`endDate`, `byDay`) are interpreted in
 * `scheduleTimezone` (IANA); `duration` is the authoritative occurrence length
 * (overnight-safe). Mirrors the canonical `Schedule` + the host contract.
 */
export interface RoadConditionSchedule {
  repeatFrequency?: string;
  repeatCount?: number;
  startDate?: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  duration?: string;
  byDay?: string[];
  byMonth?: number[];
  byMonthDay?: number[];
  exceptDate?: string[];
  scheduleTimezone: string;
}

export interface RoadConditionEvent {
  id: string;
  source: string;
  provider: string;
  type: RoadConditionType;
  severity: RoadConditionSeverity;
  geometry: Geometry;
  headline: string;
  description?: string;
  roadState?: RoadState;
  roads?: RoadConditionRoadRef[];
  validFrom?: string | null;
  validTo?: string | null;
  /** Fine-grained recurring schedule (e.g. nightly closures); when present, an
   * event is in effect only inside a window, not across the whole from–to span. */
  schedule?: RoadConditionSchedule[];
  dataUpdatedAt?: string;
  attribution?: RoadConditionAttribution;
}

export interface RoadConditionsQuery {
  types?: RoadConditionType[];
  minSeverity?: RoadConditionSeverity;
}

export interface RoadConditionsProvider {
  readonly id: string;
  readonly attribution?: RoadConditionAttribution[];
  readonly coverage?: { bbox: BBox } | { all: true };
  getEvents(bbox: BBox, opts?: RoadConditionsQuery): Promise<RoadConditionEvent[]>;
}

export interface IntegrationContext {
  db?: DatabaseClient;
  cache: {
    withCache<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T>;
  };
  registerRoadConditionsProvider(provider: RoadConditionsProvider): void;
  manifest: {
    dataSources?: unknown[];
  };
}
