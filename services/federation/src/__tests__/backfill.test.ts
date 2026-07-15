import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import {
  encodeOutboxCursor,
  pruneOutbox,
  readOutbox,
  type OutboxCursor,
} from "@openconditions/federation";
import {
  BACKFILL_WINDOW_TIER_0_SEC,
  BACKFILL_WINDOW_TIER_1_SEC,
  backfillWindowForTier,
  readBackfill,
} from "../backfill.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-07-13T12:00:00.000Z";
const ARCHIVE_URL = "https://conditions.example.org/archive";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The current maximum committed composite `(txid, seq)` cursor. */
async function frontier(): Promise<OutboxCursor> {
  const [row] = await sql<{ txid: string; seq: string }[]>`
    SELECT txid::text AS txid, seq::text AS seq
    FROM conditions.federation_outbox
    ORDER BY txid DESC, seq DESC
    LIMIT 1`;
  return row ? { txid: row.txid, seq: Number(row.seq) } : { txid: "0", seq: 0 };
}

async function insertObservation(id: string, lon = 5.1): Promise<void> {
  const geometry = { type: "Point", coordinates: [lon, 52.1] };
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, type, category, severity, severity_source,
       headline, status, geom, origin, data_updated_at, fetched_at)
    VALUES (${id}, 'backfill-test', 'datex2', 'roads', 'event', 'incident', 'incident', 'medium',
       'declared', ${id}, 'active',
       ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326),
       ${sql.json({ kind: "feed", attribution: { provider: "Test", license: "CC0-1.0" } } as never)},
       '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z')`;
}

/** Backdates the outbox row for an object to `msAgo` before NOW. */
async function setAge(objectId: string, msAgo: number): Promise<void> {
  const ts = new Date(Date.parse(NOW) - msAgo).toISOString();
  await sql`
    UPDATE conditions.federation_outbox
    SET created_at = ${ts}::timestamptz
    WHERE object_id = ${objectId}`;
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

describe("backfillWindowForTier", () => {
  it("floors Tier 0 at 24 hours", () => {
    expect(backfillWindowForTier(0)).toEqual({ maxAgeSec: BACKFILL_WINDOW_TIER_0_SEC });
    expect(BACKFILL_WINDOW_TIER_0_SEC).toBe(86_400);
  });

  it("floors Tier 1 at 30 days", () => {
    expect(backfillWindowForTier(1)).toEqual({ maxAgeSec: BACKFILL_WINDOW_TIER_1_SEC });
    expect(BACKFILL_WINDOW_TIER_1_SEC).toBe(2_592_000);
  });

  it("floors Tier 2 at >= 30 days (default equals Tier 1; a longer window widens it)", () => {
    expect(backfillWindowForTier(2).maxAgeSec).toBeGreaterThanOrEqual(BACKFILL_WINDOW_TIER_1_SEC);
    expect(backfillWindowForTier(2, 7_776_000).maxAgeSec).toBe(7_776_000);
    // A configured window shorter than Tier 1 can never shrink a governance anchor.
    expect(backfillWindowForTier(2, 3_600).maxAgeSec).toBe(BACKFILL_WINDOW_TIER_1_SEC);
  });
});

describe("readBackfill — the tier-bounded time floor", () => {
  it("serves a Tier-1 peer entries within 30 days and omits older ones", async () => {
    const base = await frontier();
    await insertObservation("bf-t1-recent");
    await insertObservation("bf-t1-old");
    await setAge("bf-t1-recent", 20 * DAY);
    await setAge("bf-t1-old", 40 * DAY);

    const page = await readBackfill(sql, {
      after: base,
      tier: 1,
      now: NOW,
      archiveUrl: ARCHIVE_URL,
      limit: 500,
    });
    const ids = page.orderedItems.map((e) => e.objectId);
    expect(ids).toContain("bf-t1-recent");
    expect(ids).not.toContain("bf-t1-old");
    // The 40-day entry is beyond the window ⇒ redirect to the static archive.
    expect(page.beyondWindow).toBe(true);
    expect(page.archiveUrl).toBe(ARCHIVE_URL);
  }, 30_000);

  it("serves a Tier-0 peer only the last 24 hours", async () => {
    const base = await frontier();
    await insertObservation("bf-t0-fresh");
    await insertObservation("bf-t0-stale");
    await setAge("bf-t0-fresh", 2 * HOUR);
    await setAge("bf-t0-stale", 2 * DAY);

    const page = await readBackfill(sql, {
      after: base,
      tier: 0,
      now: NOW,
      archiveUrl: ARCHIVE_URL,
      limit: 500,
    });
    const ids = page.orderedItems.map((e) => e.objectId);
    expect(ids).toContain("bf-t0-fresh");
    expect(ids).not.toContain("bf-t0-stale");
    expect(page.beyondWindow).toBe(true);
    expect(page.archiveUrl).toBe(ARCHIVE_URL);
  }, 30_000);

  it("within the window returns the SAME composite-cursor entries as the outbox (gap-free)", async () => {
    const base = await frontier();
    await insertObservation("bf-par-a");
    await insertObservation("bf-par-b");
    await insertObservation("bf-par-c");
    await setAge("bf-par-a", 1 * HOUR);
    await setAge("bf-par-b", 2 * HOUR);
    await setAge("bf-par-c", 3 * HOUR);

    const backfill = await readBackfill(sql, {
      after: base,
      tier: 1,
      now: NOW,
      archiveUrl: ARCHIVE_URL,
      limit: 500,
    });
    const outbox = await readOutbox(sql, { after: base, limit: 500 });

    expect(backfill.orderedItems.map((e) => e.objectId)).toEqual(
      outbox.orderedItems.map((e) => e.objectId)
    );
    expect(backfill.highWaterMark).toBe(outbox.highWaterMark);
    // Nothing before the floor after this cursor ⇒ no archive redirect.
    expect(backfill.beyondWindow).toBeUndefined();
    expect(backfill.archiveUrl).toBeUndefined();
  }, 30_000);

  it("flags beyondWindow with the archive link when the cursor sits before the floor", async () => {
    const base = await frontier();
    await insertObservation("bf-before-floor");
    await setAge("bf-before-floor", 45 * DAY);

    // A cursor at (or before) the pre-floor entry ⇒ the range reaches the archive.
    const page = await readBackfill(sql, {
      after: base,
      tier: 1,
      now: NOW,
      archiveUrl: ARCHIVE_URL,
      limit: 500,
    });
    expect(page.orderedItems.map((e) => e.objectId)).not.toContain("bf-before-floor");
    expect(page.beyondWindow).toBe(true);
    expect(page.archiveUrl).toBe(ARCHIVE_URL);

    // Advancing the cursor PAST the pre-floor entry drops the redirect.
    const advanced = await readBackfill(sql, {
      after: encodeOutboxCursor(await frontier()),
      tier: 1,
      now: NOW,
      archiveUrl: ARCHIVE_URL,
      limit: 500,
    });
    expect(advanced.beyondWindow).toBeUndefined();
  }, 30_000);

  it("includes an entry exactly ON the floor (created_at == now - window, consistent with the >= scan)", async () => {
    const base = await frontier();
    await insertObservation("bf-on-floor");
    // Exactly at the Tier-1 floor: now - 30 days.
    await setAge("bf-on-floor", BACKFILL_WINDOW_TIER_1_SEC * 1000);

    const page = await readBackfill(sql, {
      after: base,
      tier: 1,
      now: NOW,
      archiveUrl: ARCHIVE_URL,
      limit: 500,
    });
    expect(page.orderedItems.map((e) => e.objectId)).toContain("bf-on-floor");
    // The boundary entry is served, not redirected.
    expect(page.beyondWindow).toBeUndefined();
  }, 30_000);

  it("does not break gap-freeness: a floored page keeps the composite-cursor ordering", async () => {
    const base = await frontier();
    await insertObservation("bf-gap-1");
    await insertObservation("bf-gap-2");
    await setAge("bf-gap-1", 1 * HOUR);
    await setAge("bf-gap-2", 2 * HOUR);

    const first = await readBackfill(sql, { after: base, tier: 1, now: NOW, limit: 1 });
    expect(first.orderedItems.map((e) => e.objectId)).toEqual(["bf-gap-1"]);
    const second = await readBackfill(sql, {
      after: first.highWaterMark,
      tier: 1,
      now: NOW,
      limit: 1,
    });
    expect(second.orderedItems.map((e) => e.objectId)).toEqual(["bf-gap-2"]);
  }, 30_000);
});

describe("readBackfill — the archive redirect survives the retention prune", () => {
  it("still flags beyondWindow/archiveUrl for a stale-cursor Tier-1 peer after pruning", async () => {
    const base = await frontier();
    // A row in the SAFETY-MARGIN band: beyond the Tier-1 serve window (30d) so it
    // drives the archive redirect, but INSIDE the retention floor (30d + 7d) so
    // the prune must not delete it. Plus a deep-past row the prune removes — the
    // point of the unconditional margin is that pruning the deep past does not
    // silence the redirect, because the margin-band row keeps it alive.
    await insertObservation("bf-margin-band");
    await insertObservation("bf-deep-past");
    await setAge("bf-margin-band", 33 * DAY);
    await setAge("bf-deep-past", 50 * DAY);

    const before = await readBackfill(sql, {
      after: base,
      tier: 1,
      now: NOW,
      archiveUrl: ARCHIVE_URL,
      limit: 500,
    });
    expect(before.beyondWindow).toBe(true);

    const pruned = await pruneOutbox(sql, { now: NOW });
    expect(pruned.deleted).toBeGreaterThanOrEqual(1);

    const survivors = await sql<{ object_id: string }[]>`
      SELECT object_id FROM conditions.federation_outbox
      WHERE object_id IN ('bf-margin-band', 'bf-deep-past')`;
    const ids = survivors.map((r) => r.object_id);
    expect(ids).toContain("bf-margin-band");
    expect(ids).not.toContain("bf-deep-past");

    const after = await readBackfill(sql, {
      after: base,
      tier: 1,
      now: NOW,
      archiveUrl: ARCHIVE_URL,
      limit: 500,
    });
    expect(after.beyondWindow).toBe(true);
    expect(after.archiveUrl).toBe(ARCHIVE_URL);
  }, 30_000);
});
