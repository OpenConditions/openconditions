import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ChargingCatalogFeed, chargingDomain } from "@openconditions/charging";
import type { ImpersonationClient } from "@openconditions/ingest-framework";
import { productionRegistry } from "@openconditions/model-registry";
import {
  ensureObservationPartitions,
  retentionClasses,
  syncSources,
  writeSnapshot,
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
 * OpenStreetMap's and Open Charge Map's charging stations read through on
 * demand, and charging sites linked across sources through the tables.
 * Overpass answers from the charging package's fixture (central Karlsruhe,
 * the 0.1° cell 8.4–8.5 E, 49.0–49.1 N); Open Charge Map, behind its
 * impersonating fetch, from its fixture of five records worldwide, one in the
 * 0.25° cell 6.0–6.25 E, 49.5–49.75 N; the charge-point database and NDW come
 * from the OCPI package's fixtures. OSM is share-alike and Open Charge Map
 * mixes its providers' licences, so their sites are the operator's only.
 */

type Rec = Record<string, unknown>;

const NOW = new Date("2026-10-06T03:00:00.000Z");
const TOKEN = "operator-token-of-the-on-demand-charging-suite-1";
const FIXTURES = join(import.meta.dirname, "../../../../packages/charging/src/__tests__/fixtures");
// Around Stadtwerke Karlsruhe's charge point at the Kaiserstraße, node 4793460914.
const BBOX = "8.410,49.008,8.412,49.009";
const READ = `/features?bbox=${BBOX}&kind=charging_site&canonical=1`;

const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const ocpiFixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "../../../../packages/ocpi/src/__tests__/fixtures", name));

// The feeds as the catalogue ships them, so a catalogue change is tested here too.
const osmCharging = repoFeed("osm-charging");
const ocmCharging = repoFeed("ocm-charging");
/** The charge-point database. */
const ocpdb = repoFeed("de-bw-mobidata-charging");
/** NDW's OCPI locations. */
const ndw = repoFeed("nl-ndw-charging");

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;
let app: FastifyInstance;
const asked: { url: string; method: string; body: string }[] = [];

/** Overpass, answering every cell from the fixture. */
const upstream = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  asked.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
  if (new URL(url).hostname !== "overpass-api.de") {
    return new Response("unknown upstream", { status: 404 });
  }
  return new Response(fixture("overpass-charging.json"), {
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
  await ensureObservationPartitions(sql, {
    classes: retentionClasses(productionRegistry()),
    now: NOW,
  });
  await syncSources(sql, [{ ...osmCharging }, { ...ocmCharging }, { ...ocpdb }, { ...ndw }]);
  app = Fastify();
  registerScope(app, TOKEN);
  registerApiRoutes(app, sql, {
    registry: productionRegistry(),
    now: () => NOW,
    onDemand: {
      catalog: { feeds: [osmCharging] },
      fetch: upstream,
      lookup: fakeLookup,
      deadlineMs: 10_000,
      instanceId: "test.local",
      env: {},
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
  return res.json() as Rec & { records: Rec[]; coverage?: Rec };
};

const wctx = {
  registry: productionRegistry(),
  instanceId: "test.local",
  now: NOW.toISOString(),
  complete: true,
};
const ctx = { fetchedAt: NOW.toISOString(), cadenceSec: 300, reference: {} };

const canonicalOf = async (featureId: string) => {
  const [row] = await sql<{ canonical_feature_id: string; member_ids: string[] }[]>`
    SELECT canonical_feature_id, member_ids
      FROM conditions.feature_canonical WHERE ${featureId} = ANY(member_ids)`;
  return row!;
};

/** `[lon, lat]` moved north by `metres`. */
const north = ([lon, lat]: number[], metres: number): [number, number] => [
  lon!,
  lat! + metres / 111_320,
];

const pointOf = (feature: Rec) =>
  (feature["location"] as { geometry: { coordinates: number[] } }).geometry.coordinates;

describe("on-demand charging", () => {
  test("an on-demand charging read returns OSM sites only to the operator", async () => {
    const body = await read(true);
    expect(body.coverage).toEqual({
      partial: false,
      sources: [{ id: "osm-charging", complete: true }],
    });
    const osm = asked.filter((a) => a.url === "https://overpass-api.de/api/interpreter");
    expect(osm).toHaveLength(1);
    expect(osm[0]!.method).toBe("POST");
    expect(osm[0]!.body).toContain('nwr["amenity"="charging_station"](49,8.4,49.1,8.5);');

    expect(body.records).toHaveLength(1);
    const [site] = body.records;
    expect((site!["provenance"] as Rec)["sourceId"]).toBe("osm-charging");
    expect(site!["operator"]).toMatchObject({
      name: [{ lang: "und", text: "Stadtwerke Karlsruhe GmbH" }],
    });

    // The cell is fresh, so the public read fetches nothing, and it is given no OSM site.
    const before = asked.length;
    const open = await read(false);
    expect(asked).toHaveLength(before);
    expect(open.records).toEqual([]);
    expect(JSON.stringify(open)).not.toMatch(/osm-charging/);
  });

  test("an OCPDB site and the OSM station 30 m away are one canonical site; two NDW locations 25 m apart are not", async () => {
    const parsed = chargingDomain.formats["ocpi"]!.parse(
      ocpdb as ChargingCatalogFeed,
      { main: [ocpiFixture("ocpdb-locations.json")] },
      ctx,
    );
    const wangen = parsed.features.find(
      (f) => f["id"] === "oc:feature:de-bw-mobidata-charging:308744",
    )!;
    const written = await writeSnapshot(
      sql,
      "de-bw-mobidata-charging",
      { features: parsed.features, observations: parsed.observations },
      wctx,
    );
    expect(written.rejected).toEqual([]);

    // The station as OpenStreetMap maps it, 30 m north, under the operator's name.
    const [lon, lat] = north(pointOf(wangen), 30);
    const element = {
      elements: [
        {
          type: "node",
          id: 99,
          lat,
          lon,
          tags: { amenity: "charging_station", operator: "ENBW", "socket:type2_combo": "4" },
        },
      ],
    };
    const osm = chargingDomain.formats["overpass"]!.parse(
      osmCharging as ChargingCatalogFeed,
      { main: [Buffer.from(JSON.stringify(element))] },
      ctx,
    );
    const osmWritten = await writeSnapshot(
      sql,
      "osm-charging",
      { features: osm.features },
      { ...wctx, complete: false },
    );
    expect(osmWritten.rejected).toEqual([]);
    expect((await canonicalOf(wangen["id"] as string)).member_ids.sort()).toEqual([
      "oc:feature:de-bw-mobidata-charging:308744",
      "oc:feature:osm-charging:node/99",
    ]);

    // Two locations of one NDW party 25 m apart: past the 15 m a source's own
    // locations are one site within, and one source never says twice that one
    // site exists, so they stay two.
    const locations = JSON.parse(ocpiFixture("ndw-locations.json").toString("utf8")) as Rec[];
    const qwc = locations.find((l) => l["party_id"] === "QWC")!;
    const coordinates = qwc["coordinates"] as { latitude: string; longitude: string };
    const neighbour = {
      ...qwc,
      id: "qwc-neighbour",
      coordinates: {
        latitude: String(Number(coordinates.latitude) + 25 / 111_320),
        longitude: coordinates.longitude,
      },
    };
    const ndwParsed = chargingDomain.formats["ocpi"]!.parse(
      ndw as ChargingCatalogFeed,
      { main: [Buffer.from(JSON.stringify([qwc, neighbour]))] },
      ctx,
    );
    expect(ndwParsed.features).toHaveLength(2);
    const ndwWritten = await writeSnapshot(
      sql,
      "nl-ndw-charging",
      { features: ndwParsed.features, observations: ndwParsed.observations },
      wctx,
    );
    expect(ndwWritten.rejected).toEqual([]);
    const first = await canonicalOf(`oc:feature:nl-ndw-charging:NL*QWC*${qwc["id"]}`);
    const second = await canonicalOf("oc:feature:nl-ndw-charging:NL*QWC*qwc-neighbour");
    expect(first.member_ids).toHaveLength(1);
    expect(second.canonical_feature_id).not.toBe(first.canonical_feature_id);
  });

  test("an OCM cell read fills a cell once and serves the operator only", async () => {
    // Open Charge Map answers through the impersonating client, never plain fetch.
    const impersonated: { url: string; headers: Record<string, string> }[] = [];
    const client: ImpersonationClient = {
      fetch: async (resource, init) => {
        impersonated.push({ url: resource, headers: init?.headers ?? {} });
        return {
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          body: new Response(fixture("ocm.json")).body,
        };
      },
    };
    const plain: string[] = [];
    const ocmApp = Fastify();
    registerScope(ocmApp, TOKEN);
    registerApiRoutes(ocmApp, sql, {
      registry: productionRegistry(),
      now: () => NOW,
      onDemand: {
        catalog: { feeds: [ocmCharging] },
        fetch: (async (input: string | URL | Request) => {
          plain.push(input instanceof Request ? input.url : String(input));
          return new Response("unexpected", { status: 500 });
        }) as typeof fetch,
        lookup: fakeLookup,
        impersonation: { client, lookup: fakeLookup },
        deadlineMs: 10_000,
        instanceId: "test.local",
        env: { OCM_CHARGING_API_KEY: "ocm-test-key" },
      },
    });
    await ocmApp.ready();
    try {
      // Around Rue de Neudorf, Scheidhof: the 0.25° cell 6.0–6.25 E, 49.5–49.75 N.
      const readLuxembourg = async (operator: boolean) => {
        const res = await ocmApp.inject({
          method: "GET",
          url: "/features?bbox=6.18,49.61,6.20,49.63&kind=charging_site&canonical=1",
          ...(operator ? { headers: { authorization: `Bearer ${TOKEN}` } } : {}),
        });
        expect(res.statusCode, res.body).toBe(200);
        return res.json() as Rec & { records: Rec[]; coverage?: Rec };
      };

      const body = await readLuxembourg(true);
      expect(body.coverage).toEqual({
        partial: false,
        sources: [{ id: "ocm-charging", complete: true }],
      });
      expect(plain).toEqual([]);
      expect(impersonated).toHaveLength(1);
      expect(impersonated[0]!.url).toBe(
        "https://api.openchargemap.io/v3/poi/?output=json&boundingbox=(49.5,6),(49.75,6.25)&maxresults=1000&compact=false&verbose=false",
      );
      const key = Object.entries(impersonated[0]!.headers).find(
        ([name]) => name.toLowerCase() === "x-api-key",
      );
      expect(key?.[1]).toBe("ocm-test-key");

      // Four of the five records lie outside the cell; the one inside credits its provider.
      expect(body.records).toHaveLength(1);
      const [site] = body.records;
      expect(site!["provenance"]).toMatchObject({
        sourceId: "ocm-charging",
        accessMode: "on_demand",
        upstream: [
          {
            publisher: "Oplaadpalen.nl",
            license:
              "Licensed under Attribution-NonCommercial-ShareAlike 3.0 : http://creativecommons.org/licenses/by-nc-sa/3.0/",
          },
        ],
      });

      // The cell is fresh: a second read fetches nothing, and the public is given nothing.
      await readLuxembourg(true);
      expect(impersonated).toHaveLength(1);
      const open = await readLuxembourg(false);
      expect(impersonated).toHaveLength(1);
      expect(open.records).toEqual([]);
      expect(JSON.stringify(open)).not.toMatch(/ocm-charging/);
    } finally {
      await ocmApp.close();
    }
  });
});
