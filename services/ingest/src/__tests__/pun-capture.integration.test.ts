import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FetchResult, punManifest } from "@openconditions/ingest-framework";
import { contentHash } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import { syncSources } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { loadIngestCatalog } from "../domains.js";
import { createParseProcess } from "../pipeline/parse-process.js";
import { runSource } from "../pipeline/run.js";

const directory = process.env["PUN_CAPTURE_DIR"];
let sealed: FetchResult;
vi.mock("@openconditions/ingest-framework", async (original) => {
  const actual = await original<typeof import("@openconditions/ingest-framework")>();
  return {
    ...actual,
    fetchEndpoint: (...args: Parameters<typeof actual.fetchEndpoint>) =>
      sealed ? Promise.resolve(sealed) : actual.fetchEndpoint(...args),
  };
});
let db: TestDatabase;
beforeAll(async () => {
  if (directory) db = await createTestDatabase();
});
afterAll(async () => {
  await db?.close();
});
it.skipIf(!directory)(
  "qualifies a sealed full capture through actual parse worker, PostGIS and public API without provider calls",
  async () => {
    const root = directory!;
    expect(JSON.parse(readFileSync(join(root, "capture-result.json"), "utf8")).status).toBe(
      "sealed",
    );
    const cache = join(root, "capture");
    const first = readFileSync(join(cache, "manifest-before.json"));
    const manifest = punManifest(first);
    const catalog = await loadIngestCatalog({});
    const feed = [...catalog.feeds, ...catalog.disabled].find(
      (f) => f.id === "it-agid-pun-charging",
    )!;
    await syncSources(db.sql, [feed]);
    const bodies = [
      first,
      ...manifest.files.map((f) => readFileSync(join(cache, f.key.replace("/", "_")))),
      readFileSync(join(cache, "manifest-after.json")),
    ];
    const expectedIds = new Set<string>();
    for (const body of bodies.slice(1, -1))
      for (const row of JSON.parse(body.toString()).punti) expectedIds.add(row.id_evse);
    const calls = manifest.files.length + 2;
    sealed = {
      status: "fetched",
      bodyFreshness: "acquired",
      validatedAtNetwork: true,
      partitions: { succeeded: manifest.files.length, failed: 0, total: manifest.files.length },
      buffers: bodies,
      urls: [],
      payloads: [],
      accept: () => {},
    };
    const worker = createParseProcess({
      minBytes: 0,
      entry: new URL("./pun-capture-worker.ts", import.meta.url),
    });
    const started = Date.now();
    const registry = productionRegistry();
    const now = new Date().toISOString();
    try {
      const result = await runSource(feed, {
        sql: db.sql,
        fetch: async () => {
          throw Error("network forbidden in replay");
        },
        now: () => now,
        parseProcess: worker,
        model: { registry, instanceId: "pun-qualification.local" },
      });
      expect(result.error).toBeUndefined();
      expect(result.count).toBeGreaterThan(0);
      const counts =
        await db.sql`SELECT count(*)::int AS features FROM conditions.feature WHERE source_id=${feed.id} AND tombstoned_at IS NULL`;
      const observations =
        await db.sql`SELECT count(*)::int AS observations FROM conditions.observation_latest WHERE source_id=${feed.id}`;
      expect(observations[0]!.observations).toBe(0);
      expect(counts[0]!.features).toBe(expectedIds.size);
      const app = Fastify();
      registerScope(app, "offline-qualification");
      registerApiRoutes(app, db.sql, { registry, now: () => new Date(now) });
      await app.ready();
      let body = "";
      const publicIds = new Set<string>();
      let publicPages = 0;
      let publicBytes = 0;
      try {
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        do {
          expect(publicPages).toBeLessThanOrEqual(Math.ceil(expectedIds.size / 5000) + 1);
          const query = new URLSearchParams({
            source: feed.id,
            kind: "charging_site",
            limit: "5000",
            expand: "components",
          });
          if (cursor) query.set("cursor", cursor);
          const page = await app.inject({ url: `/features?${query}` });
          expect(page.statusCode).toBe(200);
          const result = page.json();
          publicPages++;
          publicBytes += Buffer.byteLength(page.body);
          for (const record of result.records) {
            expect(record.contentHash).toBe(contentHash(record));
            expect(JSON.stringify(record)).not.toContain("publicationStatus");
            expect(record.provenance.sourceId).toBe(feed.id);
            publicIds.add(record.provenance.recordId);
          }
          cursor = result.next ?? undefined;
          if (cursor) {
            expect(seenCursors.has(cursor)).toBe(false);
            seenCursors.add(cursor);
          }
        } while (cursor);
        expect(publicIds).toEqual(expectedIds);
        const response = await app.inject({
          url: "/features?bbox=6,35,19,47.5&kind=charging_site&canonical=1",
        });
        expect(response.statusCode).toBe(200);
        body = response.body;
        expect(body).toContain("GSE/MASE");
        expect(body).not.toContain("charging.evse_status");
        expect(body).not.toContain("publicationStatus");
        expect(body).not.toContain("snapshotDate");
        expect(body).not.toContain("real_time");
        expect(body).toContain("CC BY 4.0 ex art. 52 c.2 D.Lgs 82/2005 (CAD)");
        const operatorResponse = await app.inject({
          url: "/features?bbox=6,35,19,47.5&kind=charging_site&canonical=1",
          headers: { authorization: "Bearer offline-qualification" },
        });
        expect(operatorResponse.statusCode).toBe(200);
        expect(operatorResponse.body).toContain("publicationStatus");
        expect(operatorResponse.headers["cache-control"]).toBe("private, no-store");
      } finally {
        await app.close();
      }
      writeFileSync(
        join(root, "pipeline-result.json"),
        JSON.stringify(
          {
            result,
            counts,
            observations,
            elapsedMs: Date.now() - started,
            resourceUsage: process.resourceUsage(),
            memory: process.memoryUsage(),
            publicResponseBytes: Buffer.byteLength(body),
            publicPageRecords: JSON.parse(body).records.length,
            publicSourceRecords: publicIds.size,
            publicPages,
            publicBytes,
            acquisitionCalls: calls,
            providerCalls: 0,
            clock: "accelerated acquisition replay; real worker/database clock",
          },
          null,
          2,
        ),
      );
    } finally {
      await worker.close();
    }
  },
  120000,
);
