import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CatalogFeed,
  type FeedDefinition,
  toCatalogFeed,
} from "@openconditions/ingest-framework";
import { productionRegistry } from "@openconditions/model-registry";
import { type ParkingCatalogFeed, parkingDomain } from "@openconditions/parking";
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
import { fakeLookup } from "./helpers/on-demand.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

/**
 * OpenStreetMap's car parks read through on demand, and parking sites linked
 * across sources through the tables. Overpass answers from the parking
 * package's fixture (the 0.05° cell 8.40–8.45 E, 49.00–49.05 N of central
 * Karlsruhe); MobiData BW's ParkAPI sites come from its fixture. OSM is
 * share-alike, so its sites are the operator's only.
 */

type Rec = Record<string, unknown>;

const NOW = new Date("2026-10-05T04:00:00.000Z");
const TOKEN = "operator-token-of-the-on-demand-parking-suite-01";
const FIXTURES = join(import.meta.dirname, "../../../../packages/parking/src/__tests__/fixtures");
const BBOX = "8.401,49.008,8.403,49.010";
const READ = `/features?bbox=${BBOX}&kind=parking_site&canonical=1`;

const fixture = (name: string) => readFileSync(join(FIXTURES, name));

const loaded = (region: string, definition: Record<string, unknown>): CatalogFeed =>
  toCatalogFeed(definition as unknown as FeedDefinition, {
    domain: "parking",
    region,
    file: `feeds/parking/${region}.jsonc`,
    maintainers: [],
  });

/** `osm-parking` as the parking region file writes it. */
const osmParking = loaded("global", {
  operator: "osm",
  product: "parking",
  name: "OpenStreetMap parking",
  homepage: "https://www.openstreetmap.org/copyright",
  tier: "authoritative",
  format: "overpass",
  endpoints: {
    main: {
      url: "https://overpass-api.de/api/interpreter",
      method: "POST",
      body: 'data=[out:json][timeout:25];nwr["amenity"="parking"]({south},{west},{north},{east});out center tags;',
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      cadenceSec: 3600,
    },
  },
  freshnessWindowSec: 86400,
  accessMode: "on_demand",
  onDemand: { cellDeg: 0.05, ttlSec: 21600, maxCellsPerRead: 16, probe: [8.4, 49.01] },
  requestLimits: { perMinute: 30, perDay: 5000 },
  coverage: { bbox: [-180, -90, 180, 90] },
  license: "ODbL-1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
  attribution: "© OpenStreetMap contributors",
  privacyUrl: "https://osmfoundation.org/wiki/Privacy_Policy",
});

/** `de-bw-mobidata-parking` as the parking region file writes it. */
const mobidata = loaded("de", {
  subdivision: "bw",
  operator: "mobidata",
  product: "parking",
  name: "MobiData BW ParkAPI car parking sites",
  tier: "aggregator",
  format: "parkapi-v3",
  endpoints: {
    main: {
      url: "https://api.mobidata-bw.de/park-api/api/public/v3/parking-sites?purpose=CAR",
      cadenceSec: 300,
    },
    sources: {
      url: "https://api.mobidata-bw.de/park-api/api/public/v3/sources",
      cadenceSec: 86400,
    },
  },
  freshnessWindowSec: 3600,
  license: "DL-DE-BY-2.0",
  licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
  attribution: "MobiData BW, Datenlizenz Deutschland – Namensnennung – Version 2.0",
  privacyUrl: "https://mobidata-bw.de/pages/datenschutz",
});

/** `sg-hdb-parking` as the parking region file writes it. */
const hdb = loaded("sg", {
  operator: "hdb",
  product: "parking",
  name: "HDB car parks",
  tier: "authoritative",
  format: "hdb",
  endpoints: {
    sites: { url: "https://data.gov.sg/api/action/datastore_search", cadenceSec: 86400 },
    status: { url: "https://api.data.gov.sg/v1/transport/carpark-availability", cadenceSec: 300 },
  },
  freshnessWindowSec: 3600,
  license: "LicenseRef-Singapore-ODL-1.0",
  licenseUrl: "https://data.gov.sg/open-data-licence",
  attribution: "Contains information from HDB Carpark Information from data.gov.sg",
  privacyUrl: "https://data.gov.sg/privacy-and-terms",
});

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
  return new Response(fixture("overpass-parking.json"), {
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
  await syncSources(sql, [{ ...osmParking }, { ...mobidata }, { ...hdb }]);
  app = Fastify();
  registerScope(app, TOKEN);
  registerApiRoutes(app, sql, {
    registry: productionRegistry(),
    now: () => NOW,
    onDemand: {
      catalog: { feeds: [osmParking] },
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

describe("on-demand parking", () => {
  test("an on-demand parking read returns OSM sites only to the operator", async () => {
    const body = await read(true);
    expect(body.coverage).toEqual({
      partial: false,
      sources: [{ id: "osm-parking", complete: true }],
    });
    const osm = asked.filter((a) => a.url === "https://overpass-api.de/api/interpreter");
    expect(osm).toHaveLength(1);
    expect(osm[0]!.method).toBe("POST");
    expect(osm[0]!.body).toContain('nwr["amenity"="parking"](49,8.4,49.05,8.45);out center tags;');

    expect(body.records).toHaveLength(1);
    const [karstadt] = body.records;
    expect((karstadt!["provenance"] as Rec)["sourceId"]).toBe("osm-parking");
    expect(karstadt!["name"]).toEqual([{ lang: "und", text: "Karstadt" }]);

    // The cell is fresh, so the public read fetches nothing, and it is given no OSM site.
    const before = asked.length;
    const open = await read(false);
    expect(asked).toHaveLength(before);
    expect(open.records).toEqual([]);
    expect(JSON.stringify(open)).not.toMatch(/osm-parking/);
  });

  test("a feed site and an OSM element 24 m apart are one canonical site; two sites of one feed 20 m apart are not", async () => {
    const wctx = {
      registry: productionRegistry(),
      instanceId: "test.local",
      now: NOW.toISOString(),
      complete: true,
    };
    // OpenStreetMap's Karstadt car park, as an on-demand read of its cell writes it.
    const osm = parkingDomain.formats["overpass"]!.parse(
      osmParking as ParkingCatalogFeed,
      { main: [fixture("overpass-parking.json")] },
      { fetchedAt: NOW.toISOString(), cadenceSec: 3600, reference: {} },
    );
    const osmWritten = await writeSnapshot(
      sql,
      "osm-parking",
      {
        features: osm.features.filter((f) => f["id"] === "oc:feature:osm-parking:node/1725394191"),
      },
      { ...wctx, complete: false },
    );
    expect(osmWritten.rejected).toEqual([]);

    const ctx = { fetchedAt: "2026-10-05T03:45:00Z", cadenceSec: 300, reference: {} };
    const parkapi = parkingDomain.formats["parkapi-v3"]!.parse(
      mobidata as ParkingCatalogFeed,
      { main: [fixture("parkapi-v3-sites.json")], sources: [fixture("parkapi-v3-sources.json")] },
      ctx,
    );
    const karstadt = parkapi.features.find(
      (f) => f["id"] === "oc:feature:de-bw-mobidata-parking:19776",
    )!;
    const [lon, lat] = (karstadt["location"] as { geometry: { coordinates: number[] } }).geometry
      .coordinates as [number, number];
    // A second site of the same upstream source 20 m west of the first.
    const twin: Rec = {
      ...karstadt,
      id: "oc:feature:de-bw-mobidata-parking:19777",
      name: [{ lang: "de", text: "Karstadt Anlieferung" }],
      externalIds: [
        { scheme: "provider", id: "19777", authority: "de-bw-mobidata-parking/karlsruhe" },
      ],
      location: {
        ...(karstadt["location"] as Rec),
        geometry: {
          type: "Point",
          coordinates: [lon - 20 / (111_320 * Math.cos((lat * Math.PI) / 180)), lat],
        },
      },
      provenance: { ...(karstadt["provenance"] as Rec), recordId: "19777" },
    };
    const written = await writeSnapshot(
      sql,
      "de-bw-mobidata-parking",
      { features: [...parkapi.features, twin], observations: parkapi.observations },
      wctx,
    );
    expect(written.rejected).toEqual([]);

    const canonicalOf = async (featureId: string) => {
      const [row] = await sql<{ canonical_feature_id: string; member_ids: string[] }[]>`
        SELECT canonical_feature_id, member_ids
          FROM conditions.feature_canonical WHERE ${featureId} = ANY(member_ids)`;
      return row!;
    };
    // The OSM element is 24 m east of the site.
    const site = await canonicalOf(karstadt["id"] as string);
    expect(site.member_ids.sort()).toEqual([
      "oc:feature:de-bw-mobidata-parking:19776",
      "oc:feature:osm-parking:node/1725394191",
    ]);
    const other = await canonicalOf("oc:feature:de-bw-mobidata-parking:19777");
    expect(other.canonical_feature_id).not.toBe(site.canonical_feature_id);
    expect(other.member_ids).not.toContain("oc:feature:de-bw-mobidata-parking:19776");
  });

  test("an unnamed OSM element and an HDB car park are one canonical site with HDB's name, capacity and credit", async () => {
    const wctx = {
      registry: productionRegistry(),
      instanceId: "test.local",
      now: NOW.toISOString(),
      complete: true,
    };
    const ctx = { fetchedAt: NOW.toISOString(), cadenceSec: 300, reference: {} };
    const parsed = parkingDomain.formats["hdb"]!.parse(
      hdb as ParkingCatalogFeed,
      { sites: [fixture("singapore-static.json")], status: [fixture("singapore-live.json")] },
      ctx,
    );
    const acb = parsed.features.find((f) => f["id"] === "oc:feature:sg-hdb-parking:ACB")!;
    const [lon, lat] = (acb["location"] as { geometry: { coordinates: number[] } }).geometry
      .coordinates as [number, number];
    const hdbWritten = await writeSnapshot(sql, "sg-hdb-parking", { features: [acb] }, wctx);
    expect(hdbWritten.rejected).toEqual([]);
    // An unnamed OSM car park 10 m north of it; `osm-parking` sorts before `sg-hdb-parking`.
    const element = {
      elements: [
        { type: "node", id: 99, lat: lat + 10 / 111_320, lon, tags: { amenity: "parking" } },
      ],
    };
    const osm = parkingDomain.formats["overpass"]!.parse(
      osmParking as ParkingCatalogFeed,
      { main: [Buffer.from(JSON.stringify(element))] },
      ctx,
    );
    const osmWritten = await writeSnapshot(
      sql,
      "osm-parking",
      { features: osm.features },
      { ...wctx, complete: false },
    );
    expect(osmWritten.rejected).toEqual([]);

    const res = await app.inject({
      method: "GET",
      url: `/features?bbox=${lon - 0.001},${lat - 0.001},${lon + 0.001},${lat + 0.001}&kind=parking_site&canonical=1`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const records = (res.json() as { records: Rec[] }).records;
    expect(records).toHaveLength(1);
    const [canonical] = records;
    const provenance = canonical!["provenance"] as Rec;
    expect(provenance["sourceId"]).toBe("sg-hdb-parking");
    expect(canonical!["name"]).toEqual(acb["name"]);
    expect((canonical!["details"] as Rec)["capacityTotal"]).toBe(
      (acb["details"] as Rec)["capacityTotal"],
    );
    expect(provenance["attribution"]).toMatchObject({ license: "LicenseRef-Singapore-ODL-1.0" });
    expect(provenance["mergedSources"]).toEqual([
      expect.objectContaining({
        source: "osm-parking",
        recordId: "oc:feature:osm-parking:node/99",
      }),
    ]);
  });
});
