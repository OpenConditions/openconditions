import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogFeed } from "@openconditions/ingest-framework";
import { productionRegistry } from "@openconditions/model-registry";
import {
  ensureObservationPartitions,
  retentionClasses,
  syncSources,
} from "@openconditions/storage";
import Fastify, { type FastifyInstance } from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { repoFeed } from "./helpers/catalog.js";
import { fakeLookup } from "./helpers/on-demand.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

/**
 * The repo catalogue's on-demand fuel sources read through: Tankerkönig and
 * OpenStreetMap answer from the fuel package's fixtures (the Tankerkönig
 * documentation's Berlin example and an Overpass answer for the 0.1° cell
 * 13.4–13.5 E, 52.5–52.6 N), and a bbox read around the TotalEnergies
 * station on Margarete-Sommer-Straße links the two sources' stations into one.
 * Both sources are restricted: Tankerkönig's terms forbid passing the data on
 * to some, and OSM is share-alike.
 */

type Rec = Record<string, unknown>;

const NOW = new Date("2026-10-04T01:30:00.000Z");
const TOKEN = "operator-token-of-the-on-demand-fuel-suite-0123";
const FIXTURES = join(import.meta.dirname, "../../../../packages/fuel/src/__tests__/fixtures");
const BBOX = "13.438,52.528,13.443,52.533";
const READ = `/features?bbox=${BBOX}&kind=fuel_station&canonical=1&expand=components,latest`;

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;
let app: FastifyInstance;
const asked: { url: string; method: string; body: string }[] = [];

/** Tankerkönig and Overpass, answering from the fixtures. */
const upstream = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  asked.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
  const host = new URL(url).hostname;
  const name =
    host === "creativecommons.tankerkoenig.de"
      ? "tankerkoenig-list.json"
      : host === "overpass-api.de"
        ? "overpass-fuel.json"
        : undefined;
  if (name === undefined) return new Response("unknown upstream", { status: 404 });
  return new Response(readFileSync(join(FIXTURES, name)), {
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

let feeds: CatalogFeed[];

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(productionRegistry()),
    now: NOW,
  });
  feeds = [repoFeed("de-tankerkoenig-fuel"), repoFeed("osm-fuel")];
  await syncSources(
    sql,
    feeds.map((feed) => ({ ...feed })),
  );
  app = Fastify();
  registerScope(app, TOKEN);
  registerApiRoutes(app, sql, {
    registry: productionRegistry(),
    now: () => NOW,
    onDemand: {
      catalog: { feeds },
      fetch: upstream,
      lookup: fakeLookup,
      deadlineMs: 10_000,
      instanceId: "test.local",
      env: { DE_TANKERKOENIG_FUEL_API_KEY: "tk-test-key" },
    },
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
}, 30_000);

const read = async (operator: boolean) => {
  const res = await app.inject({
    method: "GET",
    url: READ,
    ...(operator ? { headers: { authorization: `Bearer ${TOKEN}` } } : {}),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Rec & { records: Rec[]; latest: Record<string, Rec[]>; coverage: Rec };
};

describe("on-demand fuel read-through", () => {
  test("an on-demand fuel read fetches Tankerkönig and OSM cells and returns linked canonical stations", async () => {
    const body = await read(true);

    expect(body.coverage).toEqual({
      partial: false,
      sources: [
        { id: "de-tankerkoenig-fuel", complete: true },
        { id: "osm-fuel", complete: true },
      ],
    });
    // One radius search around the 0.25° cell's centre, keyed; one Overpass
    // query of the 0.1° cell, posted with the public interpreter's default URL.
    const tk = asked.filter((a) => a.url.startsWith("https://creativecommons.tankerkoenig.de/"));
    expect(tk).toHaveLength(1);
    const search = new URL(tk[0]!.url);
    expect(Object.fromEntries(search.searchParams)).toEqual({
      lat: "52.625",
      lng: "13.375",
      rad: expect.any(String),
      sort: "dist",
      type: "all",
      apikey: "tk-test-key",
    });
    expect(Number(search.searchParams.get("rad"))).toBeLessThanOrEqual(25);
    const osm = asked.filter((a) => a.url === "https://overpass-api.de/api/interpreter");
    expect(osm).toHaveLength(1);
    expect(osm[0]!.method).toBe("POST");
    expect(osm[0]!.body).toContain('nwr["amenity"="fuel"](52.5,13.4,52.6,13.5);out center tags;');

    expect(body.records).toHaveLength(1);
    const [station] = body.records;
    const provenance = station!["provenance"] as Rec;
    const sources = [
      provenance["sourceId"],
      ...((provenance["mergedSources"] as Rec[]) ?? []).map((m) => m["source"]),
    ];
    expect(sources.sort()).toEqual(["de-tankerkoenig-fuel", "osm-fuel"]);

    // Tankerkönig's prices, fused into the canonical station's readings.
    const prices = body.latest[station!["id"] as string]!.filter(
      (r) => r["property"] === "fuel.price",
    );
    expect(prices.map((r) => (r["result"] as Rec)["amount"])).toEqual(["1.009", "1.009", "1.009"]);
    for (const price of prices) {
      const at = (price["phenomenonTime"] as { instant: string }).instant;
      expect(Date.parse(at)).toBe(NOW.getTime());
      expect([price["source"], ...((price["contributors"] as string[]) ?? [])]).toContain(
        "de-tankerkoenig-fuel",
      );
    }
    // OSM says which grades the station sells.
    const available = body.latest[station!["id"] as string]!.filter(
      (r) => r["property"] === "fuel.product_available",
    );
    expect(available.length).toBeGreaterThan(0);
  });

  test("the same read without the token returns no restricted fuel source", async () => {
    const before = asked.length;
    const body = await read(false);
    // The cells are fresh: nothing is fetched again.
    expect(asked).toHaveLength(before);
    expect(body.records).toEqual([]);
    expect(JSON.stringify({ records: body.records, latest: body.latest })).not.toMatch(
      /tankerkoenig|osm-fuel/,
    );
  });

  test("a public read fetches no restricted source, even one it names; the operator's does", async () => {
    // Cells no read has fetched yet.
    const elsewhere = "/features?bbox=13.71,52.71,13.72,52.72&kind=fuel_station";
    const get = async (url: string, operator: boolean) => {
      const res = await app.inject({
        method: "GET",
        url,
        ...(operator ? { headers: { authorization: `Bearer ${TOKEN}` } } : {}),
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as Rec;
    };
    const before = asked.length;
    const open = await get(elsewhere, false);
    const named = await get(`${elsewhere}&source=osm-fuel,de-tankerkoenig-fuel`, false);
    expect(asked).toHaveLength(before);
    // Neither source took part, so neither is named in the coverage.
    expect(open["coverage"]).toBeUndefined();
    expect(named["coverage"]).toBeUndefined();

    // Tankerkönig's one request a minute went to the first read.
    const operator = await get(elsewhere, true);
    expect(asked.slice(before).map((a) => new URL(a.url).hostname)).toEqual(["overpass-api.de"]);
    expect(operator["coverage"]).toEqual({
      partial: true,
      sources: [
        { id: "de-tankerkoenig-fuel", complete: false, reason: "limited" },
        { id: "osm-fuel", complete: true },
      ],
    });
  });
});
