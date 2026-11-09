import { readFileSync } from "node:fs";
import { productionRegistry } from "@openconditions/model-registry";
import { syncSources } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { createParseProcess } from "../pipeline/parse-process.js";
import { runSource } from "../pipeline/run.js";
import { REPO_CATALOG, repoFeed } from "./helpers/catalog.js";

const feed = repoFeed("ca-qc-mtmd-cameras");
const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL(
        "../../../../packages/cameras/src/__tests__/fixtures/ca-qc-mtmd.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
const worker = createParseProcess({ minBytes: 0 });
let db: TestDatabase;
let app: FastifyInstance;
let now = "2026-11-07T12:00:00Z";
const detail = "https://www.quebec511.info/Carte/Fenetres/FenetreVideo.html?id=3998";
beforeAll(async () => {
  db = await createTestDatabase();
  await syncSources(db.sql, [feed]);
  app = Fastify();
  registerScope(app, undefined);
  registerApiRoutes(app, db.sql, {
    registry: productionRegistry(),
    catalog: REPO_CATALOG,
    now: () => new Date(now),
  });
  await app.ready();
}, 120000);
afterAll(async () => {
  await worker.close();
  await app?.close();
  await db?.close();
});
async function poll(body: unknown, status = 200, broken = false) {
  return runSource(feed, {
    sql: db.sql,
    now: () => now,
    parseProcess: worker,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (input) => {
      expect(String(input)).toContain("srsname=EPSG:4326");
      if (broken) throw new Error("synthetic acquisition failure");
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/geo+json" },
      });
    },
  });
}
const rows = () =>
  db.sql`SELECT id, content_hash FROM conditions.feature WHERE source_id = ${feed.id} AND tombstoned_at IS NULL ORDER BY id`;

test("worker publication, public APIs and last-good inventory retention", async () => {
  expect((await poll(fixture())).error).toBeUndefined();
  expect(worker.running).toBe(true);
  const before = await rows();
  expect(before).toHaveLength(4);
  for (const suffix of ["", "&canonical=1"]) {
    const res = await app.inject(`/features?source=${feed.id}&expand=components,latest${suffix}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    const camera = body.records.find(
      (r: { provenance: { recordId: string } }) => r.provenance.recordId === "3998",
    );
    expect(camera, JSON.stringify(body)).toMatchObject({
      description: [{ lang: "fr" }, { lang: "en" }],
      details: { detailUrl: detail, imageRedistribution: "unknown" },
      components: [{ key: "0", details: { detailUrl: detail, imageRedistribution: "unknown" } }],
      provenance: { attribution: { license: "CC-BY-4.0" } },
    });
    expect(camera.images).toBeUndefined();
    expect(body.latest?.[camera.id] ?? []).toEqual([]);
  }
  const geo = await app.inject(`/features.geojson?source=${feed.id}`);
  expect(geo.statusCode, geo.body).toBe(200);
  expect(geo.json().features).toHaveLength(4);
  const sources = await app.inject("/sources");
  expect(sources.statusCode).toBe(200);
  expect(sources.body).toContain(feed.id);
  await db.sql`UPDATE conditions.feature SET record = jsonb_set(record, '{provenance,upstream}', '[{"publisher":"Restricted upstream","license":"ODbL-1.0"}]'::jsonb) WHERE source_id = ${feed.id}`;
  for (const url of [`/features?source=${feed.id}`, `/features.geojson?source=${feed.id}`]) {
    const denied = await app.inject(url);
    expect(denied.statusCode).toBe(200);
    expect(denied.json().records ?? denied.json().features).toEqual([]);
  }
  // Restore the exact licensed snapshot for subsequent retention assertions.
  await db.sql`UPDATE conditions.feature SET record = record #- '{provenance,upstream}' WHERE source_id = ${feed.id}`;
  const truncated = fixture();
  truncated.features.pop();
  const duplicate = fixture();
  duplicate.features[1].properties.IDEcamera = "3998";
  const badPoint = fixture();
  badPoint.features[0].geometry = null;
  for (const [body, status, broken] of [
    [truncated, 200, false],
    [duplicate, 200, false],
    [badPoint, 200, false],
    [{}, 200, false],
    [{}, 403, false],
    [{}, 200, true],
    [{ type: "FeatureCollection", features: [], numberMatched: 0 }, 200, false],
  ] as const) {
    expect((await poll(body, status, broken)).error).toBeDefined();
    expect(await rows()).toEqual(before);
  }
  const smaller = fixture();
  smaller.features.pop();
  smaller.numberMatched--;
  vi.stubEnv("OPENCONDITIONS_SHRINK_TRIPWIRE_RATIO", "0.9");
  try {
    expect((await poll(smaller)).error).toMatch(/shrank/);
    expect(await rows()).toEqual(before);
  } finally {
    vi.unstubAllEnvs();
  }
  expect((await poll(smaller)).error).toBeUndefined();
  expect(await rows()).toHaveLength(3);
  expect(await db.sql`SELECT * FROM conditions.observation`).toHaveLength(0);
}, 120000);

// A retained provider capture can qualify the entire generation without network I/O in tests.
test("every published record retains exact metadata, credit and two-day expiry", async () => {
  const body = process.env["QUEBEC_CAPTURE"]
    ? JSON.parse(readFileSync(process.env["QUEBEC_CAPTURE"], "utf8"))
    : fixture();
  expect((await poll(body)).error).toBeUndefined();
  const res = await app.inject(`/features?source=${feed.id}&expand=components,latest&limit=1000`);
  expect(res.statusCode, res.body).toBe(200);
  const records = res.json().records;
  expect(records).toHaveLength(body.features.length);
  for (const row of body.features) {
    const p = row.properties;
    const record = records.find(
      (r: { provenance: { recordId: string } }) => r.provenance.recordId === p.IDEcamera,
    );
    expect(record).toMatchObject({
      location: { geometry: row.geometry },
      description: [
        { lang: "fr", text: p.DescriptionLocalisationFr.trim() },
        { lang: "en", text: p.DescriptionLocalisationEn.trim() },
      ],
      details: { detailUrl: p.URL_FLUX_DONNEE, imageRedistribution: "unknown" },
      components: [{ key: "0", details: { detailUrl: p.URL_FLUX_DONNEE } }],
      freshness: { expiresAt: "2026-11-09T12:00:00.000Z" },
    });
    expect(record.provenance.attribution.provider).toContain("consulted 2026-11-09");
    expect(record.images).toBeUndefined();
    expect(res.json().latest?.[record.id] ?? []).toEqual([]);
  }
  expect(await db.sql`SELECT * FROM conditions.observation`).toHaveLength(0);
  const geo = await app.inject(`/features.geojson?source=${feed.id}&limit=1000`);
  expect(geo.json().features).toHaveLength(body.features.length);
  expect((await poll({}, 403)).error).toBeDefined();
  expect(await rows()).toHaveLength(body.features.length);
  now = "2026-11-09T12:00:00Z";
  const expired = await app.inject(`/features?source=${feed.id}`);
  expect(expired.json().records).toEqual([]);
});
