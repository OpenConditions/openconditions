/**
 * Minimal shim for the host integration surface.
 *
 * The real types come from @openmapx/integration-framework — host-injected at
 * runtime, and re-exported for build-time by the published @openmapx/extension-sdk.
 * When wired into the OpenMapX monorepo, swap this file for that import.
 *
 * monorepo-wired: swap types.ts for the @openmapx/extension-sdk IntegrationContext
 */

import type { RoadConditionRoutingEvidence } from "@openconditions/core";
import type { Effect } from "@openconditions/model";
import type { Geometry, LineString } from "geojson";

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

/** A text in every language the publisher wrote it in, the publisher's own first. */
export type LocalizedText = { lang: string; text: string }[];

export type RoadConditionSeverityLabel = "minor" | "moderate" | "major" | "critical" | "unknown";

export interface RoadConditionAttribution {
  provider: string;
  license?: string;
  url?: string;
}

export interface RoadConditionRoadRef {
  ref?: string;
  name?: LocalizedText;
  class?: string;
  from?: string;
  to?: string;
}

/**
 * A recurring validity rule, shaped after schema.org `Schedule`. Local fields
 * (`startTime`, `startDate`/`endDate`, `byDay`) are interpreted in
 * `scheduleTimezone` (IANA); `duration` is the authoritative occurrence length
 * (overnight-safe). Mirrors the model `Schedule`.
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

/** When a situation holds: the source's declared lifecycle and bounds. */
export interface RoadConditionValidity {
  status: "planned" | "active" | "suspended" | "ended" | "cancelled" | "unknown";
  start?: string;
  end?: string;
  estimatedEnd?: string;
  periods?: RoadConditionSchedule[];
  exceptions?: RoadConditionSchedule[];
}

/** What a situation does to traffic: the model `Effect`, as the host mirrors it. */
export type RoadConditionEffect = Omit<Effect, "source">;

/**
 * One situation record, mapped 1:1. Mirrors OpenMapX `@openmapx/core`'s
 * `RoadConditionEvent`.
 */
export interface RoadConditionEvent {
  /** The record id (`oc:situation:<source>:<local id>`). */
  id: string;
  source: string;
  provider: string;
  /** The source situation a situation split by nature came from, for display grouping. */
  groupId?: string;
  kind: string;
  type: string;
  subtype?: string;
  severity: { label: RoadConditionSeverityLabel; level?: number };
  certainty: "observed" | "likely" | "possible" | "unlikely" | "unknown";
  temporality: "live" | "scheduled" | "forecast";
  planned: boolean;
  headline?: LocalizedText;
  description?: LocalizedText;
  geometry: Geometry;
  roads?: RoadConditionRoadRef[];
  direction?: { value: string; compass?: string; text?: string };
  validity: RoadConditionValidity;
  effects: RoadConditionEffect[];
  origin: "feed" | "crowd" | "federation" | "derived";
  /** A crowd situation's evidence; a feed situation has none. */
  evidence?: { state: string; confidenceScore?: number; routingEligible?: boolean };
  attribution: RoadConditionAttribution;
  /** When the source last changed the situation. */
  updatedAt?: string;
  fetchedAt: string;
  expiresAt?: string;
  /**
   * Current, source-authorized graph evidence per effect id: where each
   * effect is bound, under which rights, until when. Always present: an
   * effect without an entry is not bound for routing (unbound, stale, not
   * licensed, or its evidence could not be read on a display read). Inner
   * keys stay snake_case on the host wire.
   */
  routingEvidence?: Record<string, RoadConditionRoutingEvidence>;
}

export interface RoadConditionsQuery {
  /** Kind codes. */
  kinds?: string[];
  /** Type codes. */
  types?: string[];
  minSeverity?: RoadConditionSeverityLabel;
  /**
   * Keep only situations starting within the next `n` days (`0` = active now).
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
  /** Every situation in the box with its routing evidence; rejects anything incomplete.
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
