import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { digestPayload } from "@openconditions/ingest-framework";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRawArchive } from "../raw/archive.js";
import { evictRawPayloads } from "../raw/evict.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-20T12:00:00Z");

let db: TestDatabase;
let sql: postgres.Sql;
let dir: string;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "oc-raw-"));
  await sql`TRUNCATE conditions.raw_payload, conditions.source_poll_attempt,
    conditions.source_status CASCADE`;
  return () => rmSync(dir, { recursive: true, force: true });
});

/**
 * Archives `count` distinct payloads of a source fetched from `path`, one an
 * hour, the newest `newestHoursAgo` ago.
 */
async function archive(
  sourceId: string,
  tier: "situation" | "hot" | "observation" | "reference",
  count: number,
  newestHoursAgo = 0,
  path = "/feed",
) {
  const raw = createRawArchive(sql, { dir });
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = new Date(NOW - (newestHoursAgo + i) * HOUR);
    // Named by its URL and age, so payloads archived by separate calls stay distinct.
    const name = path === "/feed" ? sourceId : `${sourceId}${path}`;
    const body = Buffer.from(`${name} payload ${newestHoursAgo + i} ${"x".repeat(200)}`);
    const digest = digestPayload(`https://${sourceId}.example${path}`, body);
    await raw.capture(
      { sourceId, fetchId: i + 1, fetchedAt: at, tier, url: digest.url },
      body,
      digest,
    );
    hashes.push(digest.sha256);
  }
  return hashes;
}

/** Records a finished poll of a source `hoursAgo`, published or not, that received `hashes`. */
async function poll(
  source: string,
  hoursAgo: number,
  published: boolean,
  hashes: readonly string[] | null,
) {
  const at = new Date(NOW - hoursAgo * HOUR);
  await sql`
    INSERT INTO conditions.source_poll_attempt (source, attempted_at, finished_at, outcome,
      network_validated, published, payload_hashes)
    VALUES (${source}, ${at}, ${at}, ${published ? "changed" : "failed"}, ${published},
      ${published}, ${hashes ? sql.array([...hashes]) : null}::text[])`;
}

const policy = (over: { maxBytes?: number } = {}) => ({
  now: NOW,
  hotHours: 48,
  thinDays: { situation: 14, observation: 7 },
  maxBytes: over.maxBytes ?? 0,
});

async function held() {
  return sql<{ hash: string; evicted: boolean; storage_key: string }[]>`
    SELECT hash, evicted_at IS NOT NULL AS evicted, storage_key FROM conditions.raw_payload`;
}

describe("evictRawPayloads", () => {
  it("deletes evicted blobs and keeps their index rows, marked", async () => {
    await archive("ca-bc-drivebc-events", "hot", 60);
    const result = await evictRawPayloads(sql, { dir, policy: policy(), historyDays: 90 });
    expect(result.evict).toHaveLength(60 - 49);
    const rows = await held();
    expect(rows.filter((r) => r.evicted)).toHaveLength(11);
    for (const r of rows) expect(existsSync(path.join(dir, r.storage_key))).toBe(!r.evicted);
  });

  it("keeps the payloads a source's latest publication was read from, and only those", async () => {
    const [superseded] = await archive("nl-ndw-events", "situation", 1, 21 * 24);
    const live = await archive("nl-ndw-events", "situation", 2, 20 * 24);
    // Fetched since, by polls that published nothing.
    const unpublished = await archive("nl-ndw-events", "situation", 3);
    await poll("nl-ndw-events", 21 * 24, true, [superseded!]);
    await poll("nl-ndw-events", 20 * 24, true, live);
    await poll("nl-ndw-events", 1, false, unpublished);
    await poll("nl-ndw-events", 0, false, null);
    const result = await evictRawPayloads(sql, { dir, policy: policy(), historyDays: 90 });
    expect(result.evict.map((r) => r.hash)).toEqual([superseded]);
  });

  it("evicts only the payloads of the sources the process owns", async () => {
    await archive("nl-ndw-flow", "hot", 60);
    await archive("nl-ndw-events", "hot", 60);
    const evicted = async () =>
      sql<{ source_id: string; n: number }[]>`
        SELECT source_id, count(*)::int AS n FROM conditions.raw_payload
         WHERE evicted_at IS NOT NULL GROUP BY source_id ORDER BY source_id`;

    const heavy = await evictRawPayloads(sql, {
      dir,
      policy: policy(),
      historyDays: 90,
      scope: { only: ["nl-ndw-flow"] },
    });
    expect(new Set(heavy.evict.map((r) => r.sourceId))).toEqual(new Set(["nl-ndw-flow"]));
    expect(await evicted()).toEqual([{ source_id: "nl-ndw-flow", n: 11 }]);

    const primary = await evictRawPayloads(sql, {
      dir,
      policy: policy(),
      historyDays: 90,
      scope: { except: ["nl-ndw-flow"] },
    });
    expect(new Set(primary.evict.map((r) => r.sourceId))).toEqual(new Set(["nl-ndw-events"]));
    expect(await evicted()).toEqual([
      { source_id: "nl-ndw-events", n: 11 },
      { source_id: "nl-ndw-flow", n: 11 },
    ]);
  });

  it("caps only the payloads of the sources the process owns", async () => {
    await archive("nl-ndw-flow", "hot", 10);
    await archive("nl-ndw-events", "hot", 10);
    const [events] = await sql<{ bytes: number }[]>`
      SELECT sum(bytes_stored)::int AS bytes FROM conditions.raw_payload
       WHERE source_id = 'nl-ndw-events'`;
    // The events' own archive fits; the flow's bytes, another process's, do not count.
    const result = await evictRawPayloads(sql, {
      dir,
      policy: policy({ maxBytes: events!.bytes }),
      historyDays: 90,
      scope: { except: ["nl-ndw-flow"] },
    });
    expect(result.evict).toEqual([]);
  });

  it("keeps a source's latest publication by its own source, not another's", async () => {
    const [other] = await archive("nl-ndw-flow", "observation", 1, 20 * 24);
    await archive("nl-ndw-flow", "observation", 3);
    await poll("nl-ndw-events", 20 * 24, true, [other!]);
    const result = await evictRawPayloads(sql, { dir, policy: policy(), historyDays: 90 });
    expect(result.evict.map((r) => r.hash)).toEqual([other]);
  });

  it("keeps the newest site table a source fetched, however long ago", async () => {
    const [older, newest] = await archive("nl-ndw-flow", "reference", 2, 60 * 24, "/sites").then(
      (h) => h.reverse(),
    );
    await archive("nl-ndw-flow", "observation", 3);
    const result = await evictRawPayloads(sql, { dir, policy: policy(), historyDays: 90 });
    expect(result.evict.map((r) => r.hash)).toEqual([older]);
    expect(result.evict.map((r) => r.hash)).not.toContain(newest);
  });

  it("keeps the newest payload of each URL a source fetched within its thinned window", async () => {
    const [held, superseded] = await archive("nl-ndw-events", "situation", 2, 5 * 24, "/b");
    const [gone] = await archive("nl-ndw-events", "situation", 1, 20 * 24, "/c");
    await archive("nl-ndw-events", "situation", 3);
    const result = await evictRawPayloads(sql, {
      dir,
      policy: policy({ maxBytes: 1 }),
      historyDays: 90,
    });
    const evicted = result.evict.map((r) => r.hash);
    expect(evicted).not.toContain(held);
    expect(evicted).toEqual(expect.arrayContaining([superseded, gone]));
  });

  it("does not keep a payload past the hot window for a source whose terms do not affirm retention", async () => {
    const [stale] = await archive("ca-bc-drivebc-events", "hot", 1, 5 * 24, "/b");
    await archive("ca-bc-drivebc-events", "hot", 3);
    const result = await evictRawPayloads(sql, { dir, policy: policy(), historyDays: 90 });
    expect(result.evict.map((r) => r.hash)).toEqual([stale]);
  });

  it("over the cap, warns on the sources that lost hot-window payloads", async () => {
    await sql`INSERT INTO conditions.source_status (source, freshness_window_sec) VALUES ('nl-ndw-events', 900)`;
    await archive("nl-ndw-events", "situation", 20);
    const result = await evictRawPayloads(sql, {
      dir,
      policy: policy({ maxBytes: 1 }),
      historyDays: 90,
    });
    expect(result).toMatchObject({ rung: 3, hotEvicted: ["nl-ndw-events"] });
    expect(result.evict).toHaveLength(17);
    const [status] = await sql`SELECT raw_hot_evicted_at FROM conditions.source_status`;
    expect(status!["raw_hot_evicted_at"]).toEqual(new Date(NOW));
  });

  it("plans without touching anything on a dry run", async () => {
    await archive("ca-bc-drivebc-events", "hot", 60);
    const result = await evictRawPayloads(sql, {
      dir,
      policy: policy(),
      historyDays: 90,
      dryRun: true,
    });
    expect(result.evict).toHaveLength(11);
    expect((await held()).some((r) => r.evicted)).toBe(false);
  });

  it("keeps a payload a poll fetched again after eviction planned it away", async () => {
    const hashes = await archive("ca-bc-drivebc-events", "hot", 60);
    const oldest = hashes[59]!;
    const raw = createRawArchive(sql, { dir });
    // The poll lands between eviction reading the archive and applying its plan.
    const racing = new Proxy(sql, {
      apply(target, self, args) {
        const query = Reflect.apply(target, self, args);
        const strings = args[0] as readonly string[] | undefined;
        if (!Array.isArray(strings) || !strings.join("").includes("FROM conditions.raw_payload p"))
          return query;
        return query.then(async (rows: unknown) => {
          const body = Buffer.from(`ca-bc-drivebc-events payload 59 ${"x".repeat(200)}`);
          const digest = digestPayload("https://ca-bc-drivebc.example/feed", body);
          const meta = { sourceId: "ca-bc-drivebc-events", fetchId: 99, tier: "hot" as const };
          await raw.capture({ ...meta, fetchedAt: new Date(NOW), url: digest.url }, body, digest);
          return rows;
        });
      },
    });
    const result = await evictRawPayloads(racing, { dir, policy: policy(), historyDays: 90 });
    expect(result.evict.map((r) => r.hash)).not.toContain(oldest);
    const row = (await held()).find((r) => r.hash === oldest)!;
    expect(row.evicted).toBe(false);
    expect(existsSync(path.join(dir, row.storage_key))).toBe(true);
  });

  it("removes the index rows of payloads evicted longer ago than the history window", async () => {
    await archive("ca-bc-drivebc-events", "hot", 60);
    await evictRawPayloads(sql, { dir, policy: policy(), historyDays: 90 });
    const later = { ...policy(), now: NOW + 91 * 24 * HOUR };
    const result = await evictRawPayloads(sql, { dir, policy: later, historyDays: 90 });
    expect(result.purged).toBe(11);
  });
});
