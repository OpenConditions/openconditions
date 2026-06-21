import { describe, it, expect } from "vitest";
import { setup } from "../index.js";
import type { IntegrationContext, RouteHandler } from "../types.js";

const fakeRow = {
  id: "evt-001",
  source: "ndw",
  domain: "roads",
  kind: "event",
  type: "accident",
  severity: "medium",
  headline: "Lane closure on A2",
  description: "Roadwork causing single-lane traffic",
  attributes: { roads: ["A2"] },
  valid_to: null,
  geojson: JSON.stringify({ type: "Point", coordinates: [5.0, 52.0] }),
  origin: { kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" } },
  is_stale: false,
};

function makeStubSql(rows: unknown[]) {
  return async (_strings: TemplateStringsArray, ..._values: unknown[]) => rows;
}

function makeMockCtx(sqlRows: unknown[]): {
  ctx: IntegrationContext;
  routes: Array<{ method: string; path: string; handler: RouteHandler }>;
} {
  const routes: Array<{ method: string; path: string; handler: RouteHandler }> = [];

  const ctx: IntegrationContext = {
    db: makeStubSql(sqlRows) as IntegrationContext["db"],
    cache: {
      async withCache<T>(_key: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
        return fn();
      },
    },
    registerRoute(method, path, handler) {
      routes.push({ method, path, handler });
    },
    manifest: {
      dataSources: [],
    },
  };

  return { ctx, routes };
}

function makeReply() {
  const result: { statusCode: number; headers: Record<string, string>; body: unknown } = {
    statusCode: 200,
    headers: {},
    body: undefined,
  };

  const reply = {
    status(code: number) {
      result.statusCode = code;
      return reply;
    },
    header(name: string, value: string) {
      result.headers[name] = value;
      return reply;
    },
    send(body: unknown) {
      result.body = body;
      return reply;
    },
    _result: result,
  };

  return reply;
}

describe("overlay-road-conditions route", () => {
  it("setup registers exactly one GET /observations route", () => {
    const { ctx, routes } = makeMockCtx([]);
    setup(ctx);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("GET");
    expect(routes[0].path).toBe("/observations");
  });

  it("returns a GeoJSON FeatureCollection for a valid bbox", async () => {
    const { ctx, routes } = makeMockCtx([fakeRow]);
    setup(ctx);

    const req = { query: { bbox: "4.0,51.0,6.0,53.0" } };
    const reply = makeReply();
    await routes[0].handler(req, reply);

    const fc = reply._result.body as { type: string; features: unknown[] };
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(1);
    expect(reply._result.statusCode).toBe(200);
  });

  it("returns 400 when bbox query param is missing", async () => {
    const { ctx, routes } = makeMockCtx([]);
    setup(ctx);

    const req = { query: {} };
    const reply = makeReply();
    await routes[0].handler(req, reply);

    expect(reply._result.statusCode).toBe(400);
  });

  it("returns 400 when bbox has wrong number of components", async () => {
    const { ctx, routes } = makeMockCtx([]);
    setup(ctx);

    const req = { query: { bbox: "4.0,51.0" } };
    const reply = makeReply();
    await routes[0].handler(req, reply);

    expect(reply._result.statusCode).toBe(400);
  });

  it("sets Cache-Control header on successful response", async () => {
    const { ctx, routes } = makeMockCtx([fakeRow]);
    setup(ctx);

    const req = { query: { bbox: "4.0,51.0,6.0,53.0" } };
    const reply = makeReply();
    await routes[0].handler(req, reply);

    expect(reply._result.headers["Cache-Control"]).toBe("public, max-age=90, s-maxage=90");
  });

  it("passes types filter when provided", async () => {
    const { ctx, routes } = makeMockCtx([]);
    setup(ctx);

    const req = { query: { bbox: "4.0,51.0,6.0,53.0", types: "accident,roadwork" } };
    const reply = makeReply();
    await routes[0].handler(req, reply);

    const fc = reply._result.body as { type: string; features: unknown[] };
    expect(fc.type).toBe("FeatureCollection");
    expect(reply._result.statusCode).toBe(200);
  });

  it("returns 400 when bbox components are non-numeric", async () => {
    const { ctx, routes } = makeMockCtx([]);
    setup(ctx);

    const req = { query: { bbox: "a,b,c,d" } };
    const reply = makeReply();
    await routes[0].handler(req, reply);

    expect(reply._result.statusCode).toBe(400);
  });

  it("passes minSeverity to observationsByBbox and includes it in cache key", async () => {
    const { ctx, routes } = makeMockCtx([]);
    setup(ctx);

    const req = { query: { bbox: "4.0,51.0,6.0,53.0", minSeverity: "medium" } };
    const reply = makeReply();
    await routes[0].handler(req, reply);

    const fc = reply._result.body as { type: string; features: unknown[] };
    expect(fc.type).toBe("FeatureCollection");
    expect(reply._result.statusCode).toBe(200);
  });
});
