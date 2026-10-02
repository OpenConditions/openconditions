import { runMigrations } from "@openconditions/core/server";
import {
  encodeOutboxCursor,
  type OutboxCursor,
  type OutboxPage,
  pruneOutbox,
  readOutbox,
} from "@openconditions/federation";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BACKFILL_WINDOW_TIER_0_SEC,
  BACKFILL_WINDOW_TIER_1_SEC,
  backfillWindowForTier,
  readBackfill,
} from "../backfill.js";
import {
  ownSituation,
  setOutboxAge,
  situationId,
  storeSituation,
  subscribeAll,
} from "./record-fixtures.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-07-13T12:00:00.000Z";
const ARCHIVE_URL = "https://conditions.example.org/archive";
/** The archive's latest file of each class, which a beyond-window page names. */
const ARCHIVE_FILES = {
  situation: `${ARCHIVE_URL}/archive-situation.parquet`,
  feature: `${ARCHIVE_URL}/archive-feature.parquet`,
  offer: `${ARCHIVE_URL}/archive-offer.parquet`,
  observation: `${ARCHIVE_URL}/archive-observation.parquet`,
};
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

/** Stores one of this instance's situations and backdates its journal entry. */
async function seed(local: string, msAgo?: number): Promise<void> {
  await storeSituation(sql, ownSituation(local));
  if (msAgo !== undefined) await setOutboxAge(sql, situationId(local), msAgo, NOW);
}

const ids = (page: OutboxPage) => page.orderedItems.map((e) => e.recordId);

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
  await subscribeAll(sql, "sub-backfill");
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
    await seed("bf-t1-recent", 20 * DAY);
    await seed("bf-t1-old", 40 * DAY);

    const page = await readBackfill(sql, {
      after: base,
      tier: 1,
      now: NOW,
      archiveUrl: ARCHIVE_URL,
      limit: 500,
    });
    expect(ids(page)).toContain(situationId("bf-t1-recent"));
    expect(ids(page)).not.toContain(situationId("bf-t1-old"));
    expect(page.orderedItems[0]).toMatchObject({ recordClass: "situation", operation: "create" });
    // The 40-day entry is beyond the window ⇒ redirect to the static archive.
    expect(page.beyondWindow).toBe(true);
    expect(page.archiveUrl).toEqual(ARCHIVE_FILES);
  }, 30_000);

  it("serves a Tier-0 peer only the last 24 hours", async () => {
    const base = await frontier();
    await seed("bf-t0-fresh", 2 * HOUR);
    await seed("bf-t0-stale", 2 * DAY);

    const page = await readBackfill(sql, {
      after: base,
      tier: 0,
      now: NOW,
      archiveUrl: ARCHIVE_URL,
      limit: 500,
    });
    expect(ids(page)).toContain(situationId("bf-t0-fresh"));
    expect(ids(page)).not.toContain(situationId("bf-t0-stale"));
    expect(page.beyondWindow).toBe(true);
    expect(page.archiveUrl).toEqual(ARCHIVE_FILES);
  }, 30_000);

  it("within the window returns the SAME composite-cursor entries as the outbox (gap-free)", async () => {
    const base = await frontier();
    await seed("bf-par-a", 1 * HOUR);
    await seed("bf-par-b", 2 * HOUR);
    await seed("bf-par-c", 3 * HOUR);

    const backfill = await readBackfill(sql, {
      after: base,
      tier: 1,
      now: NOW,
      archiveUrl: ARCHIVE_URL,
      limit: 500,
    });
    const outbox = await readOutbox(sql, { after: base, limit: 500 });

    expect(ids(backfill)).toEqual(ids(outbox));
    expect(ids(backfill)).toEqual(["bf-par-a", "bf-par-b", "bf-par-c"].map(situationId));
    expect(backfill.highWaterMark).toBe(outbox.highWaterMark);
    // Nothing before the floor after this cursor ⇒ no archive redirect.
    expect(backfill.beyondWindow).toBeUndefined();
    expect(backfill.archiveUrl).toBeUndefined();
  }, 30_000);

  it("narrows a backfill page with the subscriber's record filter", async () => {
    const base = await frontier();
    await storeSituation(sql, ownSituation("bf-filter-works", { kind: "roadworks" }));
    await seed("bf-filter-incident");

    const page = await readBackfill(sql, {
      after: base,
      tier: 1,
      now: NOW,
      filter: { classes: ["situation"], kinds: ["roadworks"] },
      limit: 500,
    });
    expect(ids(page)).toEqual([situationId("bf-filter-works")]);
  }, 30_000);

  it("flags beyondWindow with the archive link when the cursor sits before the floor", async () => {
    const base = await frontier();
    await seed("bf-before-floor", 45 * DAY);

    // A cursor at (or before) the pre-floor entry ⇒ the range reaches the archive.
    const page = await readBackfill(sql, {
      after: base,
      tier: 1,
      now: NOW,
      archiveUrl: ARCHIVE_URL,
      limit: 500,
    });
    expect(ids(page)).not.toContain(situationId("bf-before-floor"));
    expect(page.beyondWindow).toBe(true);
    expect(page.archiveUrl).toEqual(ARCHIVE_FILES);

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
    // Exactly at the Tier-1 floor: now - 30 days.
    await seed("bf-on-floor", BACKFILL_WINDOW_TIER_1_SEC * 1000);

    const page = await readBackfill(sql, {
      after: base,
      tier: 1,
      now: NOW,
      archiveUrl: ARCHIVE_URL,
      limit: 500,
    });
    expect(ids(page)).toContain(situationId("bf-on-floor"));
    // The boundary entry is served, not redirected.
    expect(page.beyondWindow).toBeUndefined();
  }, 30_000);

  it("does not break gap-freeness: a floored page keeps the composite-cursor ordering", async () => {
    const base = await frontier();
    await seed("bf-gap-1", 1 * HOUR);
    await seed("bf-gap-2", 2 * HOUR);

    const first = await readBackfill(sql, { after: base, tier: 1, now: NOW, limit: 1 });
    expect(ids(first)).toEqual([situationId("bf-gap-1")]);
    const second = await readBackfill(sql, {
      after: first.highWaterMark,
      tier: 1,
      now: NOW,
      limit: 1,
    });
    expect(ids(second)).toEqual([situationId("bf-gap-2")]);
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
    await seed("bf-margin-band", 33 * DAY);
    await seed("bf-deep-past", 50 * DAY);

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

    const survivors = await sql<{ record_id: string }[]>`
      SELECT record_id FROM conditions.federation_outbox
      WHERE record_id IN (${situationId("bf-margin-band")}, ${situationId("bf-deep-past")})`;
    const kept = survivors.map((r) => r.record_id);
    expect(kept).toContain(situationId("bf-margin-band"));
    expect(kept).not.toContain(situationId("bf-deep-past"));

    const after = await readBackfill(sql, {
      after: base,
      tier: 1,
      now: NOW,
      archiveUrl: ARCHIVE_URL,
      limit: 500,
    });
    expect(after.beyondWindow).toBe(true);
    expect(after.archiveUrl).toEqual(ARCHIVE_FILES);
  }, 30_000);
});
