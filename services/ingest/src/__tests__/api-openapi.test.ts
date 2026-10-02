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
});
