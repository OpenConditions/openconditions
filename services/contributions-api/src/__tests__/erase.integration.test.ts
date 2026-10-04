import { readFileSync } from "node:fs";
import path from "node:path";
import { buildRegistry } from "@openconditions/model";
import { productionModules } from "@openconditions/model-registry";
import { writeSnapshot } from "@openconditions/storage";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ERASURE_REASON, eraseRecord, isErased } from "../federation/tombstone.js";
import {
  createTestDatabase,
  INSTANCE,
  registry,
  seedFeedSituation,
} from "./crowd-fixtures.integration.js";

type Rec = Record<string, unknown>;

/** The ministry's fuel stations from the facilities golden records (MINETUR, CC BY 4.0). */
const facilityRegistry = buildRegistry(productionModules);
/** A golden record as the draft it was sealed from: sealing adds only these fields. */
const goldenFeature = (id: string): Rec => {
  const {
    canonicalId: _canonical,
    domain: _domain,
    revision: _revision,
    recordedAt: _recorded,
    contentHash: _hash,
    ...draft
  } = (
    JSON.parse(
      readFileSync(
        path.resolve(
          import.meta.dirname,
          "../../../../packages/model-registry/src/__tests__/golden/facilities.json",
        ),
        "utf8",
      ),
    ) as Rec[]
  ).find((r) => r["id"] === id)!;
  const { instanceId: _instance, ...provenance } = draft["provenance"] as Rec;
  return { ...draft, provenance };
};

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

async function history(id: string): Promise<number[]> {
  const rows = await sql<{ revision: number }[]>`
    SELECT revision FROM conditions.situation_revision WHERE situation_id = ${id} ORDER BY revision`;
  return rows.map((r) => r.revision);
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

    expect(await history(id)).toEqual([1, 2]);
    expect(await eraseRecord(sql, registry, { class: "situation", id }, ERASED_AT)).toBe("erased");

    const row = await stored(id);
    expect(row.revision).toBe(3);
    // No revision of the record keeps its content; another record's history stays.
    expect(await history(id)).toEqual([]);
    expect(await history(bystander)).toEqual([1]);
    expect(row.tombstone_reason).toBe(ERASURE_REASON);
    expect(row.tombstoned_at?.toISOString()).toBe(ERASED_AT);
    expect(row.record["tombstone"]).toEqual({ reason: "rights_revoked", at: ERASED_AT });
    // The row keeps who and what it was, nothing of what it said or where.
    for (const key of ["headline", "description", "location", "effects", "validity", "details"]) {
      expect(row.record, key).not.toHaveProperty(key);
    }
    expect(row.record["id"]).toBe(id);
    const [{ geom }] = await sql`SELECT geom FROM conditions.situation WHERE id = ${id}`;
    expect(geom).toBeNull();

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
    const id = "oc:situation:de-autobahn-events:E1";
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
    const id = "oc:situation:de-autobahn-events:E1";
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
    const ref = { class: "situation" as const, id: "oc:situation:de-autobahn-events:missing" };
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

  it("takes an erased feature out of the canonical feature it was linked into", async () => {
    const station = goldenFeature("oc:feature:es-minetur-fuel:3119");
    const twin = {
      ...station,
      id: "oc:feature:es-fuel-test:3119",
      provenance: { ...(station["provenance"] as Rec), sourceId: "es-fuel-test" },
    };
    const write = (source: string, feature: Rec) =>
      writeSnapshot(
        sql,
        source,
        { features: [feature] },
        { registry: facilityRegistry, instanceId: INSTANCE, now: T0, complete: false },
      );
    await write("es-minetur-fuel", station);
    await write("es-fuel-test", twin);
    const membersOf = async (id: string) =>
      (
        await sql<{ member_ids: string[] }[]>`
          SELECT member_ids FROM conditions.feature_canonical WHERE ${id} = ANY(member_ids)`
      )[0]?.member_ids;
    expect(await membersOf(twin.id)).toEqual([twin.id, station["id"]]);

    expect(
      await eraseRecord(
        sql,
        facilityRegistry,
        { class: "feature", id: twin.id },
        ERASED_AT,
        INSTANCE,
      ),
    ).toBe("erased");

    expect(await membersOf(station["id"] as string)).toEqual([station["id"]]);
    expect(await membersOf(twin.id)).toBeUndefined();
  }, 60_000);
});
