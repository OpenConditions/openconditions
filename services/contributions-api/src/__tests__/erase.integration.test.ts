import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ERASURE_REASON, eraseRecord, isErased } from "../federation/tombstone.js";
import { createTestDatabase, registry, seedFeedSituation } from "./crowd-fixtures.integration.js";

type Rec = Record<string, unknown>;

const T0 = "2026-07-12T07:00:00.000Z";
const T1 = "2026-07-12T07:30:00.000Z";
const ERASED_AT = "2026-07-12T08:00:00.000Z";
const LATER = "2026-07-12T09:00:00.000Z";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;

interface JournalRow {
  operation: string;
  revision: number | null;
  tombstone_reason: string | null;
}

async function journal(recordId: string): Promise<JournalRow[]> {
  return sql<JournalRow[]>`
    SELECT operation, (snapshot ->> 'revision')::int AS revision, tombstone_reason
    FROM conditions.federation_outbox
    WHERE record_class = 'situation' AND record_id = ${recordId}
    ORDER BY seq`;
}

async function stored(id: string) {
  const [row] = await sql<
    {
      revision: number;
      tombstone_reason: string | null;
      tombstoned_at: Date | null;
      canonical_id: string;
      record: Rec;
    }[]
  >`
    SELECT revision, tombstone_reason, tombstoned_at, canonical_id, record
    FROM conditions.situation WHERE id = ${id}`;
  return row!;
}

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  // The outbox journals only for a subscriber; this one wants every class.
  await sql`
    INSERT INTO conditions.federation_subscription
      (id, peer_id, delivery_mode, created_at, updated_at)
    VALUES ('sub-erase', 'peer-erase', 'pull', now(), now())`;
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

describe("eraseRecord", () => {
  it("tombstones the record rights_revoked at a new revision and journals only its delete", async () => {
    const id = await seedFeedSituation(sql, "E1", {}, T0);
    await seedFeedSituation(
      sql,
      "E1",
      { headline: [{ lang: "de", text: "Gegenstand auf der Fahrbahn" }] },
      T1,
    );
    const bystander = await seedFeedSituation(sql, "E2", {}, T0);
    expect(await journal(id)).toEqual([
      { operation: "create", revision: 1, tombstone_reason: null },
      { operation: "update", revision: 2, tombstone_reason: null },
    ]);

    expect(await eraseRecord(sql, registry, { class: "situation", id }, ERASED_AT)).toBe("erased");

    const row = await stored(id);
    expect(row.revision).toBe(3);
    expect(row.tombstone_reason).toBe(ERASURE_REASON);
    expect(row.tombstoned_at?.toISOString()).toBe(ERASED_AT);
    expect(row.record["tombstone"]).toEqual({ reason: "rights_revoked", at: ERASED_AT });

    // The earlier snapshots are gone from the outbox; the delete stays to
    // carry the erasure to every peer.
    expect(await journal(id)).toEqual([
      { operation: "delete", revision: null, tombstone_reason: "rights_revoked" },
    ]);
    const [snapshots] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.federation_outbox
      WHERE record_id = ${id} AND snapshot IS NOT NULL`;
    expect(snapshots!.n).toBe(0);
    // Another record's entries are untouched.
    expect(await journal(bystander)).toEqual([
      { operation: "create", revision: 1, tombstone_reason: null },
    ]);
  }, 30_000);

  it("records the erasure fact of the record's canonical id", async () => {
    const id = "oc:situation:de-autobahn:E1";
    const { canonical_id } = await stored(id);
    const facts = await sql<{ reason: string; tombstoned_at: Date; expires_at: Date }[]>`
      SELECT reason, tombstoned_at, expires_at FROM conditions.federation_tombstone
      WHERE canonical_id = ${canonical_id}`;
    expect(facts).toHaveLength(1);
    expect(facts[0]!.reason).toBe("rights_revoked");
    expect(facts[0]!.tombstoned_at.toISOString()).toBe(ERASED_AT);
    expect(facts[0]!.expires_at.toISOString()).toBe("2026-08-11T08:00:00.000Z");
    expect(await isErased(sql, canonical_id, LATER)).toBe(true);
  }, 30_000);

  it("changes nothing when the record is already erased", async () => {
    const id = "oc:situation:de-autobahn:E1";
    expect(await eraseRecord(sql, registry, { class: "situation", id }, LATER)).toBe(
      "already erased",
    );
    const row = await stored(id);
    expect(row.revision).toBe(3);
    expect(row.tombstoned_at?.toISOString()).toBe(ERASED_AT);
    expect(await journal(id)).toHaveLength(1);
    const [fact] = await sql<{ tombstoned_at: Date }[]>`
      SELECT tombstoned_at FROM conditions.federation_tombstone
      WHERE canonical_id = ${row.canonical_id}`;
    expect(fact!.tombstoned_at.toISOString()).toBe(ERASED_AT);
  }, 30_000);

  it("erases a record already tombstoned for another reason", async () => {
    const id = await seedFeedSituation(sql, "E3", {}, T0);
    await sql`
      UPDATE conditions.situation
      SET tombstone_reason = 'withdrawn', tombstoned_at = ${T1}::timestamptz,
          revision = revision + 1,
          record = record || jsonb_build_object(
            'tombstone', jsonb_build_object('reason', 'withdrawn', 'at', ${T1}::text),
            'revision', revision + 1)
      WHERE id = ${id}`;
    expect((await journal(id)).map((e) => e.operation)).toEqual(["create", "delete"]);

    expect(await eraseRecord(sql, registry, { class: "situation", id }, ERASED_AT)).toBe("erased");
    expect((await stored(id)).tombstone_reason).toBe(ERASURE_REASON);
    // The withdrawn delete stays (it carries no content); the erasure adds its own.
    expect(await journal(id)).toEqual([
      { operation: "delete", revision: null, tombstone_reason: "withdrawn" },
      { operation: "delete", revision: null, tombstone_reason: "rights_revoked" },
    ]);
  }, 30_000);

  it("answers not found for a record this instance does not hold", async () => {
    const ref = { class: "situation" as const, id: "oc:situation:de-autobahn:missing" };
    expect(await eraseRecord(sql, registry, ref, ERASED_AT)).toBe("not found");
    const [facts] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.federation_tombstone`;
    expect(facts!.n).toBe(2);
  }, 30_000);

  it("purges and retracts a journalled record after its subscriber left", async () => {
    const id = await seedFeedSituation(sql, "E4", {}, T0);
    expect(await journal(id)).toHaveLength(1);
    await sql`DELETE FROM conditions.federation_subscription`;

    expect(await eraseRecord(sql, registry, { class: "situation", id }, ERASED_AT)).toBe("erased");

    // The outbox and backfill serve without a subscription, so the snapshot
    // must go and the retraction must reach peers that pulled it.
    expect(await journal(id)).toEqual([
      { operation: "delete", revision: null, tombstone_reason: "rights_revoked" },
    ]);
  }, 30_000);

  it("journals no tombstone of a record never journalled while nobody subscribes", async () => {
    const id = await seedFeedSituation(sql, "E5", {}, T0);
    expect(await eraseRecord(sql, registry, { class: "situation", id }, ERASED_AT)).toBe("erased");
    expect(await journal(id)).toEqual([]);
  }, 30_000);
});
