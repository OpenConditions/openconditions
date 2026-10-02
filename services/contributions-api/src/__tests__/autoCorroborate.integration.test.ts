import type { ReporterKey } from "@openconditions/contrib-core";
import { tombstoneRecords } from "@openconditions/storage";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { autoCorroborateOnLanding } from "../evidence/autoCorroborate.js";
import {
  createTestDatabase,
  enrolledKey,
  evidenceOf,
  landAs,
  registry,
  seedFeedSituation,
  seedPeerCrowdReport,
  situationClaim,
} from "./crowd-fixtures.integration.js";

const M_PER_DEG = 111_320;
const LON = 8.4;
const LAT = 49;

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
}, 180_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.report_evidence, conditions.reporter CASCADE`;
});

/** Latitude `metres` north of the base point. */
function north(metres: number): number {
  return LAT + metres / M_PER_DEG;
}

interface Witness {
  key?: ReporterKey;
  lat?: number;
  lon?: number;
  at: string;
  type?: string;
  nonce?: string;
}

/** Lands a crowd report made and received at `at`, by a fresh reporter unless one is given. */
async function witness(opts: Witness): Promise<{ id: string; key: ReporterKey }> {
  const key = opts.key ?? (await enrolledKey(sql, opts.at));
  const landed = await landAs(
    sql,
    key,
    situationClaim({
      reportedAt: opts.at,
      geometry: { type: "Point", coordinates: [opts.lon ?? LON, opts.lat ?? LAT] },
      ...(opts.type === undefined ? {} : { type: opts.type }),
      ...(opts.nonce === undefined ? {} : { nonce: opts.nonce }),
    }),
    opts.at,
  );
  return { id: landed.record.id, key };
}

async function confirmers(id: string): Promise<string[]> {
  const rows = await sql<{ actor_key_id: string }[]>`
    SELECT DISTINCT actor_key_id FROM conditions.report_evidence
    WHERE record_class = 'situation' AND record_id = ${id} AND evidence_kind = 'confirm'
      AND actor_key_id IS NOT NULL`;
  return rows.map((r) => r.actor_key_id).sort();
}

async function confirmRowCount(id: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM conditions.report_evidence
    WHERE record_class = 'situation' AND record_id = ${id} AND evidence_kind = 'confirm'`;
  return row!.n;
}

async function posterior(key: ReporterKey): Promise<{ alpha: number; beta: number }> {
  const [row] = await sql<{ reputation_alpha: number; reputation_beta: number }[]>`
    SELECT reputation_alpha, reputation_beta FROM conditions.reporter WHERE key_id = ${key.keyId}`;
  return { alpha: row!.reputation_alpha, beta: row!.reputation_beta };
}

async function confidence(id: string): Promise<number | null> {
  const [row] = await sql<{ confidence_score: number | null }[]>`
    SELECT confidence_score FROM conditions.situation WHERE id = ${id}`;
  return row!.confidence_score;
}

describe("autoCorroborateOnLanding — direct matches", () => {
  it("merges an independent report of the same phenomenon into the earlier one, never routing", async () => {
    const a = await witness({ at: "2026-07-12T08:00:00.000Z" });
    const b = await witness({ at: "2026-07-12T08:02:00.000Z", lon: LON + 0.0001 });

    expect(await autoCorroborateOnLanding(sql, registry, b.id, "2026-07-12T08:02:30.000Z")).toEqual(
      [a.id],
    );
    expect(await evidenceOf(sql, a.id)).toMatchObject({
      evidence_state: "corroborated",
      corroborations: 1,
      routing_eligible: false,
      tombstone_reason: null,
    });
    expect(await evidenceOf(sql, b.id)).toMatchObject({ tombstone_reason: "superseded" });
  }, 60_000);

  it("merges a report made earlier but uploaded later into the one made after it", async () => {
    const later = await witness({ at: "2026-07-12T08:05:00.000Z" });
    const offline = await witness({ at: "2026-07-12T08:00:00.000Z", lon: LON + 0.0001 });

    expect(
      await autoCorroborateOnLanding(sql, registry, offline.id, "2026-07-12T08:06:00.000Z"),
    ).toEqual([later.id]);
    expect(await evidenceOf(sql, offline.id)).toMatchObject({
      evidence_state: "corroborated",
      tombstone_reason: null,
    });
    expect(await evidenceOf(sql, later.id)).toMatchObject({ tombstone_reason: "superseded" });
  }, 60_000);

  it("leaves a report alone when nothing nearby agrees: another type or too far", async () => {
    await witness({ at: "2026-07-12T08:00:00.000Z", type: "breakdown" });
    await witness({ at: "2026-07-12T08:00:00.000Z", lat: north(300) });
    const lander = await witness({ at: "2026-07-12T08:03:00.000Z" });

    expect(
      await autoCorroborateOnLanding(sql, registry, lander.id, "2026-07-12T08:05:30.000Z"),
    ).toEqual([]);
    expect(await evidenceOf(sql, lander.id)).toMatchObject({
      evidence_state: "self_reported",
      tombstone_reason: null,
    });
  }, 60_000);

  it("never treats a reporter's second report as an independent witness", async () => {
    const first = await witness({ at: "2026-07-12T08:00:00.000Z" });
    const second = await witness({
      key: first.key,
      at: "2026-07-12T08:02:00.000Z",
      nonce: "nonce-000000000002",
    });

    expect(
      await autoCorroborateOnLanding(sql, registry, second.id, "2026-07-12T08:02:30.000Z"),
    ).toEqual([]);
    expect(await confirmRowCount(first.id)).toBe(0);
  }, 60_000);

  it("never takes a peer's keyless crowd report as a witness", async () => {
    await seedPeerCrowdReport(sql, "peer-witness", [LON, LAT], "2026-07-12T08:00:00.000Z");
    const lander = await witness({ at: "2026-07-12T08:01:00.000Z" });

    expect(
      await autoCorroborateOnLanding(sql, registry, lander.id, "2026-07-12T08:01:30.000Z"),
    ).toEqual([]);
    expect(await evidenceOf(sql, lander.id)).toMatchObject({ tombstone_reason: null });
  }, 60_000);

  it("never merges a peer's keyless crowd report that lands after a local one", async () => {
    const local = await witness({ at: "2026-07-12T08:00:00.000Z" });
    const peerId = await seedPeerCrowdReport(
      sql,
      "peer-late",
      [LON, LAT],
      "2026-07-12T07:59:00.000Z",
    );

    expect(
      await autoCorroborateOnLanding(sql, registry, peerId, "2026-07-12T08:01:30.000Z"),
    ).toEqual([]);
    expect(await evidenceOf(sql, local.id)).toMatchObject({ tombstone_reason: null });
    expect(await evidenceOf(sql, peerId)).toMatchObject({ tombstone_reason: null });
  }, 60_000);

  it("keeps a FLAGGED landing a distinct report for review", async () => {
    const a = await witness({ at: "2026-07-12T08:00:00.000Z" });
    const b = await witness({ at: "2026-07-12T08:02:00.000Z" });
    await sql`UPDATE conditions.situation SET flagged_at = '2026-07-12T08:02:00Z' WHERE id = ${b.id}`;

    expect(await autoCorroborateOnLanding(sql, registry, b.id, "2026-07-12T08:02:30.000Z")).toEqual(
      [],
    );
    expect(await confirmRowCount(a.id)).toBe(0);
    expect(await evidenceOf(sql, b.id)).toMatchObject({ tombstone_reason: null });
  }, 60_000);

  it("never corroborates onto a report tombstoned for another reason", async () => {
    const rejected = await witness({ at: "2026-07-12T08:00:00.000Z" });
    await tombstoneRecords(sql, "situation", [rejected.id], "rejected", {
      registry,
      now: "2026-07-12T08:01:00.000Z",
    });
    const lander = await witness({ at: "2026-07-12T08:02:00.000Z", lon: LON + 0.0001 });

    expect(
      await autoCorroborateOnLanding(sql, registry, lander.id, "2026-07-12T08:02:30.000Z"),
    ).toEqual([]);
    expect(await confirmRowCount(rejected.id)).toBe(0);
    expect(await evidenceOf(sql, lander.id)).toMatchObject({ evidence_state: "self_reported" });
  }, 60_000);

  it("returns [] for a missing situation and for a feed-origin or superseded target", async () => {
    expect(
      await autoCorroborateOnLanding(sql, registry, "oc:situation:nope", "2026-07-12T08:00:00Z"),
    ).toEqual([]);
    const a = await witness({ at: "2026-07-12T08:00:00.000Z" });
    const b = await witness({ at: "2026-07-12T08:02:00.000Z" });
    await autoCorroborateOnLanding(sql, registry, b.id, "2026-07-12T08:02:30.000Z");
    expect(await autoCorroborateOnLanding(sql, registry, b.id, "2026-07-12T08:03:00.000Z")).toEqual(
      [],
    );
    expect(await confirmRowCount(a.id)).toBe(1);
    const feed = await seedFeedSituation(sql, "auto-feed");
    expect(await autoCorroborateOnLanding(sql, registry, feed, "2026-07-12T08:03:00.000Z")).toEqual(
      [],
    );
    expect(await confirmRowCount(a.id)).toBe(1);
  }, 60_000);
});

describe("autoCorroborateOnLanding — corroboration-chain re-crediting", () => {
  it("redirects a 3rd witness near a MERGED report to its live survivor — never routing, never training", async () => {
    const a = await witness({ at: "2026-07-12T08:00:00.000Z" });
    const b = await witness({ at: "2026-07-12T08:02:00.000Z", lat: north(150) });
    await autoCorroborateOnLanding(sql, registry, b.id, "2026-07-12T08:02:30.000Z");
    expect(await evidenceOf(sql, b.id)).toMatchObject({ tombstone_reason: "superseded" });

    const c = await witness({ at: "2026-07-12T08:03:00.000Z", lat: north(230) });
    expect(await autoCorroborateOnLanding(sql, registry, c.id, "2026-07-12T08:03:30.000Z")).toEqual(
      [a.id],
    );

    expect(await evidenceOf(sql, a.id)).toMatchObject({
      tombstone_reason: null,
      evidence_state: "corroborated",
      corroborations: 2,
      routing_eligible: false,
    });
    expect(await evidenceOf(sql, c.id)).toMatchObject({ tombstone_reason: "superseded" });
    expect(await confirmers(a.id)).toEqual([b.key.keyId, c.key.keyId].sort());
    // Two confirmers under the asymmetric model: 0.3 + (0.75 - 0.3) * (1 - 0.5^2).
    expect(await confidence(a.id)).toBeCloseTo(0.6375, 4);

    // Corroboration never trains reputation.
    for (const key of [a.key, b.key, c.key]) {
      expect(await posterior(key)).toEqual({ alpha: 2, beta: 2 });
    }
  }, 60_000);

  it("leaves a 3rd witness its own report when only the merged one, not the survivor, is in reach", async () => {
    const a = await witness({ at: "2026-07-12T08:00:00.000Z" });
    const b = await witness({ at: "2026-07-12T08:02:00.000Z", lat: north(150) });
    await autoCorroborateOnLanding(sql, registry, b.id, "2026-07-12T08:02:30.000Z");

    const c = await witness({ at: "2026-07-12T08:03:00.000Z", lat: north(320) });
    expect(await autoCorroborateOnLanding(sql, registry, c.id, "2026-07-12T08:03:30.000Z")).toEqual(
      [],
    );
    expect(await confirmers(a.id)).toEqual([b.key.keyId]);
    expect(await evidenceOf(sql, c.id)).toMatchObject({ tombstone_reason: null });
  }, 60_000);

  it("credits the survivor ONCE when the 3rd witness neighbours both the merged report and the survivor", async () => {
    const a = await witness({ at: "2026-07-12T08:00:00.000Z" });
    const b = await witness({ at: "2026-07-12T08:02:00.000Z", lat: north(60) });
    await autoCorroborateOnLanding(sql, registry, b.id, "2026-07-12T08:02:30.000Z");

    const c = await witness({ at: "2026-07-12T08:03:00.000Z", lat: north(30) });
    expect(await autoCorroborateOnLanding(sql, registry, c.id, "2026-07-12T08:03:30.000Z")).toEqual(
      [a.id],
    );
    expect(await confirmRowCount(a.id)).toBe(2);
    expect(await confirmers(a.id)).toHaveLength(2);
  }, 60_000);

  it("does NOT corroborate onto a FLAGGED survivor reached through the merged chain", async () => {
    const a = await witness({ at: "2026-07-12T08:00:00.000Z" });
    const b = await witness({ at: "2026-07-12T08:02:00.000Z", lat: north(150) });
    await autoCorroborateOnLanding(sql, registry, b.id, "2026-07-12T08:02:30.000Z");
    await sql`UPDATE conditions.situation SET flagged_at = '2026-07-12T08:02:45Z' WHERE id = ${a.id}`;

    const c = await witness({ at: "2026-07-12T08:03:00.000Z", lat: north(230) });
    expect(await autoCorroborateOnLanding(sql, registry, c.id, "2026-07-12T08:03:30.000Z")).toEqual(
      [],
    );
    expect(await confirmers(a.id)).toEqual([b.key.keyId]);
    expect(await evidenceOf(sql, c.id)).toMatchObject({ tombstone_reason: null });
  }, 60_000);

  it("FAN-IN: a survivor with two merges credits a 3rd witness reaching it through either exactly once", async () => {
    const a = await witness({ at: "2026-07-12T08:00:00.000Z" });
    const b = await witness({ at: "2026-07-12T08:02:00.000Z", lat: north(150) });
    await autoCorroborateOnLanding(sql, registry, b.id, "2026-07-12T08:02:30.000Z");
    const d = await witness({ at: "2026-07-12T08:03:00.000Z", lat: north(130) });
    await autoCorroborateOnLanding(sql, registry, d.id, "2026-07-12T08:03:30.000Z");
    expect(await evidenceOf(sql, b.id)).toMatchObject({ tombstone_reason: "superseded" });
    expect(await evidenceOf(sql, d.id)).toMatchObject({ tombstone_reason: "superseded" });

    const c = await witness({ at: "2026-07-12T08:04:00.000Z", lat: north(230) });
    expect(await autoCorroborateOnLanding(sql, registry, c.id, "2026-07-12T08:04:30.000Z")).toEqual(
      [a.id],
    );

    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.report_evidence
      WHERE record_id = ${a.id} AND evidence_kind = 'confirm' AND details ->> 'merged' = ${c.id}`;
    expect(n).toBe(1);
    expect(await confirmers(a.id)).toHaveLength(3);
    expect(await evidenceOf(sql, a.id)).toMatchObject({
      corroborations: 3,
      routing_eligible: false,
    });
  }, 60_000);

  it("a witness made at the head's instant converges on one head holding every witness", async () => {
    const a = await witness({ at: "2026-07-12T08:00:00.000Z" });
    const b = await witness({ at: "2026-07-12T08:02:00.000Z", lon: LON + 0.0001 });
    await autoCorroborateOnLanding(sql, registry, b.id, "2026-07-12T08:02:30.000Z");

    // Made at a's instant, uploaded later: the id order picks the head, and
    // whichever wins holds both other witnesses (no split brain).
    const c = await witness({ at: "2026-07-12T08:00:00.000Z", lon: LON - 0.0001 });
    await autoCorroborateOnLanding(sql, registry, c.id, "2026-07-12T08:08:00.000Z");

    const head = a.id < c.id ? a : c;
    const merged = head === a ? c : a;
    expect(await evidenceOf(sql, merged.id)).toMatchObject({ tombstone_reason: "superseded" });
    expect(await evidenceOf(sql, head.id)).toMatchObject({
      tombstone_reason: null,
      evidence_state: "corroborated",
      corroborations: 2,
      routing_eligible: false,
    });
    expect(await confidence(head.id)).toBeCloseTo(0.6375, 4);
    for (const key of [a.key, b.key, c.key]) {
      expect(await posterior(key)).toEqual({ alpha: 2, beta: 2 });
    }
  }, 60_000);
});

describe("batched neighbourhood reads", () => {
  it.each([
    [10, false],
    [100, false],
    [10, true],
    [100, true],
  ] as const)(
    "bounds reads for %i neighbours (superseded=%s)",
    async (size, superseded) => {
      const head = await seedPeerCrowdReport(sql, "batch-head");
      for (let i = 0; i < size; i++) {
        const id = await seedPeerCrowdReport(sql, `batch-${i}`);
        if (superseded) {
          await sql`
          UPDATE conditions.situation
          SET tombstone_reason = 'superseded', tombstoned_at = '2026-07-12T08:00:00Z'
          WHERE id = ${id}`;
          await sql`
          INSERT INTO conditions.report_evidence
            (record_class, record_id, evidence_kind, actor_key_id, occurred_at, details)
          VALUES ('situation', ${head}, 'confirm', NULL, '2026-07-12T08:00:00Z',
                  ${sql.json({ via: "phenomenon-match", merged: id })})`;
        }
      }
      const target = await witness({ at: "2026-07-12T08:00:30.000Z" });

      let queries = 0;
      const counted = postgres(db.url, { max: 2, onnotice: () => {}, debug: () => queries++ });
      try {
        expect(
          await autoCorroborateOnLanding(counted, registry, target.id, "2026-07-12T08:01:00.000Z"),
        ).toEqual([]);
      } finally {
        await counted.end();
      }
      expect(queries).toBeGreaterThan(0);
      expect(queries).toBeLessThanOrEqual(12);
    },
    120_000,
  );
});
