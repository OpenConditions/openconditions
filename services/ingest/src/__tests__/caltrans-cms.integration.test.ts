import { readFileSync } from "node:fs";
import path from "node:path";
import { type LookupFn, readCatalogDir, toCatalogFeed } from "@openconditions/ingest-framework";
import { buildRegistry, contentHash } from "@openconditions/model";
import { productionModules } from "@openconditions/model-registry";
import { roadsDomain } from "@openconditions/roads";
import {
  ensureObservationPartitions,
  retentionClasses,
  syncSources,
} from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { runSource } from "../pipeline/run.js";

const registry = buildRegistry(productionModules);
const captured = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/roads/src/__tests__/fixtures/caltrans-cms/d12.json.raw",
      import.meta.url,
    ),
    "utf8",
  ),
).data;
let db: TestDatabase;
let app: ReturnType<typeof Fastify>;
let now = "2026-11-07T08:00:00Z";
const feed = (d: number, qualified = false) => ({
  ...toCatalogFeed(
    {
      operator: "caltrans",
      subdivision: "ca",
      qualifier: `d${String(d).padStart(2, "0")}`,
      product: "signs",
      name: "Caltrans CMS",
      format: "caltrans-cms",
      tier: "authoritative",
      endpoints: { main: { url: `https://example.test/d${d}.json.raw`, cadenceSec: 60 } },
      freshnessWindowSec: 900,
      license: "LicenseRef-Caltrans-Conditions-of-Use",
      attribution: "Caltrans",
      terms: {
        url: "https://dot.ca.gov/conditions-of-use",
        reviewedAt: "2026-11-07",
        note: "Agency-owned CMS under Caltrans Conditions of Use, July 19, 2021; ownership exceptions apply.",
      },
      privacyUrl: "https://dot.ca.gov/privacy-policy",
      extrasAllow: ["caltransCms"],
    },
    { domain: "roads", region: "us", file: "feeds/roads/us.jsonc", maintainers: [] },
  ),
  caltransDistrict: d,
  ...(qualified ? { caltransSnapshotQualified: true as const } : {}),
});
const lookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
async function poll(d: number, rows: unknown[] | string, qualified = false) {
  now = new Date(Date.parse(now) + 60000).toISOString();
  return runSource(feed(d, qualified), {
    sql: db.sql,
    fetch: (async () =>
      new Response(
        typeof rows === "string" ? rows : JSON.stringify({ data: rows }),
      )) as typeof fetch,
    now: () => now,
    lookup,
    model: { registry, instanceId: "test.local" },
  });
}
const live = async (d: number) => {
  const r =
    await db.sql`SELECT id FROM conditions.feature WHERE source_id=${feed(d).id} AND tombstoned_at IS NULL`;
  return r.length;
};
beforeAll(async () => {
  db = await createTestDatabase();
  await syncSources(db.sql, [feed(11), feed(12)]);
  await ensureObservationPartitions(db.sql, {
    classes: retentionClasses(registry),
    now: new Date(now),
  });
  app = Fastify();
  registerScope(app, undefined);
  registerApiRoutes(app, db.sql, {
    registry,
    catalog: { sources: [feed(11), feed(12)] },
    now: () => new Date(now),
  });
  await app.ready();
}, 120000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});
it("retains subset/empty/failure last-good independently, clears blank/offline text and permits qualified complete-empty withdrawal", async () => {
  const sources = (await app.inject({ method: "GET", url: "/sources" })).json();
  expect(JSON.stringify(sources)).toContain("LicenseRef-Caltrans-Conditions-of-Use");
  expect(JSON.stringify(sources)).toContain("Caltrans");
  expect(sources.sources.find((s: { id: string }) => s.id === feed(12).id)).toMatchObject({
    restricted: false,
    permissions: { display: "yes", redistribute: "yes", derive: "yes" },
  });
  const a = structuredClone(captured[0]),
    b = structuredClone(captured[1]);
  a.cms.inService = "True";
  a.cms.message.display = "1 Page (Normal)";
  a.cms.message.phase1 = { phase1Line1: "DRIVE SAFELY", phase1Line2: "", phase1Line3: "" };
  expect((await poll(12, [a, b])).error).toBeUndefined();
  expect(await live(12)).toBe(2);
  const shown = await app.inject({
    method: "GET",
    url: `/features?source=${feed(12).id}&expand=latest`,
  });
  expect(JSON.stringify(shown.json().latest)).toContain("DRIVE SAFELY");
  expect(JSON.stringify(shown.json().latest)).toContain("Caltrans");
  await db.sql`UPDATE conditions.source SET restricted=true WHERE id=${feed(12).id}`;
  const hidden = await app.inject({
    method: "GET",
    url: `/features?source=${feed(12).id}&expand=latest`,
  });
  expect(hidden.json().records).toHaveLength(0);
  await db.sql`UPDATE conditions.source SET restricted=false WHERE id=${feed(12).id}`;
  await db.sql`UPDATE conditions.feature SET record=jsonb_set(record,'{provenance,upstream}','[{"publisher":"Unknown upstream","license":"NOASSERTION"}]'::jsonb) WHERE source_id=${feed(12).id}`;
  const upstreamHidden = await app.inject({
    method: "GET",
    url: `/features?source=${feed(12).id}&expand=latest`,
  });
  expect(upstreamHidden.json().records).toHaveLength(0);
  await db.sql`UPDATE conditions.feature SET record=record #- '{provenance,upstream}' WHERE source_id=${feed(12).id}`;

  expect((await poll(11, [a])).error).toBeUndefined();
  expect((await poll(12, [a])).error).toBeUndefined();
  const [heldSeries] =
    await db.sql`SELECT count(*)::int AS n FROM conditions.observation_latest WHERE source_id=${feed(12).id} AND NOT (reading ? 'validUntil')`;
  expect(heldSeries!.n).toBe(2);
  expect(await live(12)).toBe(2);
  expect((await poll(12, [])).error).toBeDefined();
  expect(await live(12)).toBe(2);
  expect((await poll(12, '{"data":[')).error).toBeDefined();
  expect(await live(12)).toBe(2);
  expect(await live(11)).toBe(1);
  for (const [service, mode, status] of [
    ["true", "Blank", "blank"],
    ["False", "1 Page (Normal)", "out_of_service"],
    ["Not Reported", "1 Page (Normal)", "unknown"],
  ]) {
    a.cms.inService = service;
    a.cms.message.display = mode;
    expect((await poll(12, [a, b])).error).toBeUndefined();
    const res = await app.inject({
      method: "GET",
      url: `/features?source=${feed(12).id}&expand=latest`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.records).toHaveLength(2);
    const readings = Object.values(body.latest).flat() as {
      result: { value: { workingStatus: string; messages: unknown[] } };
    }[];
    expect(
      readings.some(
        (r) => r.result.value.workingStatus === status && r.result.value.messages.length === 0,
      ),
    ).toBe(true);
    expect(JSON.stringify(body.latest)).not.toContain("DRIVE SAFELY");
  }
  expect((await poll(12, [], true)).error).toBeUndefined();
  expect(await live(12)).toBe(0);
  // Preserve the existing series shrink confirmation: 3 polls over at least 10 minutes.
  expect((await poll(12, [], true)).error).toBeUndefined();
  now = new Date(Date.parse(now) + 600000).toISOString();
  expect((await poll(12, [], true)).error).toBeUndefined();
  const [endedSeries] =
    await db.sql`SELECT count(*)::int AS n FROM conditions.observation_latest WHERE source_id=${feed(12).id} AND NOT (reading ? 'validUntil')`;
  expect(endedSeries!.n).toBe(0);
  expect(await live(11)).toBe(1);
});

it("publishes every actual district generation through the catalogue, registry and public API with bounded absent-reading expiry", async () => {
  const { files } = readCatalogDir(
    path.resolve(import.meta.dirname, "../../../../feeds"),
    [roadsDomain],
    { otherDomains: "ignore" },
  );
  const feeds = files.flatMap((file) =>
    file.feeds
      .filter((f) => f.format === "caltrans-cms")
      .map((def) =>
        toCatalogFeed(def, {
          domain: file.domain,
          region: file.region,
          file: file.path,
          maintainers: file.maintainers,
        }),
      ),
  );
  expect(feeds).toHaveLength(12);
  await syncSources(db.sql, feeds);
  const api = Fastify();
  registerScope(api, undefined);
  registerApiRoutes(api, db.sql, {
    registry,
    catalog: { sources: feeds },
    now: () => new Date(now),
  });
  await api.ready();
  try {
    for (const generation of [1, 2]) {
      for (const source of feeds) {
        const d = source.id.match(/-d(\d{2})-/)![1]!;
        const body = readFileSync(
          new URL(
            `../../../../packages/roads/src/__tests__/fixtures/caltrans-cms/activation/generation${generation}/d${d}.raw`,
            import.meta.url,
          ),
        );
        const result = await runSource(source, {
          sql: db.sql,
          fetch: (async () => new Response(body)) as typeof fetch,
          now: () => now,
          lookup,
          model: { registry, instanceId: "test.local" },
        });
        expect(result.error, source.id).toBeUndefined();
        const response = await api.inject({
          method: "GET",
          url: `/features?source=${source.id}&expand=latest&limit=500`,
        });
        expect(response.statusCode).toBe(200);
        const data = response.json();
        expect(data.records.length, source.id).toBe(
          [28, 42, 107, 189, 22, 118, 145, 94, 15, 107, 80, 66][Number(d) - 1],
        );
        expect(
          data.records.every(
            (r: { provenance: { attribution: { provider: string } } }) =>
              r.provenance.attribution.provider === "Caltrans",
          ),
        ).toBe(true);
        console.log(
          "Caltrans actual capture",
          generation,
          source.id,
          data.records.length,
          Object.keys(data.latest).length,
        );
      }
      now = new Date(Date.parse(now) + 300000).toISOString();
    }
    const source = feeds.find((s) => s.id === "us-ca-caltrans-d01-signs")!;
    const before = (
      await api.inject({ method: "GET", url: `/features?source=${source.id}&expand=latest` })
    ).json();
    const result = await runSource(source, {
      sql: db.sql,
      fetch: (async () => new Response("<html>unavailable</html>")) as typeof fetch,
      now: () => now,
      lookup,
      model: { registry, instanceId: "test.local" },
    });
    expect(result.error).toBeDefined();
    const held = (
      await api.inject({ method: "GET", url: `/features?source=${source.id}&expand=latest` })
    ).json();
    expect(held.records.length).toBe(before.records.length);
    const body = JSON.parse(
      readFileSync(
        new URL(
          "../../../../packages/roads/src/__tests__/fixtures/caltrans-cms/activation/generation2/d01.raw",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    body.data.shift();
    now = new Date(Date.parse(now) + 901000).toISOString();
    const subset = await runSource(source, {
      sql: db.sql,
      fetch: (async () => new Response(JSON.stringify(body))) as typeof fetch,
      now: () => now,
      lookup,
      model: { registry, instanceId: "test.local" },
    });
    expect(subset.error).toBeUndefined();
    const expired = (
      await api.inject({ method: "GET", url: `/features?source=${source.id}&expand=latest` })
    ).json();
    expect(expired.records).toHaveLength(27);
    expect(Object.keys(expired.latest)).toHaveLength(27);
    const canonical = (
      await api.inject({
        method: "GET",
        url: `/features?source=${source.id}&canonical=1&expand=components,latest`,
      })
    ).json();
    expect(canonical.records).toHaveLength(27);
    for (const record of canonical.records) expect(record.contentHash).toBe(contentHash(record));
    now = new Date(Date.parse(now) + 901000).toISOString();
    const allExpired = (
      await api.inject({ method: "GET", url: `/features?source=${source.id}&expand=latest` })
    ).json();
    expect(allExpired.records).toHaveLength(0);
    expect(Object.keys(allExpired.latest)).toHaveLength(0);
    const sourceReadings = (
      await api.inject({ method: "GET", url: `/observations/latest?source=${source.id}` })
    ).json();
    expect(sourceReadings.records).toHaveLength(0);
  } finally {
    await api.close();
  }
}, 120000);
