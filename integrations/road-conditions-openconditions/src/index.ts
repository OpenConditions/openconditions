import type { FeatureCollection } from "geojson";
import { observationsByBbox, type RoadConditionRoutingEvidence } from "@openconditions/core";
import { featureCollectionToRoadConditionEvents } from "./toRoadConditionEvents.js";
import { featureCollectionToRoadFlowSegments } from "./toRoadFlowSegments.js";
import type {
  IntegrationContext,
  RoadConditionsOperationalFeedEvidence,
  RoadConditionsProvider,
  RoadConditionsQuery,
  BBox,
} from "./types.js";

// Attribution is wired in the monorepo via the manifest dataSources.

const PROVIDER_ID = "road-conditions-openconditions";

// This integration's `requires:` service — resolved via platform
// service-discovery below; this fallback only applies when the host has not
// wired the requirement (e.g. tests / dev scripts).
const INGEST_SERVICE_ID = "openconditions-ingest";
const INGEST_FALLBACK_URL = "http://openconditions-ingest:4100";
const MAX_OPERATIONAL_FEEDS = 500;

type SegmentConditionEvidenceResponse = {
  schema_version?: unknown;
  complete?: unknown;
  conditions?: Array<{ id?: unknown; routing_evidence?: RoadConditionRoutingEvidence }>;
};

type RawGraphStatus = {
  generation?: unknown;
  status?: unknown;
  regions?: unknown;
};

type RawFeedStatus = Record<string, unknown> & { id?: unknown; parentSourceId?: unknown };

type RawOperationalStatus = {
  collectedAt?: unknown;
  instanceId?: unknown;
  graph?: RawGraphStatus;
  feeds?: RawFeedStatus[];
};

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function graphOf(raw: RawGraphStatus | undefined): RoadConditionsOperationalFeedEvidence["graph"] {
  const status = raw?.status;
  return {
    generation: stringOrNull(raw?.generation),
    status:
      status === "ready" || status === "partial" || status === "missing" || status === "unknown"
        ? status
        : "unknown",
    regions: Array.isArray(raw?.regions)
      ? raw.regions.filter((region): region is string => typeof region === "string")
      : [],
  };
}

function operationalState(
  feed: RawFeedStatus,
  graph: RoadConditionsOperationalFeedEvidence["graph"],
  collectedAt: string
): Pick<RoadConditionsOperationalFeedEvidence, "status" | "action"> {
  if (feed.selectionState === "discovered")
    return { status: "discovered", action: "approve_source" };
  if (feed.hasCredentials === false)
    return { status: "missing_configuration", action: "configure_credentials" };
  if (graph.status !== "ready") return { status: `graph_${graph.status}`, action: "import_graph" };
  if (feed.lastOutcome === "failed" || (numberOrNull(feed.consecutiveFailures) ?? 0) > 0) {
    return { status: "failed", action: "investigate_poll_failures" };
  }
  const freshUntil = stringOrNull(feed.freshnessDeadline);
  if (freshUntil && Date.parse(freshUntil) <= Date.parse(collectedAt)) {
    return { status: "stale", action: "refresh_source" };
  }
  if (stringOrNull(feed.lastNetworkSuccessAt)) return { status: "healthy", action: null };
  return { status: "unknown", action: null };
}

function bindingCounts(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function changedCount(feed: RawFeedStatus): number | null {
  const values = [feed.lastInserted, feed.lastUpdated, feed.lastDeleted].map(numberOrNull);
  return values.every((value) => value == null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

/**
 * Registers a `road-conditions` provider backed by the shared PostGIS
 * `conditions.observations` table that the OpenConditions ingest service writes.
 * The OpenMapX `road-conditions` orchestrator merges this with any other
 * providers (TomTom/HERE/…) and serves the result to the overlay + navigation.
 */
export function setup(ctx: IntegrationContext): void {
  const ingestUrl = ctx.getRequiredService(INGEST_SERVICE_ID)?.url ?? INGEST_FALLBACK_URL;

  async function readEvents(bbox: BBox, opts?: RoadConditionsQuery, requireComplete = false) {
    const db = ctx.db;
    if (!db) {
      if (requireComplete) throw new Error("Routing observation storage unavailable");
      return [];
    }
    const fc = await observationsByBbox(db, {
      domain: "roads",
      bbox,
      // Incidents only: the shared store also holds high-frequency traffic-flow
      // `measurement` rows (tens of thousands NL-wide). Derived congestion is
      // emitted as kind 'event', so it is still included.
      kind: "event",
      types: opts?.types,
      minSeverity: opts?.minSeverity,
      excludedSourceIds: opts?.excludedSourceIds,
      // Carry the graph binding through to the host: routing consumes the
      // exact/likely spans, the overlay labels the ambiguous ones.
      includeBindings: true,
      requireComplete,
      // Only narrow when the caller asked: routing reads unfiltered so it can
      // evaluate future closures at the chosen travel time.
      ...(opts?.horizonDays != null ? { horizonDays: opts.horizonDays } : {}),
    });
    const events = featureCollectionToRoadConditionEvents(fc);
    if (requireComplete && events.length !== fc.features.length)
      throw new Error("Incomplete routing observation projection");
    try {
      const snapshot = await ctx.http.get<SegmentConditionEvidenceResponse>(
        `${ingestUrl}/segments/conditions.json`,
        {
          params: { bbox: bbox.join(",") },
          ...(requireComplete
            ? { cache: { ttl: 0 }, timeoutMs: 2000, maxResponseBytes: 32 * 1024 * 1024 }
            : {}),
        }
      );
      if (
        snapshot.schema_version === 1 &&
        snapshot.complete === true &&
        Array.isArray(snapshot.conditions)
      ) {
        const byId = new Map(
          snapshot.conditions
            .filter(
              (condition) => typeof condition.id === "string" && condition.routing_evidence != null
            )
            .map((condition) => [condition.id as string, condition.routing_evidence!])
        );
        for (const event of events) {
          const evidence = byId.get(event.id);
          if (evidence) event.routingEvidence = evidence;
        }
      } else if (requireComplete) {
        throw new Error("Incomplete routing evidence snapshot");
      }
    } catch (error) {
      if (requireComplete) throw error;
      // Operational evidence is optional. Display events remain available while the strict projection recovers.
    }
    return events;
  }

  const provider: RoadConditionsProvider = {
    id: PROVIDER_ID,
    getEvents: (bbox, opts) => readEvents(bbox, opts),
    async getRoutingEvents(bbox) {
      return { complete: true, events: await readEvents(bbox, undefined, true) };
    },
    async getFlow(bbox) {
      const fc = await ctx.http.get<FeatureCollection>(`${ingestUrl}/segments.geojson`, {
        params: { bbox: bbox.join(",") },
      });
      return featureCollectionToRoadFlowSegments(fc, PROVIDER_ID);
    },
    async getOperationalEvidence() {
      const raw = await ctx.http.get<RawOperationalStatus>(`${ingestUrl}/feeds/status`);
      const collectedAt = stringOrNull(raw.collectedAt) ?? new Date().toISOString();
      const graph = graphOf(raw.graph);
      const allFeeds = Array.isArray(raw.feeds) ? raw.feeds : [];
      const feeds = allFeeds.slice(0, MAX_OPERATIONAL_FEEDS).flatMap((feed) => {
        const sourceId = stringOrNull(feed.id);
        if (!sourceId) return [];
        const state = operationalState(feed, graph, collectedAt);
        return [
          {
            sourceId,
            ...(stringOrNull(feed.parentSourceId)
              ? { parentSourceId: stringOrNull(feed.parentSourceId)! }
              : {}),
            lastAttemptAt: stringOrNull(feed.lastAttemptAt),
            lastOutcome: stringOrNull(feed.lastOutcome),
            lastSuccessfulCheckAt: stringOrNull(feed.lastNetworkSuccessAt),
            lastPublicationAt: stringOrNull(feed.lastPublicationAt),
            publicationRevision:
              typeof feed.publicationRevision === "number" ||
              typeof feed.publicationRevision === "string"
                ? String(feed.publicationRevision)
                : null,
            upstreamAsOf: stringOrNull(feed.upstreamAsOf),
            freshUntil: stringOrNull(feed.freshnessDeadline),
            expectedIntervalSeconds: numberOrNull(feed.cadenceSec),
            activeEventCount: numberOrNull(feed.activeEvents),
            changedCount: changedCount(feed),
            rejectedCount: numberOrNull(feed.lastRejected),
            consecutiveFailures: numberOrNull(feed.consecutiveFailures),
            error: stringOrNull(feed.lastError),
            bindingCounts: bindingCounts(feed.binding),
            graph,
            ...state,
          } satisfies RoadConditionsOperationalFeedEvidence,
        ];
      });
      return {
        schemaVersion: 1,
        collectedAt,
        instanceId: stringOrNull(raw.instanceId) ?? "openconditions",
        truncated: allFeeds.length > MAX_OPERATIONAL_FEEDS,
        feeds,
      };
    },
  };

  ctx.registerRoadConditionsProvider(provider);
}
