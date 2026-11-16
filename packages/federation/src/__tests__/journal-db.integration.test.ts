/**
 * The journal's epoch against a real database: when a boot keeps the epoch,
 * when it starts a new one (and what that empties and resets), that two
 * callers start one, and how long the fence holds back committed entries
 * while another session's write transaction is open.
 */
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  advanceJournalSeenXid,
  ensureJournalEpoch,
  readFenceHolder,
  readJournalLag,
} from "../journal.js";
import { readOutbox } from "../outbox.js";
import {
  incidentDraft,
  situationId,
  startDatabase,
  subscribe,
  writeOwn,
} from "./record-fixtures.integration.js";

let db: Awaited<ReturnType<typeof startDatabase>>;
let sql: postgres.Sql;

const NOW = "2026-10-01T10:10:00.000Z";

interface JournalState {
  epoch: string;
  seen_xid: string;
  timeline_id: number | null;
}

async function journal(): Promise<JournalState | undefined> {
  const [row] = await sql<JournalState[]>`
    SELECT epoch::text AS epoch, seen_xid::text AS seen_xid, timeline_id
      FROM conditions.federation_journal`;
  return row;
}

async function journalSize(): Promise<number> {
  const [{ count }] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM conditions.federation_outbox`;
  return count;
}

async function subscriptions() {
  return sql<{ id: string; cursor: string; revision: number }[]>`
    SELECT id, cursor, revision FROM conditions.federation_subscription ORDER BY id`;
}

/** One journal entry and a push cursor past it, so a new epoch has something to undo. */
async function journalSomething(local: string): Promise<void> {
  await writeOwn(sql, incidentDraft(local));
  await sql`UPDATE conditions.federation_subscription SET cursor = '5.1'`;
}

/** Burns a transaction id, as any write elsewhere does. */
async function burnXid(): Promise<void> {
  await sql`SELECT pg_current_xact_id()`;
}

beforeAll(async () => {
  db = await startDatabase();
  sql = db.sql;
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.federation_outbox CASCADE`;
  await sql`DELETE FROM conditions.federation_subscription`;
  await subscribe(sql, "all");
  // Each test starts from a settled journal of its own.
  await ensureJournalEpoch(sql, { now: NOW });
});

describe("ensureJournalEpoch", () => {
  it("finds the row the migration adopted the journal with", async () => {
    const row = await journal();
    expect(row?.epoch).toMatch(/^[0-9a-f-]{36}$/);
    expect(BigInt(row!.seen_xid)).toBeGreaterThan(0n);
  });

  it("keeps the epoch, the journal and the push cursors, and notes how far the ids got", async () => {
    await journalSomething("keep");
    const before = await journal();
    await burnXid();
    const lines: string[] = [];
    const kept = await ensureJournalEpoch(sql, { now: NOW, log: (line) => lines.push(line) });
    expect(kept).toEqual({ epoch: before!.epoch, started: false });
    expect(lines).toEqual([]);
    const after = await journal();
    expect(BigInt(after!.seen_xid)).toBeGreaterThan(BigInt(before!.seen_xid));
    expect(await journalSize()).toBe(1);
    expect((await subscriptions())[0]!.cursor).toBe("5.1");
  });

  it("starts a new epoch when the stored transaction id is ahead of the database", async () => {
    await journalSomething("ids-back");
    const before = await journal();
    const [held] = await subscriptions();
    await sql`UPDATE conditions.federation_journal SET seen_xid = '900000000000'::xid8`;
    const lines: string[] = [];
    const started = await ensureJournalEpoch(sql, { now: NOW, log: (line) => lines.push(line) });
    expect(started).toMatchObject({ started: true, reason: "transaction-ids-went-back" });
    expect(started.epoch).not.toBe(before!.epoch);
    expect(lines).toEqual([`journal epoch ${started.epoch} started: transaction-ids-went-back`]);
    expect(await journalSize()).toBe(0);
    expect(await subscriptions()).toEqual([
      { id: "all", cursor: "0.0", revision: held!.revision + 1 },
    ]);
    const after = await journal();
    expect(after!.epoch).toBe(started.epoch);
    expect(BigInt(after!.seen_xid)).toBeLessThan(900000000000n);
  });

  it("starts a new epoch when a journal entry is ahead of the database", async () => {
    await journalSomething("entry-ahead");
    await sql`
      INSERT INTO conditions.federation_outbox
        (operation, record_class, record_id, kind, domain, snapshot, txid)
      VALUES ('liveness', 'observation', 'some-source', 'liveness', 'roads',
              ${sql.json({ sourceId: "some-source", polledAt: NOW })}, '900000000000'::xid8)`;
    const started = await ensureJournalEpoch(sql, { now: NOW });
    expect(started).toMatchObject({ started: true, reason: "transaction-ids-went-back" });
    expect(await journalSize()).toBe(0);
    expect((await subscriptions())[0]!.cursor).toBe("0.0");
  });

  it("carries the delete entries into the new epoch, where a subscriber reading from the start is served them", async () => {
    await journalSomething("carried");
    const [carried] = await sql<{ seq: string }[]>`
      INSERT INTO conditions.federation_outbox
        (operation, record_class, record_id, kind, domain, tombstone_reason, revision,
         created_at, txid)
      VALUES ('delete', 'situation', ${situationId("gone")}, 'incident', 'roads',
              'rights_revoked', 4, '2026-09-30T08:00:00Z', '900000000000'::xid8)
      RETURNING seq::text AS seq`;
    const started = await ensureJournalEpoch(sql, { now: NOW });
    expect(started).toMatchObject({ started: true, reason: "transaction-ids-went-back" });
    const kept = await sql<
      {
        seq: string;
        operation: string;
        record_id: string;
        tombstone_reason: string;
        revision: number;
        created_at: Date;
        settled: boolean;
      }[]
    >`
      SELECT seq::text AS seq, operation, record_id, tombstone_reason, revision, created_at,
             txid < pg_snapshot_xmin(pg_current_snapshot()) AS settled
        FROM conditions.federation_outbox`;
    expect(kept).toEqual([
      {
        seq: carried!.seq,
        operation: "delete",
        record_id: situationId("gone"),
        tombstone_reason: "rights_revoked",
        revision: 4,
        created_at: new Date("2026-09-30T08:00:00Z"),
        settled: true,
      },
    ]);
    const page = await readOutbox(sql, { after: "0.0", now: NOW });
    expect(page.epoch).toBe(started.epoch);
    expect(page.orderedItems).toMatchObject([
      { operation: "delete", recordId: situationId("gone"), reason: "rights_revoked", revision: 4 },
    ]);
  });

  it("starts a new epoch when the operator deleted the row", async () => {
    await journalSomething("requested");
    await sql`DELETE FROM conditions.federation_journal`;
    const started = await ensureJournalEpoch(sql, { now: NOW });
    expect(started).toMatchObject({ started: true, reason: "requested" });
    expect((await journal())?.epoch).toBe(started.epoch);
    expect(await journalSize()).toBe(0);
    expect((await subscriptions())[0]!.cursor).toBe("0.0");
  });

  it("reads the timeline and starts a new epoch when it changed", async () => {
    const [{ timeline_id: timeline }] = await sql<{ timeline_id: number }[]>`
      SELECT timeline_id FROM pg_control_checkpoint()`;
    expect((await journal())!.timeline_id).toBe(timeline);

    await journalSomething("timeline");
    await sql`UPDATE conditions.federation_journal SET timeline_id = ${timeline + 1}`;
    const started = await ensureJournalEpoch(sql, { now: NOW });
    expect(started).toMatchObject({ started: true, reason: "timeline-changed" });
    expect((await journal())!.timeline_id).toBe(timeline);
    expect(await journalSize()).toBe(0);
  });

  it("goes on without the timeline under a role that may not read it", async () => {
    await sql.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oc_limited') THEN
          CREATE ROLE oc_limited LOGIN PASSWORD 'oc_limited';
        END IF;
      END $$`);
    const allowed = async () =>
      (
        await sql<{ allowed: boolean }[]>`
          SELECT has_function_privilege('oc_limited', 'pg_control_checkpoint()', 'EXECUTE')
            AS allowed`
      )[0]!.allowed;
    // Any role may read it by default; an operator may have revoked that.
    expect(await allowed()).toBe(true);
    await sql`REVOKE EXECUTE ON FUNCTION pg_control_checkpoint() FROM PUBLIC`;
    await sql`GRANT USAGE ON SCHEMA conditions TO oc_limited`;
    await sql`GRANT SELECT, UPDATE ON conditions.federation_journal TO oc_limited`;
    await sql`GRANT SELECT ON conditions.federation_outbox TO oc_limited`;
    expect(await allowed()).toBe(false);

    await sql`UPDATE conditions.federation_journal SET timeline_id = 4242`;
    const { host, port } = sql.options;
    const limited = postgres({
      host: host[0],
      port: port[0],
      database: "conditions_test",
      username: "oc_limited",
      password: "oc_limited",
      max: 1,
      onnotice: () => {},
    });
    try {
      const kept = await ensureJournalEpoch(limited, { now: NOW });
      expect(kept.started).toBe(false);
      expect((await journal())!.timeline_id).toBe(4242);
    } finally {
      await limited.end();
      await sql`GRANT EXECUTE ON FUNCTION pg_control_checkpoint() TO PUBLIC`;
      await sql`UPDATE conditions.federation_journal SET timeline_id = NULL`;
    }
  });

  it("starts one epoch for two callers at once", async () => {
    await sql`DELETE FROM conditions.federation_journal`;
    const results = await Promise.all([
      ensureJournalEpoch(sql, { now: NOW }),
      ensureJournalEpoch(sql, { now: NOW }),
    ]);
    expect(results.filter((r) => r.started)).toHaveLength(1);
    expect(results[0]!.epoch).toBe(results[1]!.epoch);
    expect((await journal())!.epoch).toBe(results[0]!.epoch);
  });
});

describe("advanceJournalSeenXid", () => {
  it("moves the stored id forward, and never back", async () => {
    const before = await journal();
    await burnXid();
    await advanceJournalSeenXid(sql);
    const advanced = await journal();
    expect(BigInt(advanced!.seen_xid)).toBeGreaterThan(BigInt(before!.seen_xid));

    await sql`UPDATE conditions.federation_journal SET seen_xid = '900000000000'::xid8`;
    await advanceJournalSeenXid(sql);
    expect((await journal())!.seen_xid).toBe("900000000000");
    await sql`UPDATE conditions.federation_journal SET seen_xid = ${advanced!.seen_xid}::xid8`;
  });
});

describe("readJournalLag", () => {
  it("reports how long an open write transaction holds committed entries back", async () => {
    const epoch = (await journal())!.epoch;
    expect(await readJournalLag(sql, NOW)).toEqual({ epoch, heldSince: null, lagSec: 0 });

    const holder = await sql.reserve();
    try {
      await holder`SET application_name = 'journal-lag-holder'`;
      await holder`BEGIN`;
      // A write, so the transaction has an id the fence waits for.
      await holder`SELECT pg_current_xact_id()`;
      await writeOwn(sql, incidentDraft("held-back"));

      const [{ created_at: createdAt }] = await sql<{ created_at: Date }[]>`
        SELECT created_at FROM conditions.federation_outbox
         WHERE record_id = ${situationId("held-back")}`;
      const later = new Date(createdAt.getTime() + 90_000).toISOString();
      const lag = await readJournalLag(sql, later);
      expect(lag).toEqual({ epoch, heldSince: createdAt.toISOString(), lagSec: 90 });
      const page = await readOutbox(sql, {});
      expect(page.orderedItems).toEqual([]);

      const fence = await readFenceHolder(sql);
      expect(fence?.applicationName).toBe("journal-lag-holder");
      expect(fence?.xactStart).not.toBeNull();
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }

    expect(await readJournalLag(sql, NOW)).toEqual({ epoch, heldSince: null, lagSec: 0 });
    const served = await readOutbox(sql, {});
    expect(served.orderedItems.map((e) => ("recordId" in e ? e.recordId : null))).toEqual([
      situationId("held-back"),
    ]);
  });
});
