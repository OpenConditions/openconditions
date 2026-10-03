import { describe, expect, it } from "vitest";
import { setup } from "../index.js";
import type { IntegrationContext, RoadConditionsProvider } from "../types.js";

type Rec = Record<string, unknown>;
type Params = Record<string, unknown> | undefined;

/** A situation record as `GET /situations` serves it. */
function situation(local: string, over: Rec = {}): Rec {
  return {
    id: `oc:situation:nl-ndw-events:${local}`,
    class: "situation",
    kind: "closure",
    type: "closure",
    subtype: "full",
    revision: 1,
    temporality: "live",
    planned: false,
    certainty: "observed",
    severity: { label: "major", source: "derived" },
    headline: [{ lang: "nl", text: "A2 dicht" }],
    validity: { status: "active", start: "2026-09-11T08:00:00Z" },
    effects: [
      {
        id: `${local}/closure`,
        kind: "closure",
        v: 1,
        scope: "road",
        applicability: { kind: "all" },
        compliance: "mandatory",
        normalization: "complete",
      },
    ],
    location: {
      geometry: { type: "Point", coordinates: [5.0, 52.0] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "exact",
      roads: [{ ref: "A2" }],
    },
    provenance: {
      origin: "feed",
      sourceId: "nl-ndw-events",
      attribution: { provider: "NDW", license: "CC0-1.0" },
    },
    freshness: { fetchedAt: "2026-09-11T10:00:00.000Z" },
    ...over,
  };
}

/** `/segments/conditions.json` v2 evidence of one effect of a record revision. */
function evidence(recordId: string, effectId: string, revision = 1): Rec {
  return {
    routing_evidence: {
      schema_version: 2,
      record_class: "situation",
      record_id: recordId,
      effect_id: effectId,
      record_revision: revision,
      binding_status: "exact",
    },
  };
}

/** An ingest serving `records` in pages of the requested size, and `conditions` as the evidence. */
function api(
  records: Rec[],
  conditions: unknown = { schema_version: 2, complete: true, conditions: [] },
) {
  return (url: string, params: Params): unknown => {
    if (url.endsWith("/segments/conditions.json")) return conditions;
    if (!url.endsWith("/situations")) return undefined;
    const limit = Number(params?.["limit"]);
    const start =
      params?.["cursor"] === undefined
        ? 0
        : records.findIndex((r) => r["id"] === params["cursor"]) + 1;
    const page = records.slice(start, start + limit);
    return { records: page, next: start + limit < records.length ? page.at(-1)!["id"] : null };
  };
}

function makeCtx(opts: {
  serve?: (url: string, params: Params) => unknown;
  capture?: (url: string, params: Params) => void;
  serviceUrl?: string;
}): { ctx: IntegrationContext; registered: RoadConditionsProvider[] } {
  const registered: RoadConditionsProvider[] = [];
  const ctx: IntegrationContext = {
    http: {
      async get<T = unknown>(url: string, options?: { params?: Params }): Promise<T> {
        opts.capture?.(url, options?.params);
        const body = opts.serve?.(url, options?.params);
        if (body instanceof Error) throw body;
        return (body ?? { type: "FeatureCollection", features: [] }) as T;
      },
    },
    cache: {
      async withCache<T>(_key: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
        return fn();
      },
    },
    getRequiredService(key) {
      return opts.serviceUrl ? { serviceId: key, url: opts.serviceUrl, enabled: true } : null;
    },
    registerRoadConditionsProvider(p) {
      registered.push(p);
    },
    manifest: { dataSources: [] },
  };
  return { ctx, registered };
}

function provider(opts: Parameters<typeof makeCtx>[0]): RoadConditionsProvider {
  const { ctx, registered } = makeCtx(opts);
  setup(ctx);
  return registered[0]!;
}

describe("road-conditions-openconditions provider", () => {
  it("setup registers exactly one provider with the expected id", () => {
    const { ctx, registered } = makeCtx({});
    setup(ctx);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.id).toBe("road-conditions-openconditions");
  });

  it("getEvents maps each situation of every page to one event", async () => {
    const records = Array.from({ length: 3 }, (_, i) => situation(`s${i}`));
    const events = await provider({ serve: api(records) }).getEvents([4, 51, 6, 53]);
    expect(events.map((e) => e.id)).toEqual(records.map((r) => r["id"]));
    expect(events[0]).toMatchObject({
      source: "nl-ndw-events",
      provider: "road-conditions-openconditions",
      kind: "closure",
      type: "closure",
      severity: { label: "major" },
      headline: [{ lang: "nl", text: "A2 dicht" }],
      effects: [{ kind: "closure", scope: "road" }],
    });
    // No condition row: the situation's effects are unbound, never left to raw geometry.
    expect(events[0]!.routingEvidence).toEqual({});
  });

  it("passes the query's filters to the record API and walks pages with the cursor", async () => {
    const calls: Params[] = [];
    const records = Array.from({ length: 1500 }, (_, i) =>
      situation(`s${String(i).padStart(4, "0")}`),
    );
    await provider({
      serve: api(records),
      capture: (url, params) => url.endsWith("/situations") && calls.push(params),
    }).getEvents([4, 51, 6, 53], {
      kinds: ["closure", "roadworks"],
      types: ["works"],
      minSeverity: "major",
      horizonDays: 7,
    });
    expect(calls).toEqual([
      {
        bbox: "4,51,6,53",
        limit: 1000,
        kind: "closure,roadworks",
        type: "works",
        minSeverity: "major",
        horizonDays: 7,
      },
      expect.objectContaining({ cursor: "oc:situation:nl-ndw-events:s0999" }),
    ]);
  });

  it("attaches evidence to a display read when it can, and keeps the situations when it cannot", async () => {
    const a = situation("a", { revision: 2 });
    const b = situation("b", { revision: 5 });
    const conditions = {
      schema_version: 2,
      complete: true,
      conditions: [
        evidence(String(a["id"]), "a/closure", 2),
        // b changed after the walk: its evidence is left out, not half-attached.
        evidence(String(b["id"]), "b/closure", 6),
      ],
    };
    const events = await provider({ serve: api([a, b], conditions) }).getEvents([4, 51, 6, 53]);
    expect(events.map((e) => e.routingEvidence && Object.keys(e.routingEvidence))).toEqual([
      ["a/closure"],
      [],
    ]);
    for (const broken of [
      new Error("503"),
      { schema_version: 1, complete: true, conditions: [] },
    ]) {
      const shown = await provider({ serve: api([a], broken) }).getEvents([4, 51, 6, 53]);
      // The evidence could not be read: no effect of the situation counts as bound.
      expect(shown.map((e) => [e.id, e.routingEvidence])).toEqual([[a["id"], {}]]);
    }
  });

  it("stops a display read after its cap", async () => {
    const records = Array.from({ length: 2500 }, (_, i) =>
      situation(`s${String(i).padStart(4, "0")}`),
    );
    expect(await provider({ serve: api(records) }).getEvents([4, 51, 6, 53])).toHaveLength(2000);
  });

  it("removes excluded sources and their catalogue children", async () => {
    const child = situation("c", {
      provenance: {
        origin: "feed",
        sourceId: "nl-child",
        attribution: { provider: "C", license: "CC0-1.0", parentSourceId: "nl-parent" },
      },
    });
    const events = await provider({ serve: api([situation("a"), child]) }).getEvents(
      [4, 51, 6, 53],
      { excludedSourceIds: ["nl-parent"] },
    );
    expect(events.map((e) => e.id)).toEqual(["oc:situation:nl-ndw-events:a"]);
  });

  it("maps bounded operational status and graph evidence", async () => {
    const p = provider({
      serve: (url) =>
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
    const evidenceOut = await p.getOperationalEvidence!();
    expect(evidenceOut).toMatchObject({
      schemaVersion: 1,
      instanceId: "oc-eu-1",
      truncated: false,
    });
    expect(evidenceOut.feeds[0]).toMatchObject({
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
    let capturedParams: Params;
    const segments = await provider({
      serve: () => fakeFc,
      capture: (url, params) => {
        capturedUrl = url;
        capturedParams = params;
      },
    }).getFlow!([4, 51, 6, 53]);

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

  it("targets the url from getRequiredService when the host has wired the ingest service", async () => {
    let capturedUrl = "";
    await provider({
      serviceUrl: "http://ingest.internal:9999",
      capture: (url) => {
        capturedUrl = url;
      },
    }).getFlow!([4, 51, 6, 53]);
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
    const segments = await provider({ serve: () => fakeFc }).getFlow!([4, 51, 6, 53]);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ id: "700:f", los: "unknown", confidence: "typical" });
    expect(segments[0]!.speedRatio).toBeUndefined();
  });
});

describe("complete routing reads", () => {
  it("reads every page, past the display cap, unfiltered", async () => {
    const calls: Params[] = [];
    const records = Array.from({ length: 6001 }, (_, i) =>
      situation(`s${String(i).padStart(5, "0")}`),
    );
    const result = await provider({
      serve: api(records),
      capture: (url, params) => url.endsWith("/situations") && calls.push(params),
    }).getRoutingEvents!([4, 51, 6, 53]);
    expect(result).toMatchObject({ complete: true });
    expect(result.events).toHaveLength(6001);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ bbox: "4,51,6,53", limit: 5000 });
  });

  it("attaches each effect's evidence to its situation", async () => {
    const a = situation("a", { revision: 3 });
    const conditions = {
      schema_version: 2,
      complete: true,
      conditions: [evidence(String(a["id"]), "a/closure", 3)],
    };
    const { events } = await provider({ serve: api([a], conditions) }).getRoutingEvents!([
      4, 51, 6, 53,
    ]);
    expect(events[0]!.routingEvidence).toEqual({
      "a/closure": expect.objectContaining({ record_revision: 3, binding_status: "exact" }),
    });
  });

  it("fails rather than route on evidence of a revision it did not read", async () => {
    const a = situation("a", { revision: 3 });
    const conditions = {
      schema_version: 2,
      complete: true,
      conditions: [evidence(String(a["id"]), "a/closure", 4)],
    };
    await expect(
      provider({ serve: api([a], conditions) }).getRoutingEvents!([4, 51, 6, 53]),
    ).rejects.toThrow(/changed during routing read/);
  });

  it("leaves out evidence of a situation the walk did not return", async () => {
    const conditions = {
      schema_version: 2,
      complete: true,
      conditions: [evidence("oc:situation:nl-ndw-events:elsewhere", "x/closure")],
    };
    const { events } = await provider({ serve: api([situation("a")], conditions) })
      .getRoutingEvents!([4, 51, 6, 53]);
    expect(events.map((e) => e.routingEvidence)).toEqual([{}]);
  });

  it("does not read a failed page, a malformed page or incomplete evidence as empty coverage", async () => {
    const records = [situation("a")];
    for (const serve of [
      (url: string, params: Params) =>
        url.endsWith("/situations") ? new Error("503") : api(records)(url, params),
      (url: string, params: Params) =>
        url.endsWith("/situations") ? { records: "nope" } : api(records)(url, params),
      api(records, { schema_version: 2, complete: false, conditions: [] }),
      api(records, { schema_version: 1, complete: true, conditions: [] }),
      api(records, {}),
    ]) {
      await expect(provider({ serve }).getRoutingEvents!([4, 51, 6, 53])).rejects.toThrow();
    }
  });
});
