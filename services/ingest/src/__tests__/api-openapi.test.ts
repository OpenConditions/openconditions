import { readFileSync, writeFileSync } from "node:fs";
import { productionRegistry } from "@openconditions/model-registry";
import Fastify from "fastify";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { API_ROUTES, openApiDocument } from "../api/openapi.js";
import { registerApiRoutes } from "../api/routes.js";

const CHECKED_IN = new URL("../../openapi.json", import.meta.url);

describe("the OpenAPI document", () => {
  it("matches the checked-in copy (UPDATE_OPENAPI=1 rewrites it, never under CI)", () => {
    const generated = `${JSON.stringify(openApiDocument(), null, 2)}\n`;
    if (process.env["UPDATE_OPENAPI"] === "1") {
      if (process.env["CI"]) throw new Error("UPDATE_OPENAPI is refused under CI");
      writeFileSync(CHECKED_IN, generated);
    }
    expect(JSON.parse(generated)).toEqual(JSON.parse(readFileSync(CHECKED_IN, "utf8")));
  });

  it("documents exactly the routes the record API registers", async () => {
    const app = Fastify();
    registerApiRoutes(app, {} as postgres.Sql, { registry: productionRegistry() });
    await app.ready();
    for (const route of API_ROUTES) {
      const url = route.path.replace("{path}", "*").replace(/\{(\w+)\}/g, ":$1");
      expect(app.hasRoute({ method: "GET", url }), route.path).toBe(true);
    }
    await app.close();
  });

  it("leaves out no route the record API registers", async () => {
    const app = Fastify();
    const registered: string[] = [];
    app.addHook("onRoute", (route) => {
      if (route.method === "GET" || (Array.isArray(route.method) && route.method.includes("GET"))) {
        registered.push(route.url);
      }
    });
    registerApiRoutes(app, {} as postgres.Sql, { registry: productionRegistry() });
    await app.ready();
    const documented = API_ROUTES.map((r) =>
      r.path.replace("{path}", "*").replace(/\{(\w+)\}/g, ":$1"),
    );
    expect([...new Set(registered)].sort()).toEqual([...documented].sort());
    await app.close();
  });

  it("describes the feature, offer and observation routes with their own filters", () => {
    const doc = openApiDocument();
    const names = (path: string) =>
      (
        doc.paths[path] as { get: { parameters: { name: string }[] } } | undefined
      )?.get.parameters.map((p) => p.name);
    expect(names("/features")).toEqual(
      expect.arrayContaining(["bbox", "kind", "canonical", "expand", "cursor", "limit"]),
    );
    expect(names("/observations/latest")).toEqual(
      expect.arrayContaining(["property", "canonical", "cursor"]),
    );
    expect(names("/observations")).toEqual(
      expect.arrayContaining(["subject", "property", "qualifiers", "from", "to", "resolution"]),
    );
    expect(names("/features/{id}")).toEqual(["id", "at", "expand"]);
    expect(names("/offers/{id}")).toEqual(["id"]);
  });

  it("names the terms fields /sources serves, the note included", () => {
    const doc = openApiDocument();
    const { summary } = (doc.paths["/sources"] as { get: { summary: string } }).get;
    expect(summary).toMatch(/terms \(url, review date and note\)/);
  });

  it("says which collections read on-demand sources through and report their coverage", () => {
    const doc = openApiDocument();
    const summary = (path: string) => (doc.paths[path] as { get: { summary: string } }).get.summary;
    for (const path of ["/features", "/offers", "/observations/latest"]) {
      expect(summary(path), path).toMatch(/on-demand.*`coverage: /s);
    }
    for (const path of ["/features.geojson", "/features.jsonld", "/situations"]) {
      expect(summary(path), path).not.toMatch(/on-demand/);
    }
  });

  it("describes every query parameter of a collection, with the page limit's bounds", () => {
    const doc = openApiDocument();
    const params = (
      doc.paths["/situations"] as { get: { parameters: { name: string; schema: unknown }[] } }
    ).get.parameters;
    expect(params.map((p) => p.name)).toEqual(
      expect.arrayContaining(["bbox", "kind", "minSeverity", "at", "cursor", "limit", "dedupe"]),
    );
    expect(params.find((p) => p.name === "limit")?.schema).toMatchObject({
      minimum: 1,
      maximum: 5000,
      default: 500,
    });
  });

  it("says the dedupe fold stops at a page boundary", () => {
    const doc = openApiDocument();
    const params = (
      doc.paths["/situations"] as { get: { parameters: { name: string; description?: string }[] } }
    ).get.parameters;
    expect(params.find((p) => p.name === "dedupe")?.description).toMatch(/within one page/);
  });

  it("offers the operator bearer token on every route but the public emitters, and its 401", () => {
    const doc = openApiDocument();
    expect(doc.components.securitySchemes.operatorToken).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    const op = (path: string) =>
      (
        doc.paths[path] as {
          get: { security: Record<string, string[]>[]; responses: Record<string, unknown> };
        }
      ).get;
    const emitters = [
      "/situations.geojson",
      "/situations.jsonld",
      "/traff.xml",
      "/datex2/situations.xml",
      "/stream",
      "/features.geojson",
      "/features.jsonld",
    ];
    for (const route of API_ROUTES) {
      const { security, responses } = op(route.path);
      expect(responses["401"], route.path).toBeDefined();
      expect(security, route.path).toEqual(
        emitters.includes(route.path) ? [{}] : [{}, { operatorToken: [] }],
      );
    }
  });

  it("documents the rate limit's 429 on every route and the stream cap's 503", () => {
    const doc = openApiDocument();
    const responses = (path: string) =>
      (doc.paths[path] as { get: { responses: Record<string, unknown> } }).get.responses;
    for (const route of API_ROUTES) expect(responses(route.path)["429"], route.path).toBeDefined();
    expect(responses("/stream")["503"]).toBeDefined();
    expect(responses("/situations")["503"]).toBeUndefined();
  });

  it("says a single record past its expiry answers 404, and when /features/{id} refetches", () => {
    const doc = openApiDocument();
    const summary = (path: string) => (doc.paths[path] as { get: { summary: string } }).get.summary;
    for (const path of ["/situations/{id}", "/features/{id}", "/offers/{id}"]) {
      expect(summary(path), path).toMatch(/past its `freshness\.expiresAt`.*404/s);
    }
    expect(summary("/features/{id}")).toMatch(/expired on-demand/);
  });

  it("says /sources names the scope it was served in, and the coverage is scoped", () => {
    const doc = openApiDocument();
    const summary = (path: string) => (doc.paths[path] as { get: { summary: string } }).get.summary;
    expect(summary("/sources")).toMatch(/`scope`/);
    expect(summary("/coverage")).toMatch(/restricted/);
  });
});
