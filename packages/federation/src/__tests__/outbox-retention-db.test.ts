import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { readOutbox } from "../outbox.js";
import {
  DEFAULT_OUTBOX_RETENTION_SEC,
  OUTBOX_RETENTION_TIER1_FLOOR_SEC,
  pruneOutbox,
} from "../outbox-retention.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

/** A fixed evaluation instant so every age is deterministic. */
const NOW = "2026-07-15T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const DAY_SEC = 86_400;

/** ISO instant `n` days before {@link NOW}. */
function daysAgo(n: number): string {
  return new Date(NOW_MS - n * DAY_SEC * 1000).toISOString();
}

/** Inserts a journal row directly (bypassing the trigger) with an explicit
 *  `created_at`, so ages can be seeded across the retention floor. */
async function seedEntry(objectId: string, createdAt: string): Promise<void> {
  await sql`
    INSERT INTO conditions.federation_outbox
      (object_id, operation, canonical_id, payload_snapshot, created_at)
    VALUES (${objectId}, 'create', null,
            ${sql.json({ id: objectId } as never)}, ${createdAt}::timestamptz)`;
}

/** Inserts a real observation, firing the outbox trigger (row created at now()). */
async function insertObservation(id: string): Promise<void> {
  const geometry = { type: "Point", coordinates: [5.1, 52.1] };
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, type, category, severity, severity_source,
       headline, status, geom, origin, data_updated_at, fetched_at,
       canonical_id, privacy_class)
    VALUES (${id}, 'retention-test', 'datex2', 'roads', 'event', 'incident', 'incident',
       'medium', 'declared', 'headline', 'active',
       ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326),
       ${sql.json({ kind: "feed", attribution: { provider: "T", license: "CC-BY-4.0" } } as never)},
       '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z', null, 'authoritative')`;
}

async function survivingObjectIds(): Promise<string[]> {
  const rows = await sql<{ object_id: string }[]>`
    SELECT object_id FROM conditions.federation_outbox ORDER BY seq ASC`;
  return rows.map((r) => r.object_id);
}

beforeAll(async () => {
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containerStop = () => container.stop();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  sql = postgres(url, { max: 3 });
  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.federation_outbox RESTART IDENTITY`;
});

describe("pruneOutbox — the tier-time-floor retention bound", () => {
  it("deletes only rows older than the computed floor, returns count + floorIso", async () => {
    await seedEntry("recent-10d", daysAgo(10));
    await seedEntry("edge-36d", daysAgo(36));
    await seedEntry("past-38d", daysAgo(38));
    await seedEntry("old-40d", daysAgo(40));

    const result = await pruneOutbox(sql, { now: NOW });

    // Default floor = Tier-1 (30d) + 7d safety margin = 37 days.
    const floorSec = DEFAULT_OUTBOX_RETENTION_SEC;
    expect(floorSec).toBe(OUTBOX_RETENTION_TIER1_FLOOR_SEC + 7 * DAY_SEC);
    expect(result.floorIso).toBe(new Date(NOW_MS - floorSec * 1000).toISOString());
    expect(result.deleted).toBe(2);
    expect(await survivingObjectIds()).toEqual(["recent-10d", "edge-36d"]);
  }, 30_000);

  it("is idempotent: a second prune deletes nothing", async () => {
    await seedEntry("recent-5d", daysAgo(5));
    await seedEntry("old-50d", daysAgo(50));

    const first = await pruneOutbox(sql, { now: NOW });
    expect(first.deleted).toBe(1);

    const second = await pruneOutbox(sql, { now: NOW });
    expect(second.deleted).toBe(0);
    expect(await survivingObjectIds()).toEqual(["recent-5d"]);
  }, 30_000);

  it("never lets the floor fall below the Tier-1 window plus safety margin even with a tiny retentionSec", async () => {
    await seedEntry("twenty-20d", daysAgo(20));
    await seedEntry("forty-40d", daysAgo(40));

    const result = await pruneOutbox(sql, { now: NOW, retentionSec: DAY_SEC });

    // max(1d, 30d + 7d margin, 0) = 37d, applied UNCONDITIONALLY — the margin is
    // never dropped, so the archive-redirect's pre-window rows always survive.
    expect(result.floorIso).toBe(
      new Date(NOW_MS - DEFAULT_OUTBOX_RETENTION_SEC * 1000).toISOString()
    );
    // The bare Tier-1 floor (30d) still holds strictly below the effective floor.
    expect(DEFAULT_OUTBOX_RETENTION_SEC).toBeGreaterThan(OUTBOX_RETENTION_TIER1_FLOOR_SEC);
    expect(result.deleted).toBe(1);
    expect(await survivingObjectIds()).toEqual(["twenty-20d"]);
  }, 30_000);

  it("survives a row exactly at the floor (strict `<`, not `<=`)", async () => {
    // now - floorSec exactly: must NOT be pruned (the delete predicate is `<`).
    await seedEntry("exactly-at-floor", daysAgo(DEFAULT_OUTBOX_RETENTION_SEC / DAY_SEC));
    await seedEntry(
      "one-sec-past-floor",
      new Date(NOW_MS - (DEFAULT_OUTBOX_RETENTION_SEC + 1) * 1000).toISOString()
    );

    const result = await pruneOutbox(sql, { now: NOW });

    expect(result.deleted).toBe(1);
    expect(await survivingObjectIds()).toEqual(["exactly-at-floor"]);
  }, 30_000);

  it("fails CLOSED on a provided-but-unparseable archiveHighWaterIso (does not prune)", async () => {
    await seedEntry("old-60d", daysAgo(60));

    // An empty string (the Compose `${VAR:-}` trap) or garbage must THROW, never
    // silently skip the guard and delete un-archived pre-window rows.
    await expect(pruneOutbox(sql, { now: NOW, archiveHighWaterIso: "" })).rejects.toThrow(
      TypeError
    );
    await expect(pruneOutbox(sql, { now: NOW, archiveHighWaterIso: "not-a-date" })).rejects.toThrow(
      /archiveHighWaterIso/
    );

    // Nothing was deleted — the throw happened before the DELETE.
    expect(await survivingObjectIds()).toEqual(["old-60d"]);
  }, 30_000);

  it("widens the floor to a governance window that exceeds Tier-1", async () => {
    await seedEntry("forty-40d", daysAgo(40));
    await seedEntry("seventy-70d", daysAgo(70));

    // governanceWindowSec = 60 days > Tier-1 30d and > default; floor = 60d.
    const result = await pruneOutbox(sql, {
      now: NOW,
      retentionSec: DAY_SEC,
      governanceWindowSec: 60 * DAY_SEC,
    });

    expect(result.floorIso).toBe(new Date(NOW_MS - 60 * DAY_SEC * 1000).toISOString());
    expect(result.deleted).toBe(1);
    expect(await survivingObjectIds()).toEqual(["forty-40d"]);
  }, 30_000);

  it("archive-coverage guard: never prunes past what the archive has captured", async () => {
    await seedEntry("forty-40d", daysAgo(40));
    await seedEntry("sixty-60d", daysAgo(60));

    // Default floor = 37d, but the archive has only durably captured up to 50d
    // ago. Effective cutoff = min(now-37d, now-50d) = now-50d, so the 40-day-old
    // row (past the window but NEWER than the archive high-water) SURVIVES.
    const result = await pruneOutbox(sql, {
      now: NOW,
      archiveHighWaterIso: daysAgo(50),
    });

    // floorIso is still the retention floor (37d), not the effective cutoff.
    expect(result.floorIso).toBe(
      new Date(NOW_MS - DEFAULT_OUTBOX_RETENTION_SEC * 1000).toISOString()
    );
    expect(result.deleted).toBe(1);
    expect(await survivingObjectIds()).toEqual(["forty-40d"]);
  }, 30_000);

  it("archive high-water newer than the floor never widens pruning past the floor", async () => {
    await seedEntry("recent-10d", daysAgo(10));
    await seedEntry("past-40d", daysAgo(40));

    // Archive captured up to 5 days ago (newer than the 37d floor). The floor
    // still protects everything inside 37d; cutoff stays at the floor.
    const result = await pruneOutbox(sql, {
      now: NOW,
      archiveHighWaterIso: daysAgo(5),
    });

    expect(result.deleted).toBe(1);
    expect(await survivingObjectIds()).toEqual(["recent-10d"]);
  }, 30_000);
});

describe("pruneOutbox — the composite-cursor serve path is unaffected", () => {
  it("readOutbox still reads forward after old rows are pruned", async () => {
    const base = { txid: "0", seq: 0 };
    await insertObservation("keep-a");
    await insertObservation("keep-b");
    // An already-served old entry, past the floor, that pruning removes.
    await seedEntry("old-journal", daysAgo(40));

    const result = await pruneOutbox(sql, { now: NOW });
    expect(result.deleted).toBe(1);

    // The live pull from the start cursor delivers the surviving entries in
    // (txid, seq) order; the pruned old row is simply gone.
    const page = await readOutbox(sql, { after: base, limit: 500 });
    expect(page.orderedItems.map((e) => e.objectId)).toEqual(["keep-a", "keep-b"]);
  }, 30_000);

  it("a peer whose cursor already advanced past the pruned range keeps reading forward", async () => {
    const base = { txid: "0", seq: 0 };
    await insertObservation("fwd-a");
    await insertObservation("fwd-b");

    const first = await readOutbox(sql, { after: base, limit: 1 });
    expect(first.orderedItems.map((e) => e.objectId)).toEqual(["fwd-a"]);

    // Prune old history (nothing here is old, but the prune must not disturb the
    // reader's advanced cursor); then continue from the advanced high-water mark.
    await pruneOutbox(sql, { now: NOW });
    const second = await readOutbox(sql, { after: first.highWaterMark, limit: 500 });
    expect(second.orderedItems.map((e) => e.objectId)).toEqual(["fwd-b"]);
  }, 30_000);

  it("deletes a backlog larger than one batch across multiple chunks", async () => {
    // Seven prunable rows (all past the 37d floor) plus one that must survive.
    for (let i = 0; i < 7; i++) await seedEntry(`old-${i}`, daysAgo(40 + i));
    await seedEntry("recent", daysAgo(10));

    // batchSize 2 forces at least four delete round-trips (2+2+2+1); every
    // prunable row must still be removed and the recent one kept.
    const result = await pruneOutbox(sql, { now: NOW, batchSize: 2 });

    expect(result.deleted).toBe(7);
    expect(await survivingObjectIds()).toEqual(["recent"]);
    // Idempotent under batching: a second pass finds nothing to chunk.
    const again = await pruneOutbox(sql, { now: NOW, batchSize: 2 });
    expect(again.deleted).toBe(0);
    expect(await survivingObjectIds()).toEqual(["recent"]);
  }, 30_000);
});
