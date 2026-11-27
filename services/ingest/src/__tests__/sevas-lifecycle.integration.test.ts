import { readFileSync } from "node:fs";
import {
  type CatalogFeed,
  createFetchState,
  type LookupFn,
} from "@openconditions/ingest-framework";
import { productionRegistry } from "@openconditions/model-registry";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { createRoleState, runSource } from "../pipeline/run.js";
import { repoFeed, testFeed } from "./helpers/catalog.js";

const XML = readFileSync(
  new URL(
    "../../../../packages/roads/src/__tests__/fixtures/sevas/restrictions.gml",
    import.meta.url,
  ),
  "utf8",
);
const MEMBERS = XML.match(/<wfs:member>[\s\S]*?<\/wfs:member>/g)!;
function document(members: readonly string[]) {
  return `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ms="http://mapserver.gis.umn.edu/mapserver" xmlns:gml="http://www.opengis.net/gml/3.2" numberMatched="${members.length}" numberReturned="${members.length}">${members.join("")}</wfs:FeatureCollection>`;
}
const NOW = "2026-11-27T00:00:00.000Z";
const LATER = "2026-11-27T06:00:00.000Z";
const lookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
const feed = testFeed({
  id: "de-nw-sevas-conditions",
  operator: "sevas",
  region: "de",
  country: "DE",
  subdivision: "nw",
  product: "conditions",
  format: "sevas",
  snapshot: { completeness: "complete" },
  freshnessWindowSec: 172800,
  license: "DL-DE-ZERO-2.0",
  licenseUrl: "https://www.govdata.de/dl-de/zero-2-0",
});
let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.sql`TRUNCATE conditions.situation, conditions.source_status, conditions.source_poll_attempt CASCADE`;
});
const serve = (xml: string): typeof fetch =>
  (async () =>
    new Response(xml, { headers: { "content-type": "application/gml+xml" } })) as typeof fetch;
async function poll(xml = XML, src: CatalogFeed = feed, at = LATER, fetcher = serve(xml)) {
  return runSource(src, { sql: db.sql, fetch: fetcher, lookup, now: () => at });
}
async function rows() {
  return db.sql`SELECT id,content_hash,record,expires_at FROM conditions.situation WHERE source_id=${feed.id} AND tombstoned_at IS NULL ORDER BY id`;
}
async function seed() {
  expect((await poll(XML, feed, NOW)).error).toBeUndefined();
  expect(await rows()).toHaveLength(13);
}

it("activates a credential-free reviewed SEVAS source in the actual catalog", () => {
  const configured = repoFeed(feed.id);
  expect(configured.format).toBe("sevas");
  expect(configured.disabled).toBeUndefined();
  expect(configured.auth).toBeUndefined();
  expect(configured.license).toBe("DL-DE-ZERO-2.0");
});
it("withdraws missing segments only from complete subset and empty snapshots", async () => {
  await seed();
  expect((await poll(document(MEMBERS.slice(0, 1)))).error).toBeUndefined();
  expect(await rows()).toHaveLength(1);
  expect((await poll(document([]))).error).toBeUndefined();
  expect(await rows()).toHaveLength(0);
});
it.each([
  "counts",
  "continuation",
  "malformed",
  "missing identity",
  "duplicate conflict",
  "fetch failure",
  "byte cap",
])("retains last-good bytes and success clock on %s failure", async (kind) => {
  await seed();
  const before = await rows();
  const [status] =
    await db.sql`SELECT last_success_at FROM conditions.source_status WHERE source=${feed.id}`;
  let xml = XML;
  let src = feed;
  let fetcher: typeof fetch | undefined;
  if (kind === "counts") xml = XML.replace('numberMatched="14"', 'numberMatched="15"');
  if (kind === "continuation")
    xml = XML.replace(
      'numberReturned="14"',
      'numberReturned="14" next="https://example.test/next"',
    );
  if (kind === "malformed") xml = XML.slice(0, -20);
  if (kind === "missing identity") xml = XML.replace("<ms:segment_id>5855075</ms:segment_id>", "");
  if (kind === "duplicate conflict")
    xml = document([...MEMBERS, MEMBERS[0]!.replace("Im Alten Felde", "Different road")]);
  if (kind === "fetch failure")
    fetcher = (async () => new Response("", { status: 503 })) as typeof fetch;
  if (kind === "byte cap")
    src = { ...feed, acquisitionLimits: { requests: 1, bytes: 16, deadlineSec: 10 } };
  expect((await poll(xml, src, LATER, fetcher ?? serve(xml))).error).toBeDefined();
  expect(await rows()).toEqual(before);
  const [after] =
    await db.sql`SELECT last_success_at FROM conditions.source_status WHERE source=${feed.id}`;
  expect(after?.last_success_at).toEqual(status?.last_success_at);
});
it("protects a known segment when a later source geometry cannot be placed", async () => {
  await seed();
  const before = (await rows()).find((r) => String(r.id).endsWith("segment-5855075"))!;
  const changed = XML.replace(
    /<gml:posList[^>]*>[^<]+<\/gml:posList>/,
    '<gml:posList srsDimension="2">999 999 999 999</gml:posList>',
  );
  await poll(changed);
  expect((await rows()).find((r) => r.id === before.id)).toEqual(before);
});
it("replays accepted304 bytes for expiry without retaining a rejected candidate validator", async () => {
  const roles = createRoleState();
  const fetchState = createFetchState();
  let mode = "good";
  let lastTag: string | null = null;
  const fetcher = (async (_input, init) => {
    lastTag = new Headers(init?.headers).get("if-none-match");
    if (mode === "304") return new Response(null, { status: 304 });
    return new Response(
      mode === "bad" ? XML.replace('numberMatched="14"', 'numberMatched="15"') : XML,
      {
        headers: {
          etag: mode === "bad" ? '"bad"' : '"good"',
          "content-type": "application/gml+xml",
        },
      },
    );
  }) as typeof fetch;
  const run = (at: string) =>
    runSource(feed, { sql: db.sql, fetch: fetcher, lookup, roles, fetchState, now: () => at });
  expect((await run(NOW)).error).toBeUndefined();
  mode = "bad";
  expect((await run(LATER)).error).toBeDefined();
  mode = "304";
  expect((await run("2026-11-30T12:00:00.000Z")).error).toBeUndefined();
  expect(lastTag).toBe('"good"');
  expect((await rows())[0]?.expires_at.toISOString()).toBe("2026-12-02T12:00:00.000Z");
});
it("keeps stable segment identity across unchanged and OSM-generation updates", async () => {
  await seed();
  const before = await rows();
  expect((await poll(XML)).error).toBeUndefined();
  const repeated = await rows();
  expect(repeated.map((r) => [r.id, r.content_hash])).toEqual(
    before.map((r) => [r.id, r.content_hash]),
  );
  const changed = XML.replace(
    /<ms:osm_vers>[^<]+<\/ms:osm_vers>/,
    "<ms:osm_vers>osm_99999999</ms:osm_vers>",
  );
  expect(changed).not.toBe(XML);
  expect((await poll(changed)).error).toBeUndefined();
  const after = await rows();
  expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
  expect(after.filter((r, i) => r.content_hash !== before[i]?.content_hash)).toHaveLength(1);
  expect(JSON.stringify(after)).toContain("osm_vers:osm_99999999");
  expect(JSON.stringify(after)).not.toContain('"sourceUpdatedAt"');
});
it("serves public canonical restrictions with correct rights and retrieval expiry", async () => {
  await seed();
  const app = Fastify();
  registerScope(app, undefined);
  registerApiRoutes(app, db.sql, {
    registry: productionRegistry(),
    catalog: { sources: [feed] },
    now: () => new Date(NOW),
  });
  try {
    const response = await app.inject({ method: "GET", url: `/situations?at=${NOW}` });
    expect(response.statusCode).toBe(200);
    const records = response.json().records;
    expect(records).toHaveLength(13);
    expect(
      records.every(
        (r: { provenance: { sourceFormat: string }; freshness: { expiresAt: string } }) =>
          r.provenance.sourceFormat === "sevas" &&
          r.freshness.expiresAt === "2026-11-29T00:00:00.000Z",
      ),
    ).toBe(true);
    expect(JSON.stringify(records)).not.toContain('"sourceUpdatedAt"');
  } finally {
    await app.close();
  }
});
