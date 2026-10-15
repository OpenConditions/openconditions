import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { relinkFeatures } from "../canonical-view.js";
import { writeSnapshot } from "../write-records.js";
import { FETCHED_AT } from "./drafts.js";
import { registry } from "./facility-fixtures.js";

/** Above the features one write touches from which linking analyses `feature` first. */
const SITES = 1_200;

let db: TestDatabase;
let traced: postgres.Sql;
const statements: string[] = [];
const ids = Array.from({ length: SITES }, (_, i) => `oc:feature:osm:node-${i + 1}`);

/** A register's charging site, a kilometre or so from the next. */
const site = (n: number) => ({
  id: ids[n - 1],
  class: "feature",
  kind: "charging_site",
  temporality: "static",
  lifecycle: "operational",
  location: {
    geometry: { type: "Point", coordinates: [5 + (n % 40) * 0.01, 47 + Math.floor(n / 40) * 0.01] },
    extent: "point",
    geometryOrigin: "source",
    fuzziness: "exact",
  },
  provenance: {
    origin: "feed",
    sourceId: "osm",
    sourceFormat: "osm",
    accessMode: "bulk",
    recordId: `node-${n}`,
    attribution: { provider: "OpenStreetMap contributors", license: "ODbL-1.0" },
    privacy: { class: "authoritative" },
  },
  freshness: { fetchedAt: FETCHED_AT },
  details: { kind: "charging_site", v: 1 },
});

beforeAll(async () => {
  db = await createTestDatabase();
  await writeSnapshot(
    db.sql,
    "osm",
    { features: Array.from({ length: SITES }, (_, i) => site(i + 1)) },
    { registry, instanceId: "local", now: FETCHED_AT, complete: true },
  );
  traced = postgres(db.url, {
    max: 1,
    onnotice: () => {},
    connection: { lock_timeout: 60_000 },
    debug: (_connection, query) => statements.push(query),
  });
}, 180_000);

afterAll(async () => {
  await traced?.end();
  await db?.close();
});

/** Relinks the sites in one transaction; resolves with its lock_timeout afterwards. */
const relink = () =>
  traced.begin(async (tx) => {
    await relinkFeatures(tx, registry, {
      featureIds: ids,
      instanceId: "local",
      now: new Date().toISOString(),
    });
    const [row] = await tx<{ lock_timeout: string }[]>`SHOW lock_timeout`;
    return row!.lock_timeout;
  });

describe("the ANALYZE before a large write's pair search", () => {
  test("goes on without it while another transaction holds its lock", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // An earlier publication's ANALYZE, held until its transaction commits.
    const holder = db.sql.begin(async (tx) => {
      await tx`ANALYZE conditions.feature`;
      locked();
      await gate;
    });
    await holding;
    try {
      statements.length = 0;
      expect(await relink()).toBe("1min");
      expect(statements.some((q) => q.includes("ANALYZE conditions.feature"))).toBe(true);
    } finally {
      release();
      await holder;
    }
  }, 60_000);

  test("analyses, then restores the pool's lock_timeout for the rest of the transaction", async () => {
    const [before] = await db.sql<{ count: number }[]>`
      SELECT analyze_count::int AS count FROM pg_stat_user_tables
       WHERE schemaname = 'conditions' AND relname = 'feature'`;
    expect(await relink()).toBe("1min");
    // The statistics view is updated asynchronously.
    await expect
      .poll(
        async () =>
          (
            await db.sql<{ count: number }[]>`
              SELECT analyze_count::int AS count FROM pg_stat_user_tables
               WHERE schemaname = 'conditions' AND relname = 'feature'`
          )[0]!.count,
      )
      .toBeGreaterThan(before!.count);
  }, 60_000);
});
