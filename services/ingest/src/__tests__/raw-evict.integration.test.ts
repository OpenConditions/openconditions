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
/** When a record or reading that is still moving last changed. */
const RECENT = new Date(NOW - 60 * 60 * 1000).toISOString();

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
  await sql`TRUNCATE conditions.raw_payload, conditions.situation, conditions.feature,
    conditions.offer, conditions.observation_latest, conditions.source_status CASCADE`;
  return () => rmSync(dir, { recursive: true, force: true });
});

/** Archives `count` distinct payloads of a source, one an hour, the newest `newestHoursAgo` ago. */
async function archive(
  sourceId: string,
  tier: "situation" | "hot" | "observation" | "reference",
  count: number,
  newestHoursAgo = 0,
) {
  const raw = createRawArchive(sql, { dir });
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = new Date(NOW - (newestHoursAgo + i) * HOUR);
    // Named by its age, so payloads archived by separate calls stay distinct.
    const body = Buffer.from(`${sourceId} payload ${newestHoursAgo + i} ${"x".repeat(200)}`);
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
        'local', 1, ${RECENT}, 'h', ${RECENT}, 'unknown', 'unknown', false, 'active')`;
    const result = await evictRawPayloads(sql, { dir, policy: policy(), historyDays: 90 });
    expect(result.evict.map((r) => r.hash)).not.toContain(hashes[0]);
  });

  it("keeps a payload a live feature or a series' reading in effect was read from", async () => {
    const [site] = await archive("nl-ndw-flow", "reference", 1, 20 * 24);
    const [reading] = await archive("nl-ndw-flow", "observation", 1, 19 * 24);
    await archive("nl-ndw-flow", "observation", 3);
    await sql`
      INSERT INTO conditions.feature (id, record, canonical_id, kind, domain, temporality,
        source_id, source_record_id, origin, access_mode, privacy_class, instance_id, revision,
        recorded_at, content_hash, fetched_at, lifecycle)
      VALUES ('oc:feature:nl-ndw-flow:s1', ${sql.json({ provenance: { rawRef: { hash: site } } })},
        'c', 'measurement_site', 'roads', 'static', 'nl-ndw-flow', 's1', 'feed', 'bulk',
        'authoritative', 'local', 1, ${RECENT}, 'h', ${RECENT}, 'operational')`;
    await sql`
      INSERT INTO conditions.observation_latest (subject_key, property, source_id, subject_kind,
        reading, template, template_hash, access_mode, result_type, effective_from, since_at,
        updated_at)
      VALUES ('feature:oc:feature:nl-ndw-flow:s1', 'traffic.speed', 'nl-ndw-flow', 'feature',
        ${sql.json({ provenance: { rawRef: { hash: reading } } })}, '{}'::jsonb, '', 'bulk',
        'quantity', ${RECENT}, ${RECENT}, ${RECENT})`;
    const result = await evictRawPayloads(sql, { dir, policy: policy(), historyDays: 90 });
    expect(result.evict.map((r) => r.hash)).not.toContain(site);
    expect(result.evict.map((r) => r.hash)).not.toContain(reading);
  });

  it("stops keeping a payload for a site or a reading that has not moved for weeks", async () => {
    const [site] = await archive("de-bw-ocpdb", "observation", 1, 30 * 24);
    const [reading] = await archive("de-bw-ocpdb", "observation", 1, 29 * 24);
    await archive("de-bw-ocpdb", "observation", 3);
    const weeksAgo = new Date(NOW - 28 * 24 * HOUR).toISOString();
    await sql`
      INSERT INTO conditions.feature (id, record, canonical_id, kind, domain, temporality,
        source_id, source_record_id, origin, access_mode, privacy_class, instance_id, revision,
        recorded_at, content_hash, fetched_at, lifecycle)
      VALUES ('oc:feature:de-bw-ocpdb:old', ${sql.json({ provenance: { rawRef: { hash: site } } })},
        'c2', 'charging_site', 'charging', 'static', 'de-bw-ocpdb', 'old', 'feed', 'bulk',
        'authoritative', 'local', 1, ${weeksAgo}, 'h', ${weeksAgo}, 'operational')`;
    await sql`
      INSERT INTO conditions.observation_latest (subject_key, property, source_id, subject_kind,
        reading, template, template_hash, access_mode, result_type, effective_from, since_at,
        updated_at)
      VALUES ('feature:oc:feature:de-bw-ocpdb:old', 'charging.evse_status', 'de-bw-ocpdb',
        'feature', ${sql.json({ provenance: { rawRef: { hash: reading } } })}, '{}'::jsonb, '',
        'bulk', 'category', ${weeksAgo}, ${weeksAgo}, ${weeksAgo})`;
    const result = await evictRawPayloads(sql, { dir, policy: policy(), historyDays: 90 });
    expect(result.evict.map((r) => r.hash)).toEqual(expect.arrayContaining([site, reading]));
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
