import { describe, expect, it } from "vitest";
import { setup } from "../index.js";
import type { IntegrationContext, RoadConditionsProvider } from "../types.js";

const fakeRow = {
  id: "evt-001",
  source: "ndw",
  domain: "roads",
  kind: "event",
  type: "accident",
  severity: "medium",
  headline: "Lane closure on A2",
  description: "Roadwork causing single-lane traffic",
  attributes: { roads: [{ name: "A2" }], roadState: "some_lanes_closed" },
  valid_to: null,
  geojson: JSON.stringify({ type: "Point", coordinates: [5.0, 52.0] }),
  origin: { kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" } },
  is_stale: false,
};

function makeCtx(
  rows: unknown[],
  opts?: {
    noDb?: boolean;
    capture?: (query: string, params?: unknown[]) => void;
    fetchFc?: unknown;
    fetchByUrl?: (url: string) => unknown;
    captureFetch?: (url: string, options?: { params?: Record<string, unknown> }) => void;
    serviceUrl?: string;
  }
): { ctx: IntegrationContext; registered: RoadConditionsProvider[] } {
  const registered: RoadConditionsProvider[] = [];
  const ctx: IntegrationContext = {
    db: opts?.noDb
      ? undefined
      : {
          async execute<T = unknown>(query: string, params?: unknown[]): Promise<T> {
            opts?.capture?.(query, params);
            return rows as T;
          },
        },
    http: {
      async get<T = unknown>(
        url: string,
        options?: { params?: Record<string, unknown> }
      ): Promise<T> {
        opts?.captureFetch?.(url, options);
        return (opts?.fetchByUrl?.(url) ??
          opts?.fetchFc ?? { type: "FeatureCollection", features: [] }) as T;
      },
    },
    cache: {
      async withCache<T>(_key: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
        return fn();
      },
    },
    getRequiredService(key) {
      return opts?.serviceUrl ? { serviceId: key, url: opts.serviceUrl, enabled: true } : null;
    },
    registerRoadConditionsProvider(p) {
      registered.push(p);
    },
    manifest: { dataSources: [] },
  };
  return { ctx, registered };
}

describe("road-conditions-openconditions provider", () => {
  it("setup registers exactly one provider with the expected id", () => {
    const { ctx, registered } = makeCtx([]);
    setup(ctx);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.id).toBe("road-conditions-openconditions");
  });

  it("getEvents maps PostGIS rows to RoadConditionEvent[]", async () => {
    const { ctx, registered } = makeCtx([fakeRow]);
    setup(ctx);
    const events = await registered[0]!.getEvents([4.0, 51.0, 6.0, 53.0]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "evt-001",
      source: "ndw",
      provider: "",
      type: "accident",
      severity: "medium",
      headline: "Lane closure on A2",
      roadState: "some_lanes_closed",
      geometry: { type: "Point", coordinates: [5.0, 52.0] },
    });
    expect(events[0]!.roads).toEqual([{ name: "A2" }]);
    expect(events[0]!.attribution).toMatchObject({ provider: "NDW", license: "CC0-1.0" });
  });

  it("joins strictly published routing evidence onto its original observation", async () => {
    const evidence = {
      schema_version: 1 as const,
      observation_revision: "rev-1",
      binding_revision: "rev-1",
      graph_generation: "graph-1",
      resolver_version: "resolver-1",
      source_id: "ndw",
      child_source_id: null,
      source_license: "CC0-1.0",
      license_url: null,
      attribution: "NDW",
      record_url: null,
      source_checked_at: "2026-09-11T10:00:00.000Z",
      fresh_until: "2026-09-11T10:15:00.000Z",
      expires_at: null,
      valid_from: null,
      valid_to: null,
      next_transition_at: null,
      direction_mode: "both" as const,
      applicability: { kind: "all" as const },
      rights: {
        source_redistribution: "yes" as const,
        derived_redistribution: "yes" as const,
        commercial_use: "yes" as const,
        attribution_required: "yes" as const,
        retention: "yes" as const,
        evidence_origin: "registry",
        evidence_version: "1",
        reviewed_at: "2026-09-01T00:00:00.000Z",
      },
      segments: [
        { segment_id: "1:f", direction: "forward" as const, from_fraction: 0, to_fraction: 1 },
      ],
      binding_status: "exact" as const,
      reason_codes: [],
      evaluated_at: "2026-09-11T10:00:00.000Z",
    };
    const { ctx, registered } = makeCtx([fakeRow], {
      fetchByUrl: (url) =>
        url.endsWith("/segments/conditions.json")
          ? {
              schema_version: 1,
              complete: true,
              resolver_version: "resolver-1",
              conditions: [{ id: "evt-001", routing_evidence: evidence }],
            }
          : undefined,
    });
    setup(ctx);
    const events = await registered[0]!.getEvents([4, 51, 6, 53]);
    expect(events[0]?.routingEvidence).toEqual(evidence);
  });

  it("maps bounded operational status and graph evidence", async () => {
    const { ctx, registered } = makeCtx([], {
      fetchByUrl: (url) =>
        url.endsWith("/feeds/status")
          ? {
              schemaVersion: "2.0",
              instanceId: "oc-eu-1",
              collectedAt: "2026-09-11T10:00:00.000Z",
              graph: { generation: "graph-1", status: "ready", regions: ["de"] },
              feeds: [
                {
                  id: "de-child",
                  parentSourceId: "de-parent",
                  lastAttemptAt: "2026-09-11T09:59:00.000Z",
                  lastOutcome: "changed",
                  lastNetworkSuccessAt: "2026-09-11T09:59:00.000Z",
                  lastPublicationAt: "2026-09-11T09:59:30.000Z",
                  publicationRevision: 3,
                  freshnessDeadline: "2026-09-11T10:14:00.000Z",
                  freshnessWindowSec: 900,
                  cadenceSec: 300,
                  activeEvents: 8,
                  lastInserted: 2,
                  lastUpdated: 1,
                  lastDeleted: 1,
                  lastRejected: 4,
                  consecutiveFailures: 0,
                  binding: {
                    exact: 5,
                    likely: 1,
                    ambiguous: 1,
                    unresolved: 1,
                    noCoverage: 0,
                    unattempted: 0,
                    obsolete: 0,
                    notApplicable: 0,
                  },
                },
              ],
            }
          : undefined,
    });
    setup(ctx);
    const evidence = await registered[0]!.getOperationalEvidence!();
    expect(evidence).toMatchObject({ schemaVersion: 1, instanceId: "oc-eu-1", truncated: false });
    expect(evidence.feeds[0]).toMatchObject({
      sourceId: "de-child",
      parentSourceId: "de-parent",
      lastSuccessfulCheckAt: "2026-09-11T09:59:00.000Z",
      publicationRevision: "3",
      expectedIntervalSeconds: 300,
      activeEventCount: 8,
      changedCount: 4,
      rejectedCount: 4,
      graph: { generation: "graph-1", status: "ready", regions: ["de"] },
      bindingCounts: { exact: 5, likely: 1 },
    });
  });

  it("pushes excluded source identities into the database read before dedupe", async () => {
    let query = "";
    let params: unknown[] | undefined;
    const { ctx, registered } = makeCtx([], {
      capture: (q, p) => {
        query = q;
        params = p;
      },
    });
    setup(ctx);
    await registered[0]!.getEvents([4, 51, 6, 53], { excludedSourceIds: ["parent", "child"] });
    expect(query).toMatch(/o\.source <> ALL/);
    expect(query).toMatch(/parentSourceId/);
    expect(query).toMatch(/policyIds/);
    expect(params).toContainEqual(["parent", "child"]);
  });

  it("getEvents returns [] when no database is available", async () => {
    const { ctx, registered } = makeCtx([fakeRow], { noDb: true });
    setup(ctx);
    expect(await registered[0]!.getEvents([4, 51, 6, 53])).toEqual([]);
  });

  it("applies the type filter through observationsByBbox", async () => {
    let captured = "";
    const { ctx, registered } = makeCtx([], { capture: (q) => (captured = q) });
    setup(ctx);
    await registered[0]!.getEvents([4, 51, 6, 53], { types: ["accident"] });
    expect(captured).toMatch(/type = ANY/);
  });

  it("pushes horizonDays down into the SQL read, and omits it when unset", async () => {
    let captured = "";
    let capturedParams: unknown[] | undefined;
    const { ctx, registered } = makeCtx([], {
      capture: (q, p) => {
        captured = q;
        capturedParams = p;
      },
    });
    setup(ctx);
    await registered[0]!.getEvents([4, 51, 6, 53], { horizonDays: 7 });
    expect(captured).toMatch(/make_interval\(days =>/);
    expect(capturedParams).toContain(7);

    await registered[0]!.getEvents([4, 51, 6, 53]);
    expect(captured).not.toMatch(/make_interval\(days =>/);
  });

  it("carries the planned/forecast flags onto the mapped event", async () => {
    const planned = { ...fakeRow, is_forecast: true, attributes: { isPlanned: true } };
    const { ctx, registered } = makeCtx([planned]);
    setup(ctx);
    const events = await registered[0]!.getEvents([4, 51, 6, 53]);
    expect(events[0]).toMatchObject({ isForecast: true, isPlanned: true });
  });

  it("getFlow fetches /segments.geojson with the bbox as a comma-joined param and maps features (fallback url)", async () => {
    const fakeFc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [5, 52],
              [5.1, 52.1],
            ],
          },
          properties: {
            segment_id: "500:f",
            dir: "f",
            speed_ratio: 0.5,
            los: "heavy",
            confidence: "measured",
            current_kph: 50,
            free_flow_kph: 100,
          },
        },
      ],
    };
    let capturedUrl = "";
    let capturedParams: Record<string, unknown> | undefined;
    const { ctx, registered } = makeCtx([], {
      fetchFc: fakeFc,
      captureFetch: (url, options) => {
        capturedUrl = url;
        capturedParams = options?.params;
      },
    });
    setup(ctx);
    const segments = await registered[0]!.getFlow!([4, 51, 6, 53]);

    expect(capturedUrl).toBe("http://openconditions-ingest:4100/segments.geojson");
    expect(capturedParams).toEqual({ bbox: "4,51,6,53" });
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      id: "500:f",
      direction: "f",
      speedRatio: 0.5,
      los: "heavy",
      confidence: "measured",
      currentSpeedKph: 50,
      freeFlowSpeedKph: 100,
      source: "road-conditions-openconditions",
    });
  });

  it("getFlow targets the url from getRequiredService when the host has wired the ingest service", async () => {
    let capturedUrl = "";
    const { ctx, registered } = makeCtx([], {
      serviceUrl: "http://ingest.internal:9999",
      captureFetch: (url) => {
        capturedUrl = url;
      },
    });
    setup(ctx);
    await registered[0]!.getFlow!([4, 51, 6, 53]);
    expect(capturedUrl).toBe("http://ingest.internal:9999/segments.geojson");
  });

  it("getFlow maps a speed-less base feature to los:unknown, confidence:typical", async () => {
    const fakeFc = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [6, 53],
              [6.1, 53.1],
            ],
          },
          properties: { segment_id: "700:f", dir: "f" },
        },
      ],
    };
    const { ctx, registered } = makeCtx([], { fetchFc: fakeFc });
    setup(ctx);
    const segments = await registered[0]!.getFlow!([4, 51, 6, 53]);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ id: "700:f", los: "unknown", confidence: "typical" });
    expect(segments[0]!.speedRatio).toBeUndefined();
  });
});

describe("complete routing observations", () => {
  const complete = { schema_version: 1, complete: true, conditions: [] };
  it("preserves each source observation, including more than the display limit", async () => {
    let query = "";
    const rows = Array.from({ length: 2001 }, (_, i) => ({
      ...fakeRow,
      id: `evt-${i}`,
      source: `source-${i}`,
    }));
    const { ctx, registered } = makeCtx(rows, {
      fetchFc: complete,
      capture: (q) => {
        query = q;
      },
    });
    setup(ctx);
    const result = await registered[0]!.getRoutingEvents!([4, 51, 6, 53]);
    expect(result.complete).toBe(true);
    expect(result.events).toHaveLength(2001);
    expect(query).toContain("LIMIT 100001");
  });
  it("rejects overflow before returning a partial observation set", async () => {
    const { ctx, registered } = makeCtx(Array(100001).fill(fakeRow), { fetchFc: complete });
    setup(ctx);
    await expect(registered[0]!.getRoutingEvents!([4, 51, 6, 53])).rejects.toThrow(
      /complete|limit/i
    );
  });
  it("does not interpret unavailable storage or incomplete evidence as empty coverage", async () => {
    for (const options of [
      { noDb: true, fetchFc: complete },
      { fetchFc: { ...complete, complete: false } },
      { fetchFc: {} },
    ]) {
      const { ctx, registered } = makeCtx([], options);
      setup(ctx);
      await expect(registered[0]!.getRoutingEvents!([4, 51, 6, 53])).rejects.toThrow();
    }
  });
});

it("rejects lost or unrepresentable rows on the complete path", async () => {
  for (const rows of [null, [{ ...fakeRow, geojson: "null" }]]) {
    const { ctx, registered } = makeCtx(rows as never, {
      fetchFc: { schema_version: 1, complete: true, conditions: [] },
    });
    setup(ctx);
    await expect(registered[0]!.getRoutingEvents!([4, 51, 6, 53])).rejects.toThrow();
  }
});
