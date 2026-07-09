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
        return (opts?.fetchFc ?? { type: "FeatureCollection", features: [] }) as T;
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
