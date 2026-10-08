import { productionRegistry } from "@openconditions/model-registry";
import Fastify from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { testFeed } from "./helpers/catalog.js";

const TOKEN = "t".repeat(32);

const active = testFeed({ operator: "zeta", name: "Zeta events", attribution: "Zeta" });
const flow = testFeed({
  operator: "alpha",
  product: "flow",
  name: "Alpha flow",
  attribution: "Alpha",
  terms: { note: "licence says no", redistribution: false, reviewedAt: "2026-09-01" },
});
const onDemand = testFeed({
  operator: "mid",
  name: "Mid on demand",
  accessMode: "on_demand",
  endpoints: { main: { url: "https://cells.example/q?lat={south}", cadenceSec: 60 } },
  coverage: { bbox: [5.7, 49.4, 6.6, 50.2] },
});
const parent = testFeed({
  operator: "parent",
  name: "Parent catalogue",
  attribution: "Parent",
});
const child = testFeed({
  operator: "parent",
  qualifier: "child",
  name: "Child",
  parentSourceId: parent.id,
  selectionState: "approved",
});
const discovered = testFeed({
  operator: "parent",
  qualifier: "found",
  name: "Found",
  parentSourceId: parent.id,
  selectionState: "discovered",
});
const disabled = testFeed({
  operator: "gone",
  name: "Gone",
  disabled: { reason: "withdrawn", since: "2026-01-01" },
});

const catalog = {
  feeds: [active, flow, onDemand, child],
  sources: [active, flow, onDemand, parent, disabled],
  discovered: [discovered],
  disabled: [disabled],
  credentials: { groups: {} },
};

const app = Fastify();

beforeAll(async () => {
  registerScope(app, TOKEN);
  registerApiRoutes(app, {} as postgres.Sql, { registry: productionRegistry(), catalog });
  await app.ready();
});

afterAll(() => app.close());

interface Body {
  generatedAt: string;
  scope: string;
  sources: Record<string, unknown>[];
}

describe("GET /sources", () => {
  it("lists active and on-demand feeds by id, skipping disabled feeds and catalogue children", async () => {
    const res = await app.inject({ method: "GET", url: "/sources" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    const body = res.json() as Body;
    expect(Date.parse(body.generatedAt)).not.toBeNaN();
    expect(body.sources.map((s) => s["id"])).toEqual(
      [active.id, flow.id, onDemand.id, parent.id].sort(),
    );
  });

  it("carries the credit and rights fields", async () => {
    const body = (await app.inject({ method: "GET", url: "/sources" })).json() as Body;
    const row = body.sources.find((s) => s["id"] === flow.id);
    expect(row).toMatchObject({
      id: flow.id,
      name: "Alpha flow",
      domain: "roads",
      product: "flow",
      operator: "alpha",
      region: "lu",
      country: "LU",
      accessMode: flow.accessMode ?? "bulk",
      restricted: true,
      license: "CC0-1.0",
      licenseName: "Creative Commons Zero 1.0",
      attribution: "Alpha",
      homepage: "https://example.test",
      privacyUrl: "https://example.test/privacy",
      terms: { reviewedAt: "2026-09-01", note: "licence says no" },
      rights: { redistribution: false },
    });
  });

  it("carries each feed's coverage: its countries, or the box an on-demand feed answers for", async () => {
    const body = (await app.inject({ method: "GET", url: "/sources" })).json() as Body;
    const coverage = Object.fromEntries(body.sources.map((s) => [s["id"], s["coverage"]]));
    expect(coverage[flow.id]).toEqual({ countries: ["LU"] });
    expect(coverage[onDemand.id]).toEqual({ bbox: [5.7, 49.4, 6.6, 50.2] });
  });

  it("marks only restricted feeds restricted", async () => {
    const body = (await app.inject({ method: "GET", url: "/sources" })).json() as Body;
    const restricted = Object.fromEntries(body.sources.map((s) => [s["id"], s["restricted"]]));
    expect(restricted[flow.id]).toBe(true);
    expect(restricted[active.id]).toBe(false);
  });

  it("is the same list for the operator", async () => {
    const anonymous = (await app.inject({ method: "GET", url: "/sources" })).json() as Body;
    const operator = (
      await app.inject({
        method: "GET",
        url: "/sources",
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json() as Body;
    expect(operator.sources).toEqual(anonymous.sources);
  });

  it("names the scope it was served in, and varies on the bearer", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/sources" });
    expect((anonymous.json() as Body).scope).toBe("public");
    expect(anonymous.headers["vary"]).toContain("Authorization");
    expect(anonymous.headers["cache-control"]).toBe("public, max-age=300");
    const operator = await app.inject({
      method: "GET",
      url: "/sources",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect((operator.json() as Body).scope).toBe("operator");
    expect(operator.headers["vary"]).toContain("Authorization");
    expect(operator.headers["cache-control"]).toBe("private, no-store");
  });
});

describe("GET /sources without an operator token configured", () => {
  const open = Fastify();

  beforeAll(async () => {
    registerScope(open, undefined);
    registerApiRoutes(open, {} as postgres.Sql, { registry: productionRegistry(), catalog });
    await open.ready();
  });

  afterAll(() => open.close());

  it("serves a bearer request in public scope", async () => {
    const res = await open.inject({
      method: "GET",
      url: "/sources",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Body).scope).toBe("public");
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
  });
});
