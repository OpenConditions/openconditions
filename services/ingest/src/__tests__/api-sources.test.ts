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
const NOTICE = "The data shown is the publisher's; it accepts no liability for its use.";
const noticed = testFeed({
  operator: "warn",
  qualifier: "severe-weather",
  name: "Warn severe weather",
  format: "cap",
  attribution: "Warn",
  terms: { notice: NOTICE, reviewedAt: "2026-10-08" },
});
const disabled = testFeed({
  operator: "gone",
  name: "Gone",
  disabled: { reason: "withdrawn", since: "2026-01-01" },
});

const catalog = {
  feeds: [active, flow, onDemand, child],
  sources: [active, flow, onDemand, parent, noticed, disabled],
  discovered: [discovered],
  disabled: [disabled],
  credentials: { groups: {} },
};

const crowd = {
  name: "OpenConditions contributors at maps.example.org",
  license: "ODbL-1.0",
  url: "https://maps.example.org/reports",
};

const app = Fastify();

beforeAll(async () => {
  registerScope(app, TOKEN);
  registerApiRoutes(app, {} as postgres.Sql, {
    registry: productionRegistry(),
    catalog,
    crowd,
  });
  await app.ready();
});

afterAll(() => app.close());

interface Body {
  generatedAt: string;
  scope: string;
  sources: Record<string, unknown>[];
  crowd?: Record<string, unknown>;
}

describe("GET /sources", () => {
  it("lists active and on-demand feeds by id, skipping disabled feeds and catalogue children", async () => {
    const res = await app.inject({ method: "GET", url: "/sources" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    const body = res.json() as Body;
    expect(Date.parse(body.generatedAt)).not.toBeNaN();
    expect(body.sources.map((s) => s["id"])).toEqual(
      [active.id, flow.id, onDemand.id, parent.id, noticed.id].sort(),
    );
  });

  it("serves sources' format, a qualifier where a feed has one, and the publisher's notice", async () => {
    const body = (await app.inject({ method: "GET", url: "/sources" })).json() as Body;
    const row = (id: string) => body.sources.find((s) => s["id"] === id);
    expect(row(noticed.id)).toMatchObject({
      format: "cap",
      qualifier: "severe-weather",
      notice: NOTICE,
      terms: { reviewedAt: "2026-10-08" },
    });
    expect(row(flow.id)).toMatchObject({ format: "datex2" });
    expect(row(flow.id)).not.toHaveProperty("qualifier");
    expect(row(flow.id)).not.toHaveProperty("notice");
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
      licensing: {
        version: 1,
        bindings: [
          {
            scope: "data",
            subject: "Alpha flow",
            license: { kind: "spdx", expression: "CC0-1.0" },
          },
        ],
      },
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

  it("credits the crowd beside the feeds, with its licence, link and rights", async () => {
    const body = (await app.inject({ method: "GET", url: "/sources" })).json() as Body;
    expect(body.sources.map((s) => s["id"])).not.toContain("crowd");
    expect(body.crowd).toEqual({
      id: "crowd",
      name: crowd.name,
      license: "ODbL-1.0",
      licensing: expect.objectContaining({
        bindings: [
          expect.objectContaining({
            scope: "data",
            subject: crowd.name,
            license: expect.objectContaining({ kind: "spdx", expression: "ODbL-1.0" }),
          }),
        ],
      }),
      url: crowd.url,
      rights: expect.objectContaining({ shareAlike: true, attributionRequired: true }),
      // The operator declares its own reports' licence: its grants are established.
      permissions: {
        display: "yes",
        redistribute: "yes",
        derive: "yes",
        retain: "yes",
        commercial: "yes",
      },
    });
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

describe("GET /sources of a feed whose credit names the year", () => {
  const dated = Fastify();
  const copernicus = testFeed({
    operator: "eumetsat",
    name: "Sentinel-3 fires",
    attribution: "Contains modified Copernicus Sentinel data {year}, processed by EUMETSAT",
  });

  beforeAll(async () => {
    registerScope(dated, undefined);
    registerApiRoutes(dated, {} as postgres.Sql, {
      registry: productionRegistry(),
      catalog: { sources: [copernicus] },
      now: () => new Date("2027-01-01T00:05:00Z"),
    });
    await dated.ready();
  });

  afterAll(() => dated.close());

  it("says the current UTC year", async () => {
    const body = (await dated.inject({ method: "GET", url: "/sources" })).json() as Body;
    expect(body.sources[0]?.["attribution"]).toBe(
      "Contains modified Copernicus Sentinel data 2027, processed by EUMETSAT",
    );
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

  it("states no crowd credit when none is configured", async () => {
    const body = (await open.inject({ method: "GET", url: "/sources" })).json() as Body;
    expect(body.crowd).toBeUndefined();
  });
});
