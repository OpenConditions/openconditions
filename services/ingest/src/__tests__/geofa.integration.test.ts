import { type CatalogFeed, geofaDigest } from "@openconditions/ingest-framework";
import { productionRegistry } from "@openconditions/model-registry";
import { syncSources } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { createParseProcess } from "../pipeline/parse-process.js";
import { runSource } from "../pipeline/run.js";
import { repoFeed } from "./helpers/catalog.js";

let db: TestDatabase;
const child = createParseProcess({ minBytes: 0 });
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await child.close();
  await db?.close();
});
const row = (id: string) => ({
  type: "Feature",
  geometry: { type: "MultiPoint", coordinates: [[12, 55]] },
  properties: {
    objekt_id: id,
    versions_id: "v1",
    off_kode: 1,
    statuskode: 3,
    ladefacilitet_type_kode: 1,
    tilgaengelighed_type_kode: 1,
    planstatus_kode: 1,
    antal_ladepunkter: 1,
    internationalt_id: `DK*SPA*E${id}`,
    stiktype: "Type 2",
  },
});
const base = repoFeed("dk-geofa-charging");
function feed(rows: unknown[]): CatalogFeed {
  return {
    ...base,
    disabled: undefined,
    endpoints: {
      main: {
        ...base.endpoints["main"]!,
        geofa: { qualification: { count: rows.length, sha256: geofaDigest(rows) } },
      },
    },
  };
}
let minute = 0;
const now = () => new Date(Date.parse("2026-11-07T12:00:00Z") + minute * 60_000).toISOString();
async function run(src: CatalogFeed, rows: unknown[], status = 200) {
  return runSource(src, {
    sql: db.sql,
    parseProcess: child,
    now,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: (async () =>
      new Response(JSON.stringify({ type: "FeatureCollection", features: rows }), {
        status,
      })) as typeof fetch,
  });
}
async function active() {
  const [r] =
    await db.sql`select count(*)::int as n from conditions.feature where source_id=${base.id} and tombstoned_at is null`;
  return r!.n;
}
test("GeoFA runSource publishes qualified inventory through PostGIS and public API, and retains last good on failure", async () => {
  const rows = [row("1"), row("2")];
  const src = feed(rows);
  await syncSources(db.sql, [src]);
  expect(await run(src, rows)).toMatchObject({ outcome: "changed" });
  expect(await active()).toBe(2);
  const app = Fastify();
  registerScope(app, undefined);
  registerApiRoutes(app, db.sql, { registry: productionRegistry(), now: () => new Date(now()) });
  try {
    const res = await app.inject({
      method: "GET",
      url: "/features?bbox=11.9,54.9,12.1,55.1&kind=charging_site",
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().records).toHaveLength(2);
    expect(res.body).toContain("@geodanmark");
    expect(res.body).toContain("CC-BY-4.0");
    expect(res.body).toContain(
      "https://www.geodanmark.dk/home/vejledninger/vilkaar-for-data-anvendelse/",
    );
    for (const ext of ["geojson", "jsonld"]) {
      const exported = await app.inject({
        method: "GET",
        url: `/features.${ext}?bbox=11.9,54.9,12.1,55.1&kind=charging_site`,
      });
      expect(exported.statusCode, exported.body).toBe(200);
      expect(exported.body).toContain("@geodanmark");
      expect(exported.body).toContain("CC-BY-4.0");
    }
    // An unreviewed upstream credit must still suppress public egress.
    await db.sql`update conditions.feature set record=jsonb_set(record,'{provenance,upstream}', '[{"publisher":"Unreviewed upstream","license":"UNREVIEWED"}]'::jsonb) where id=${"oc:feature:dk-geofa-charging:1"}`;
    const withheld = await app.inject({
      method: "GET",
      url: "/features?bbox=11.9,54.9,12.1,55.1&kind=charging_site",
    });
    expect(withheld.json().records).toHaveLength(1);
    await db.sql`update conditions.feature set record=record #- '{provenance,upstream}' where id=${"oc:feature:dk-geofa-charging:1"}`;
  } finally {
    await app.close();
  }
  expect((await run(src, [rows[0]])).error).toMatch(/GeoFA/);
  expect(await active()).toBe(2);
  expect((await run(src, [], 503)).error).toMatch(/GeoFA/);
  expect(await active()).toBe(2);
  const unqualified = { ...src, endpoints: base.endpoints };
  expect((await run(unqualified, [])).error).toMatch(/qualification/);
  expect(await active()).toBe(2);
  const subset = [rows[0]!];
  expect((await run(feed(subset), subset)).outcome).toBe("changed");
  expect(await active()).toBe(1);
  // Even a qualified empty generation must pass the ordinary confirmation guard.
  expect((await run(feed([]), [])).error).toMatch(/shrank/);
  expect(await active()).toBe(1);
  minute = 5;
  expect((await run(feed([]), [])).error).toMatch(/shrank/);
  minute = 10;
  expect((await run(feed([]), [])).outcome).toBe("complete_empty");
  expect(await active()).toBe(0);
});
