import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { digestPayload } from "@openconditions/ingest-framework";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRawArchive } from "../raw/archive.js";
import { evictRawPayloads } from "../raw/evict.js";
import { createRestrictionDatabase } from "./helpers/restriction-database.integration.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-20T12:00:00Z");

let db: Awaited<ReturnType<typeof createRestrictionDatabase>>;
let sql: postgres.Sql;
let dir: string;

beforeAll(async () => {
  db = await createRestrictionDatabase();
  sql = db.sql;
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "oc-raw-"));
  await sql`TRUNCATE conditions.raw_payload, conditions.situation, conditions.source_status CASCADE`;
  return () => rmSync(dir, { recursive: true, force: true });
});

/** Archives `count` distinct payloads of a source, one an hour, the newest `newestHoursAgo` ago. */
async function archive(
  sourceId: string,
  tier: "situation" | "hot",
  count: number,
  newestHoursAgo = 0,
) {
  const raw = createRawArchive(sql, { dir });
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = new Date(NOW - (newestHoursAgo + i) * HOUR);
    const body = Buffer.from(`${sourceId} payload ${i} ${"x".repeat(200)}`);
    const digest = digestPayload(`https://${sourceId}.example/feed`, body);
    await raw.capture(
      { sourceId, fetchId: i + 1, fetchedAt: at, tier, url: digest.url },
      body,
      digest,
    );
    hashes.push(digest.sha256);
  }
  return hashes;
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
    await archive("ca-bc-drivebc", "hot", 60);
    const result = await evictRawPayloads(sql, { dir, policy: policy(), historyDays: 90 });
    expect(result.evict).toHaveLength(60 - 49);
    const rows = await held();
    expect(rows.filter((r) => r.evicted)).toHaveLength(11);
    for (const r of rows) expect(existsSync(path.join(dir, r.storage_key))).toBe(!r.evicted);
  });

  it("keeps a payload a live situation was read from", async () => {
    const hashes = await archive("nl-ndw", "situation", 1, 20 * 24);
    await archive("nl-ndw", "situation", 3);
    await sql`
      INSERT INTO conditions.situation (id, record, canonical_id, kind, domain, temporality,
        source_id, source_record_id, origin, access_mode, privacy_class, instance_id, revision,
        recorded_at, content_hash, fetched_at, severity, certainty, planned, validity_status)
      VALUES ('oc:situation:nl-ndw:a', ${sql.json({ provenance: { rawRef: { hash: hashes[0] } } })},
        'c', 'incident', 'roads', 'live', 'nl-ndw', 'a', 'feed', 'bulk', 'authoritative',
        'local', 1, now(), 'h', now(), 'unknown', 'unknown', false, 'active')`;
    const result = await evictRawPayloads(sql, { dir, policy: policy(), historyDays: 90 });
    expect(result.evict.map((r) => r.hash)).not.toContain(hashes[0]);
  });

  it("over the cap, warns on the sources that lost hot-window payloads", async () => {
    await sql`INSERT INTO conditions.source_status (source, freshness_window_sec) VALUES ('nl-ndw', 900)`;
    await archive("nl-ndw", "situation", 20);
    const result = await evictRawPayloads(sql, {
      dir,
      policy: policy({ maxBytes: 1 }),
      historyDays: 90,
    });
    expect(result).toMatchObject({ rung: 3, hotEvicted: ["nl-ndw"] });
    expect(result.evict).toHaveLength(17);
    const [status] = await sql`SELECT raw_hot_evicted_at FROM conditions.source_status`;
    expect(status!["raw_hot_evicted_at"]).toEqual(new Date(NOW));
  });

  it("plans without touching anything on a dry run", async () => {
    await archive("ca-bc-drivebc", "hot", 60);
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
    const hashes = await archive("ca-bc-drivebc", "hot", 60);
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
          const body = Buffer.from(`ca-bc-drivebc payload 59 ${"x".repeat(200)}`);
          const digest = digestPayload("https://ca-bc-drivebc.example/feed", body);
          const meta = { sourceId: "ca-bc-drivebc", fetchId: 99, tier: "hot" as const };
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
    await archive("ca-bc-drivebc", "hot", 60);
    await evictRawPayloads(sql, { dir, policy: policy(), historyDays: 90 });
    const later = { ...policy(), now: NOW + 91 * 24 * HOUR };
    const result = await evictRawPayloads(sql, { dir, policy: later, historyDays: 90 });
    expect(result.purged).toBe(11);
  });
});
