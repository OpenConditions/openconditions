import { generateReporterKey, type ReporterKey } from "@openconditions/contrib-core";
import { crowdRulesFor } from "@openconditions/model";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { autoCorroborateOnLanding } from "../evidence/autoCorroborate.js";
import { resolveSurvivors } from "../evidence/corroborate.js";
import { crossValidateAgainstFeeds } from "../evidence/crossValidate.js";
import {
  createTestDatabase,
  enrollDirect,
  evidenceOf,
  feedSituationDraft,
  INSTANCE,
  landAs,
  peerRecord,
  registry,
  seedFeedSituation,
  situationClaim,
} from "./crowd-fixtures.integration.js";

const NOW = "2026-07-12T08:00:00.000Z";
const LATER = "2026-07-12T08:02:00.000Z";
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
let alice: ReporterKey;
let bob: ReporterKey;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  [alice, bob] = await Promise.all([generateReporterKey(), generateReporterKey()]);
  await enrollDirect(sql, alice, NOW);
  await enrollDirect(sql, bob, NOW);
}, 180_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.report_evidence, conditions.sub_claim CASCADE`;
});

describe("landing a crowd report", () => {
  it("stores a crowd situation that lives for its kind's lifetime, once per claim", async () => {
    const landed = await landAs(sql, alice, situationClaim(), NOW);
    expect(landed).toMatchObject({
      record: { class: "situation" },
      evidenceState: "self_reported",
      routingEligible: false,
      inserted: true,
    });
    expect(landed.record.id).toMatch(new RegExp(`^oc:situation:${INSTANCE}:[0-9a-f]{64}$`));
    const ttl = crowdRulesFor(registry, {
      class: "situation",
      kind: "incident",
      type: "obstruction",
    })!.ttlSec;
    const expires = new Date(Date.parse("2026-07-12T07:59:00.000Z") + ttl * 1000);
    const [row] = await sql<
      { origin: string; source_id: string; expires_at: Date; record: Record<string, never> }[]
    >`
      SELECT origin, source_id, expires_at, record FROM conditions.situation`;
    expect(row).toMatchObject({ origin: "crowd", source_id: "crowd", expires_at: expires });
    expect(row!.record["freshness"]).toMatchObject({ expiresAt: expires.toISOString() });
    expect(await landAs(sql, alice, situationClaim(), LATER)).toMatchObject({ inserted: false });
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM conditions.report_evidence`;
    expect(n).toBe(1);
  });

  it("merges two independent reports of one phenomenon into the earlier one", async () => {
    const first = await landAs(sql, alice, situationClaim(), NOW);
    const second = await landAs(
      sql,
      bob,
      situationClaim({ nonce: "nonce-000000000002", reportedAt: "2026-07-12T08:00:30.000Z" }),
      LATER,
    );
    expect(await autoCorroborateOnLanding(sql, registry, second.record.id, LATER)).toEqual([
      first.record.id,
    ]);
    expect(await evidenceOf(sql, first.record.id)).toMatchObject({
      evidence_state: "corroborated",
      corroborations: 1,
      routing_eligible: false,
    });
    expect(await evidenceOf(sql, second.record.id)).toMatchObject({
      tombstone_reason: "superseded",
    });
    expect(await resolveSurvivors(sql, [second.record.id])).toEqual(
      new Map([[second.record.id, first.record.id]]),
    );
  });

  it("is routed by an agreeing situation of a local feed, never a peer's", async () => {
    const report = await landAs(sql, alice, situationClaim(), NOW);
    const peerFeed = peerRecord(feedSituationDraft("peer-1"));
    await sql`SELECT 1`;
    const { writeRecord } = await import("@openconditions/storage");
    await writeRecord(sql, { stored: peerFeed }, { registry, instanceId: INSTANCE, now: NOW });
    expect(await crossValidateAgainstFeeds(sql, registry, report.record.id, NOW)).toBeNull();
    const feed = await seedFeedSituation(sql, "a5-1");
    expect(await crossValidateAgainstFeeds(sql, registry, report.record.id, NOW)).toBe(feed);
    expect(await evidenceOf(sql, report.record.id)).toMatchObject({
      evidence_state: "externally_resolved",
      routing_eligible: true,
    });
  });
});
