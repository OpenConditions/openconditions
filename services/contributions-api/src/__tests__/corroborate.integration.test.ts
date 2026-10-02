import type { ReporterKey } from "@openconditions/contrib-core";
import { tombstoneRecords } from "@openconditions/storage";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyCorroboration, resolveSurvivors } from "../evidence/corroborate.js";
import {
  createTestDatabase,
  enrolledKey,
  evidenceOf,
  landAs,
  registry,
  situationClaim,
} from "./crowd-fixtures.integration.js";

const T_EARLY = "2026-07-12T08:00:00.000Z";
const T_LATE = "2026-07-12T08:04:00.000Z";
const T_MERGE = "2026-07-12T08:10:00.000Z";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
let alice: ReporterKey;
let bob: ReporterKey;
let carol: ReporterKey;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
}, 180_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.report_evidence, conditions.reporter CASCADE`;
  [alice, bob, carol] = await Promise.all([
    enrolledKey(sql, T_EARLY),
    enrolledKey(sql, T_EARLY),
    enrolledKey(sql, T_EARLY),
  ]);
});

/** Lands `key`'s obstruction report, made and received at `at`. */
async function report(key: ReporterKey, at: string, nonce = "nonce-000000000001"): Promise<string> {
  const landed = await landAs(sql, key, situationClaim({ reportedAt: at, nonce }), at);
  return landed.record.id;
}

interface ConfirmRow {
  actor_key_id: string | null;
  source_id: string | null;
  occurred_at: Date;
  details: { via?: string; merged?: string } | null;
}

async function confirmsOf(id: string): Promise<ConfirmRow[]> {
  return sql<ConfirmRow[]>`
    SELECT actor_key_id, source_id, occurred_at, details FROM conditions.report_evidence
    WHERE record_class = 'situation' AND record_id = ${id} AND evidence_kind = 'confirm'
    ORDER BY occurred_at, id`;
}

/** Marks `merged` superseded by `survivor` by hand: a tombstone plus a lineage confirm. */
async function linkSuperseded(survivor: string, merged: string): Promise<void> {
  await sql`
    UPDATE conditions.situation
    SET tombstone_reason = 'superseded', tombstoned_at = ${T_MERGE}
    WHERE id = ${merged}`;
  await sql`
    INSERT INTO conditions.report_evidence
      (record_class, record_id, evidence_kind, actor_key_id, occurred_at, details)
    VALUES ('situation', ${survivor}, 'confirm', NULL, ${T_MERGE},
            ${sql.json({ via: "phenomenon-match", merged })})`;
}

describe("applyCorroboration", () => {
  it("credits the earlier report with the later one's witness and supersedes the later (never routing)", async () => {
    const early = await report(alice, T_EARLY);
    const late = await report(bob, T_LATE);

    await applyCorroboration(sql, registry, late, early, T_MERGE);

    const confirms = await confirmsOf(early);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatchObject({
      actor_key_id: bob.keyId,
      source_id: "crowd",
      details: { via: "phenomenon-match", merged: late },
    });
    // Dated when the merged report landed, not when the merge ran.
    expect(confirms[0]!.occurred_at.toISOString()).toBe(T_LATE);

    expect(await evidenceOf(sql, early)).toMatchObject({
      evidence_state: "corroborated",
      corroborations: 1,
      routing_eligible: false,
      tombstone_reason: null,
    });
    expect(await evidenceOf(sql, late)).toMatchObject({ tombstone_reason: "superseded" });
  }, 30_000);

  it("is COMMUTATIVE: the earlier report survives regardless of argument order", async () => {
    for (const reversed of [false, true]) {
      await sql`TRUNCATE conditions.situation, conditions.report_evidence CASCADE`;
      const early = await report(alice, T_EARLY);
      const late = await report(bob, T_LATE);

      const [first, second] = reversed ? [early, late] : [late, early];
      await applyCorroboration(sql, registry, first, second, T_MERGE);

      expect(await evidenceOf(sql, early)).toMatchObject({
        evidence_state: "corroborated",
        routing_eligible: false,
        tombstone_reason: null,
      });
      expect(await evidenceOf(sql, late)).toMatchObject({ tombstone_reason: "superseded" });
      expect(await confirmsOf(early)).toHaveLength(1);
    }
  }, 30_000);

  it("breaks a tie on validity.start by the smaller id", async () => {
    const a = await report(alice, T_EARLY);
    const b = await report(bob, T_EARLY);
    const [smaller, larger] = a < b ? [a, b] : [b, a];

    await applyCorroboration(sql, registry, smaller, larger, T_MERGE);

    expect(await evidenceOf(sql, smaller)).toMatchObject({ tombstone_reason: null });
    expect(await evidenceOf(sql, larger)).toMatchObject({ tombstone_reason: "superseded" });
  }, 30_000);

  it("carries the merged report's own confirmations to the survivor", async () => {
    const early = await report(alice, T_EARLY);
    const late = await report(bob, T_LATE);
    // carol had already confirmed the later report.
    await sql`
      INSERT INTO conditions.report_evidence
        (record_class, record_id, evidence_kind, actor_key_id, occurred_at, details)
      VALUES ('situation', ${late}, 'confirm', ${carol.keyId}, '2026-07-12T08:05:00.000Z',
              '{}'::jsonb)`;

    await applyCorroboration(sql, registry, late, early, T_MERGE);

    const actors = (await confirmsOf(early)).map((c) => c.actor_key_id);
    expect(actors).toEqual([bob.keyId, carol.keyId]);
    expect(await evidenceOf(sql, early)).toMatchObject({ corroborations: 2 });
  }, 30_000);

  it("concurrent cross-race corroboration converges on ONE survivor, never annihilates", async () => {
    const a = await report(alice, T_EARLY);
    const b = await report(bob, T_LATE);

    // Both landing hooks fire at once, each merging "self onto the other".
    await Promise.all([
      applyCorroboration(sql, registry, a, b, T_MERGE),
      applyCorroboration(sql, registry, b, a, T_MERGE),
    ]);

    expect(await evidenceOf(sql, a)).toMatchObject({
      tombstone_reason: null,
      evidence_state: "corroborated",
      routing_eligible: false,
      corroborations: 1,
    });
    expect(await evidenceOf(sql, b)).toMatchObject({ tombstone_reason: "superseded" });
    expect(await confirmsOf(a)).toHaveLength(1);
  }, 30_000);

  it("is idempotent under a concurrent double-call: one confirm row", async () => {
    const early = await report(alice, T_EARLY);
    const late = await report(bob, T_LATE);

    await Promise.all([
      applyCorroboration(sql, registry, late, early, T_MERGE),
      applyCorroboration(sql, registry, late, early, T_MERGE),
    ]);

    expect(await confirmsOf(early)).toHaveLength(1);
    expect(await evidenceOf(sql, early)).toMatchObject({
      evidence_state: "corroborated",
      corroborations: 1,
    });
  }, 30_000);

  it("does nothing when either report is already tombstoned", async () => {
    const early = await report(alice, T_EARLY);
    const late = await report(bob, T_LATE);
    await tombstoneRecords(sql, "situation", [early], "rejected", { registry, now: T_LATE });

    await applyCorroboration(sql, registry, late, early, T_MERGE);

    expect(await confirmsOf(early)).toHaveLength(0);
    expect(await evidenceOf(sql, late)).toMatchObject({ tombstone_reason: null });
  }, 30_000);

  it("throws a TypeError when a report would corroborate itself", async () => {
    await expect(
      applyCorroboration(sql, registry, "oc:situation:same", "oc:situation:same", T_MERGE),
    ).rejects.toThrow(TypeError);
  }, 30_000);

  it("throws when either situation is missing", async () => {
    const present = await report(alice, T_EARLY);
    await expect(
      applyCorroboration(sql, registry, "oc:situation:absent", present, T_MERGE),
    ).rejects.toThrow(/does not exist/);
    await expect(
      applyCorroboration(sql, registry, present, "oc:situation:absent", T_MERGE),
    ).rejects.toThrow(/does not exist/);
  }, 30_000);
});

describe("resolveSurvivors", () => {
  it("resolves a live report to itself and a superseded one to its survivor", async () => {
    const early = await report(alice, T_EARLY);
    const late = await report(bob, T_LATE);
    await applyCorroboration(sql, registry, late, early, T_MERGE);

    expect(await resolveSurvivors(sql, [early, late])).toEqual(
      new Map([
        [early, early],
        [late, early],
      ]),
    );
  }, 30_000);

  it("ends a merged chain at the earliest live head after a just-landed earlier report takes over", async () => {
    const a = await report(alice, "2026-07-12T08:02:00.000Z");
    const b = await report(bob, T_LATE);
    await applyCorroboration(sql, registry, b, a, T_MERGE);
    const z = await report(carol, T_EARLY);
    await applyCorroboration(sql, registry, z, a, T_MERGE);

    expect(await evidenceOf(sql, a)).toMatchObject({ tombstone_reason: "superseded" });
    expect(await resolveSurvivors(sql, [a, b])).toEqual(
      new Map([
        [a, z],
        [b, z],
      ]),
    );
  }, 30_000);

  it("walks a multi-level lineage (B→A→Z) hop by hop", async () => {
    const z = await report(alice, T_EARLY);
    const a = await report(bob, "2026-07-12T08:02:00.000Z");
    const b = await report(carol, T_LATE);
    await linkSuperseded(a, b);
    await linkSuperseded(z, a);

    expect((await resolveSurvivors(sql, [b])).get(b)).toBe(z);
  }, 30_000);

  it("returns null when the chain ends in a report tombstoned for another reason", async () => {
    const early = await report(alice, T_EARLY);
    const late = await report(bob, T_LATE);
    await applyCorroboration(sql, registry, late, early, T_MERGE);
    await tombstoneRecords(sql, "situation", [early], "rejected", { registry, now: T_MERGE });

    expect((await resolveSurvivors(sql, [late])).get(late)).toBeNull();
    expect((await resolveSurvivors(sql, [early])).get(early)).toBeNull();
  }, 30_000);

  it("returns null (no hang) for a looping lineage", async () => {
    const x = await report(alice, T_EARLY);
    const y = await report(bob, T_LATE);
    await linkSuperseded(x, y);
    await linkSuperseded(y, x);

    expect((await resolveSurvivors(sql, [x])).get(x)).toBeNull();
  }, 30_000);

  it("returns null for a non-existent situation", async () => {
    expect(await resolveSurvivors(sql, ["oc:situation:nope"])).toEqual(
      new Map([["oc:situation:nope", null]]),
    );
  }, 30_000);
});
