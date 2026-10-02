import type { RoadConditionRoutingEvidence } from "@openconditions/core";
import type { FeatureCollection } from "geojson";
import { situationToRoadConditionEvent } from "./situation.js";
import { featureCollectionToRoadFlowSegments } from "./toRoadFlowSegments.js";
import type {
  BBox,
  IntegrationContext,
  RoadConditionEvent,
  RoadConditionsOperationalFeedEvidence,
  RoadConditionsProvider,
  RoadConditionsQuery,
} from "./types.js";

// Attribution is wired in the monorepo via the manifest dataSources.

const PROVIDER_ID = "road-conditions-openconditions";

// This integration's `requires:` service — resolved via platform
// service-discovery below; this fallback only applies when the host has not
// wired the requirement (e.g. tests / dev scripts).
const INGEST_SERVICE_ID = "openconditions-ingest";
const INGEST_FALLBACK_URL = "http://openconditions-ingest:4100";
const MAX_OPERATIONAL_FEEDS = 500;
/** A display read stops after this many situations; a routing read reads them all. */
const DISPLAY_MAX = 2000;
const DISPLAY_PAGE = 1000;
const ROUTING_PAGE = 5000;

type Rec = Record<string, unknown>;

type SituationPage = { records?: unknown; next?: unknown };

type SegmentConditionEvidenceResponse = {
  schema_version?: unknown;
  complete?: unknown;
  conditions?: Array<{ routing_evidence?: RoadConditionRoutingEvidence }>;
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
  collectedAt: string,
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
    (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function changedCount(feed: RawFeedStatus): number | null {
  const values = [feed.lastInserted, feed.lastUpdated, feed.lastDeleted].map(numberOrNull);
  return values.every((value) => value == null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

/** Whether a record comes from a source, or a catalogue child of a source, the deployment excluded. */
function excluded(record: Rec, sources: ReadonlySet<string>): boolean {
  const provenance = (record["provenance"] ?? {}) as Rec;
  const attribution = (provenance["attribution"] ?? {}) as Rec;
  return (
    sources.has(String(provenance["sourceId"])) ||
    sources.has(String(attribution["parentSourceId"] ?? ""))
  );
}

/**
 * Registers a `road-conditions` provider backed by the OpenConditions record
 * API: situations from `GET /situations`, their routing evidence from
 * `GET /segments/conditions.json`, flow from `GET /segments.geojson`. The
 * OpenMapX `road-conditions` orchestrator merges this with any other
 * providers (TomTom/HERE/…) and serves the result to the overlay + navigation.
 */
export function setup(ctx: IntegrationContext): void {
  const ingestUrl = ctx.getRequiredService(INGEST_SERVICE_ID)?.url ?? INGEST_FALLBACK_URL;

  /**
   * The situations in `bbox`, page after page until `next` is null. A display
   * read stops at `DISPLAY_MAX`; a routing read reads every page, and any page
   * that fails or does not parse fails the whole read.
   */
  async function readSituations(
    bbox: BBox,
    opts: RoadConditionsQuery | undefined,
    routing: boolean,
  ): Promise<Rec[]> {
    const records: Rec[] = [];
    let cursor: string | null = null;
    do {
      const page: SituationPage = await ctx.http.get<SituationPage>(`${ingestUrl}/situations`, {
        params: {
          bbox: bbox.join(","),
          limit: routing ? ROUTING_PAGE : DISPLAY_PAGE,
          ...(opts?.kinds?.length ? { kind: opts.kinds.join(",") } : {}),
          ...(opts?.types?.length ? { type: opts.types.join(",") } : {}),
          ...(opts?.minSeverity ? { minSeverity: opts.minSeverity } : {}),
          // Only narrow when the caller asked: routing reads unfiltered so it
          // can evaluate future closures at the chosen travel time.
          ...(opts?.horizonDays != null ? { horizonDays: opts.horizonDays } : {}),
          ...(cursor !== null ? { cursor } : {}),
        },
        cache: { ttl: 0 },
        ...(routing ? { timeoutMs: 5000, maxResponseBytes: 64 * 1024 * 1024 } : {}),
      });
      if (!Array.isArray(page.records) || (page.next !== null && typeof page.next !== "string")) {
        throw new Error("Malformed situation page");
      }
      records.push(...(page.records as Rec[]));
      cursor = page.next as string | null;
    } while (cursor !== null && (routing || records.length < DISPLAY_MAX));
    const without = new Set(opts?.excludedSourceIds ?? []);
    return without.size === 0 ? records : records.filter((r) => !excluded(r, without));
  }

  /**
   * The events of `records`, each with an evidence map that starts empty.
   * OpenConditions publishes routing evidence for every effect it binds, so an
   * effect without an entry is unbound, stale or not licensed for routing: the
   * host must not stand in its raw geometry for a binding.
   */
  function eventsOf(records: readonly Rec[]): RoadConditionEvent[] {
    return records.flatMap((record) => {
      const event = situationToRoadConditionEvent(record, PROVIDER_ID);
      return event ? [{ ...event, routingEvidence: {} }] : [];
    });
  }

  /**
   * The situations of `records` with the routing evidence of their effects.
   * The evidence is read after the situations, so a situation that changed in
   * between fails a strict read rather than routing on stale evidence; a
   * display read keeps the situation and leaves its evidence out. Both reads
   * match a situation by its own place or any of its effects', so evidence of
   * a situation the walk did not return names one that appeared after the
   * walk; it is left out and routes from the next read.
   */
  async function withEvidence(
    bbox: BBox,
    records: readonly Rec[],
    strict: boolean,
  ): Promise<RoadConditionEvent[]> {
    const snapshot = await ctx.http.get<SegmentConditionEvidenceResponse>(
      `${ingestUrl}/segments/conditions.json`,
      {
        params: { bbox: bbox.join(",") },
        cache: { ttl: 0 },
        ...(strict ? { timeoutMs: 2000, maxResponseBytes: 32 * 1024 * 1024 } : {}),
      },
    );
    if (
      snapshot.schema_version !== 2 ||
      snapshot.complete !== true ||
      !Array.isArray(snapshot.conditions)
    ) {
      throw new Error("Incomplete routing evidence snapshot");
    }
    const byId = new Map(records.map((r) => [String(r["id"]), r]));
    const events = new Map(eventsOf(records).map((e) => [e.id, e]));
    const changed = new Set<string>();
    for (const condition of snapshot.conditions) {
      const evidence = condition.routing_evidence;
      if (evidence == null) continue;
      const record = byId.get(evidence.record_id);
      const event = events.get(evidence.record_id);
      if (record === undefined || event === undefined) continue;
      const current =
        record["revision"] === evidence.record_revision &&
        event.effects.some((effect) => effect.id === evidence.effect_id);
      if (!current) {
        if (strict) throw new Error(`Situation changed during routing read: ${evidence.record_id}`);
        changed.add(event.id);
        continue;
      }
      event.routingEvidence = { ...event.routingEvidence, [evidence.effect_id]: evidence };
    }
    // A display read never attaches part of a changed situation's evidence.
    for (const id of changed) events.get(id)!.routingEvidence = {};
    return [...events.values()];
  }

  /**
   * A display read: the situations, with their routing evidence when it can
   * be read. Evidence is optional here; the situations stay available while
   * the evidence read recovers.
   */
  async function readEvents(bbox: BBox, opts?: RoadConditionsQuery) {
    const records = await readSituations(bbox, opts, false);
    try {
      return await withEvidence(bbox, records, false);
    } catch {
      return eventsOf(records);
    }
  }

  const provider: RoadConditionsProvider = {
    id: PROVIDER_ID,
    getEvents: readEvents,
    async getRoutingEvents(bbox) {
      const records = await readSituations(bbox, undefined, true);
      return { complete: true, events: await withEvidence(bbox, records, true) };
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
