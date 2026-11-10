import { readFileSync } from "node:fs";
import type { CatalogFeed, LookupFn } from "@openconditions/ingest-framework";
import { productionRegistry } from "@openconditions/model-registry";
import { WA_WEBEOC_NOTICE } from "@openconditions/roads";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { createParseProcess } from "../pipeline/parse-process.js";
import { runSource } from "../pipeline/run.js";
import { repoFeed } from "./helpers/catalog.js";

const feed = repoFeed("au-wa-mainroads-closures-events");
const NOW = "2026-11-07T06:00:00.000Z";
const LATER = "2026-11-07T06:05:00.000Z";
const lookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL(
        "../../../../packages/roads/src/__tests__/fixtures/wa-webeoc/live.geojson",
        import.meta.url,
      ),
      "utf8",
    ),
  );
const serve = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body))) as typeof fetch;
let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.sql`TRUNCATE conditions.situation, conditions.source_status, conditions.source_poll_attempt CASCADE`;
});
async function poll(body: unknown, src = feed, at = LATER, fetcher = serve(body)) {
  return runSource(src, { sql: db.sql, fetch: fetcher, lookup, now: () => at });
}
async function rows() {
  return db.sql`SELECT id, content_hash, record FROM conditions.situation
    WHERE source_id = ${feed.id} AND tombstoned_at IS NULL ORDER BY id`;
}
async function seed() {
  expect((await poll(fixture(), feed, NOW)).error).toBeUndefined();
  expect(await rows()).toHaveLength(5);
}

it.each(["subset", "empty"])(
  "retains absent WA predecessors after successful %s polls",
  async (shape) => {
    await seed();
    const before = await rows();
    const body = fixture();
    body.features = body.features.slice(0, shape === "subset" ? 1 : 0);
    expect((await poll(body)).error).toBeUndefined();
    expect((await rows()).map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect((await poll({ type: "FeatureCollection", features: [] })).error).toBeUndefined();
    expect((await rows()).map((r) => r.id)).toEqual(before.map((r) => r.id));
  },
);

it("allows deliberate complete-snapshot qualification to withdraw subset and empty predecessors", async () => {
  await seed();
  const qualified: CatalogFeed = {
    ...feed,
    snapshot: { completeness: "complete", recordsPath: "features" },
  };
  const subset = fixture();
  subset.features = subset.features.slice(0, 1);
  expect((await poll(subset, qualified)).error).toBeUndefined();
  expect(await rows()).toHaveLength(1);
  expect(
    (await poll({ type: "FeatureCollection", features: [] }, qualified)).error,
  ).toBeUndefined();
  expect(await rows()).toHaveLength(0);
});

it.each(["later page", "page cap", "duplicate conflict", "invalid geometry"])(
  "retains last good publication on %s failure",
  async (failure) => {
    await seed();
    const before = await rows();
    const [status] =
      await db.sql`SELECT last_success_at FROM conditions.source_status WHERE source = ${feed.id}`;
    const body = fixture();
    let src = feed;
    let fetcher = serve(body);
    if (failure === "invalid geometry") body.features[0].geometry = null;
    if (failure === "duplicate conflict") {
      const other = structuredClone(body.features[0]);
      other.properties.Location = "Conflicting location";
      body.features.push(other);
    }
    if (failure === "later page" || failure === "page cap") {
      // Synthetic small page limits exercise the actual bounded acquisition path.
      src = {
        ...feed,
        endpoints: {
          ...feed.endpoints,
          main: {
            ...feed.endpoints.main,
            pagination: {
              skipParam: "resultOffset",
              pageSize: 5,
              recordsPath: "features",
              maxPages: 2,
            },
          },
        },
      };
      let calls = 0;
      fetcher = (async () => {
        calls++;
        return calls > 1 && failure === "later page"
          ? new Response(JSON.stringify({ error: { code: 500, message: "later page failed" } }))
          : new Response(JSON.stringify(body));
      }) as typeof fetch;
    } else fetcher = serve(body);
    expect((await poll(body, src, LATER, fetcher)).error).toBeDefined();
    expect(await rows()).toEqual(before);
    const [after] =
      await db.sql`SELECT last_success_at FROM conditions.source_status WHERE source = ${feed.id}`;
    expect(after!.last_success_at).toEqual(status!.last_success_at);
  },
);

it("round trips WA identity, retrieval and rights from acquisition through database to public record API", async () => {
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
    expect(records).toHaveLength(5);
    const input = fixture().features[0];
    const record = records.find((r: { externalIds: { id: string }[] }) =>
      r.externalIds.some((id) => id.id === `Id:${input.properties.Id}`),
    );
    expect(record).toMatchObject({
      id: `oc:situation:${feed.id}:${input.properties.GlobalID.toLowerCase()}`,
      freshness: { fetchedAt: NOW },
      provenance: {
        sourceId: feed.id,
        sourceFormat: "wa-webeoc",
        recordId: input.properties.GlobalID.toLowerCase(),
        attribution: {
          license: "CC-BY-4.0",
          licensing: {
            bindings: [
              expect.objectContaining({ notice: expect.stringContaining(WA_WEBEOC_NOTICE) }),
            ],
          },
        },
      },
    });
    expect(record.externalIds).toContainEqual({
      scheme: "provider",
      authority: feed.id,
      id: `Id:${input.properties.Id}`,
    });
    expect(record.location.geometry).toEqual(input.geometry);
    expect(JSON.stringify(record)).not.toContain('"sourceUpdatedAt"');
  } finally {
    await app.close();
  }
});

it("publishes the current real generation through the worker and expires absent rows independently of successful subset polls", async () => {
  await seed();
  const current = JSON.parse(
    readFileSync(
      new URL(
        "../../../../packages/roads/src/__tests__/fixtures/wa-webeoc/2026-11-08.geojson",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const child = createParseProcess({ minBytes: 0 });
  try {
    const result = await runSource(feed, {
      sql: db.sql,
      fetch: serve(current),
      lookup,
      now: () => NOW,
      parseProcess: child,
    });
    expect(result.error).toBeUndefined();
    const published = await rows();
    expect(published).toHaveLength(6);
    for (const input of current.features) {
      const stored = published.find((r) => r.id.endsWith(input.properties.GlobalID.toLowerCase()));
      expect(stored!.record.location.geometry).toEqual(input.geometry);
      expect(stored!.record.freshness).toMatchObject({
        fetchedAt: NOW,
        expiresAt: "2026-11-07T06:15:00.000Z",
      });
    }
    current.features = current.features.slice(0, 1);
    expect((await poll(current)).error).toBeUndefined();
    expect(await rows()).toHaveLength(6);
    const app = Fastify();
    registerScope(app, undefined);
    registerApiRoutes(app, db.sql, {
      registry: productionRegistry(),
      catalog: { sources: [feed] },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/situations?at=2026-11-07T06:16:00.000Z",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().records).toHaveLength(1);
      const expired = await app.inject({
        method: "GET",
        url: "/situations?at=2026-11-07T06:21:00.000Z",
      });
      expect(expired.json().records).toEqual([]);
    } finally {
      await app.close();
    }
  } finally {
    await child.close();
  }
}, 120_000);
