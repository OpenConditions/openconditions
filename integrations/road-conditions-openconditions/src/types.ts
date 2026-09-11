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

import type { Geometry, LineString } from "geojson";
import type { RoadConditionRoutingEvidence } from "@openconditions/core";

/** Matches OpenMapX `IntegrationContext.db` (DatabaseClient). */
export interface DatabaseClient {
  execute<T = unknown>(query: string, params?: unknown[]): Promise<T>;
}

export interface HttpClientOptions {
  cache?: { ttl: number };
  timeoutMs?: number;
  maxResponseBytes?: number;
  params?: Record<string, string | number | boolean | undefined>;
}

/** Matches OpenMapX `IntegrationContext.http` (`HttpClient`, `get` only — this
 * provider never needs `post`). Auto-parses JSON and throws on a non-2xx
 * response. */
export interface HttpClient {
  get<T = unknown>(url: string, options?: HttpClientOptions): Promise<T>;
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
  /** Provider-supplied identity of the source situation for display grouping. */
  groupId?: string;
  type: RoadConditionType;
  severity: RoadConditionSeverity;
  geometry: Geometry;
  headline: string;
  description?: string;
  /** Estimated delay in seconds this event adds vs. free flow (DATEX
   * delayTimeValue / Verlustzeit), where the source reports it. */
  delaySeconds?: number;
  roadState?: RoadState;
  roads?: RoadConditionRoadRef[];
  validFrom?: string | null;
  validTo?: string | null;
  /** Fine-grained recurring schedule (e.g. nightly closures); when present, an
   * event is in effect only inside a window, not across the whole from–to span. */
  schedule?: RoadConditionSchedule[];
  dataUpdatedAt?: string;
  attribution?: RoadConditionAttribution;
  /**
   * Provenance kind: `"feed"` (authoritative official source) or `"crowd"` (user
   * report). Drives the host's routing gate and overlay "unconfirmed" labeling.
   * Mirrors OpenMapX `@openmapx/core`'s `RoadConditionEvent.originKind`.
   */
  originKind?: "feed" | "crowd";
  /**
   * Whether a crowd event is corroborated strongly enough to affect routing.
   * Feed events leave this undefined (they always route).
   */
  routingEligible?: boolean;
  /** Evidence maturity of a crowd report (e.g. `"self_reported"`). */
  evidenceState?: string;
  /** Aggregate confidence score for a crowd event (0..1). */
  confidenceScore?: number;
  /** Upstream announced this condition before it takes effect. */
  isForecast?: boolean;
  /** Scheduled work rather than an unplanned incident. */
  isPlanned?: boolean;
  /** Vehicle classes a restriction applies to (e.g. ["truck"]); empty/absent = all traffic. */
  vehiclesAffected?: string[];
  /** Graph-binding outcome for this event, when the instance has bound it. */
  binding?: {
    status:
      | "exact"
      | "likely"
      | "ambiguous"
      | "unresolved"
      | "no_coverage"
      | "not_applicable"
      | "obsolete";
    confidence?: number;
    directionMode?: "single" | "both" | "unknown";
  };
  /** Ordered directed OSM-way spans the event occupies (only for exact/likely/ambiguous). */
  segments?: Array<{ wayId: number; dir: "f" | "b"; startFraction: number; endFraction: number }>;
  /** Current, source-authorized graph evidence. Inner keys intentionally stay snake_case on the host wire. */
  routingEvidence?: RoadConditionRoutingEvidence;
}

export interface RoadConditionsQuery {
  types?: RoadConditionType[];
  minSeverity?: RoadConditionSeverity;
  /**
   * Keep only conditions in effect within the next `n` days (`0` = active now).
   * Undefined means no temporal filter — the routing path depends on that.
   */
  horizonDays?: number;
  /** Deployment-policy source identities removed before provider dedupe. */
  excludedSourceIds?: string[];
}

/**
 * A directed, colored road segment — the `getFlow` counterpart to
 * `RoadConditionEvent`. Mirrors OpenMapX `@openmapx/core`'s `RoadFlowSegment`
 * host contract. `los` and `confidence` are required: a segment with no fused
 * speed still needs a value, mapped to `"unknown"`/`"typical"` respectively —
 * never invent a ratio.
 */
export interface RoadFlowSegment {
  id: string;
  geometry: LineString;
  currentSpeedKph?: number;
  freeFlowSpeedKph?: number;
  speedRatio?: number;
  los: "free_flow" | "heavy" | "queuing" | "stationary" | "unknown";
  confidence: "measured" | "estimated" | "typical" | "unknown";
  direction: "f" | "b";
  roads?: string;
  source?: string;
  observedAt?: string;
}

export interface RoadFlowQuery {
  minLos?: string;
}

export interface RoadConditionsProvider {
  readonly id: string;
  readonly attribution?: RoadConditionAttribution[];
  readonly coverage?: { bbox: BBox } | { all: true };
  getEvents(bbox: BBox, opts?: RoadConditionsQuery): Promise<RoadConditionEvent[]>;
  /** Complete, uncollapsed observations for routing; reject overflow or unavailable data.
   * Display-only lists cannot establish routing coverage. */
  getRoutingEvents?(bbox: BBox): Promise<{ complete: true; events: RoadConditionEvent[] }>;

  /** Optional: colored-segment traffic-flow source. Undefined for providers
   * that only surface incidents (the orchestrator's `aggregateRoadFlow`
   * filters to providers that implement this). */
  getFlow?(bbox: BBox, opts?: RoadFlowQuery): Promise<RoadFlowSegment[]>;
  getOperationalEvidence?(): Promise<RoadConditionsOperationalEvidence>;
}

export interface RoadConditionsOperationalFeedEvidence {
  sourceId: string;
  parentSourceId?: string;
  lastAttemptAt: string | null;
  lastOutcome: string | null;
  lastSuccessfulCheckAt: string | null;
  lastPublicationAt: string | null;
  publicationRevision: string | null;
  upstreamAsOf: string | null;
  freshUntil: string | null;
  expectedIntervalSeconds: number | null;
  activeEventCount: number | null;
  changedCount: number | null;
  rejectedCount: number | null;
  consecutiveFailures: number | null;
  error: string | null;
  bindingCounts: Record<string, number> | null;
  graph: {
    generation: string | null;
    status: "ready" | "partial" | "missing" | "unknown";
    regions: string[];
  };
  status: string;
  action: string | null;
}

export interface RoadConditionsOperationalEvidence {
  schemaVersion: 1;
  collectedAt: string;
  instanceId: string;
  truncated?: boolean;
  feeds: RoadConditionsOperationalFeedEvidence[];
}

export interface IntegrationContext {
  db?: DatabaseClient;
  http: HttpClient;
  cache: {
    withCache<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T>;
  };
  /** Matches OpenMapX `IntegrationContext.getRequiredService` — resolves a
   * `requires:` entry (service slug or capability) to its reachable target, or
   * `null` when unsatisfied. */
  getRequiredService(key: string): { serviceId: string; url: string; enabled: boolean } | null;
  registerRoadConditionsProvider(provider: RoadConditionsProvider): void;
  manifest: {
    dataSources?: unknown[];
  };
}
