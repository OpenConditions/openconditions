import type { ReporterKey } from "@openconditions/contrib-core";
import { writeRecord } from "@openconditions/storage";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { crossValidateAgainstFeeds } from "../evidence/crossValidate.js";
import {
  createTestDatabase,
  enrolledKey,
  evidenceOf,
  feedSituationDraft,
  INSTANCE,
  landAs,
  peerRecord,
  registry,
  seedFeedSituation,
  seedPeerCrowdReport,
  situationClaim,
} from "./crowd-fixtures.integration.js";

const T_REPORT = "2026-07-12T08:00:00.000Z";
const T_RESOLVE = "2026-07-12T08:10:00.000Z";
const M_PER_DEG = 111_320;
const LON = 8.4;
const LAT = 49;

type Rec = Record<string, unknown>;

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

/** A point `metres` north of the base point. */
function pointNorth(metres = 0): Rec {
  return {
    geometry: { type: "Point", coordinates: [LON, LAT + metres / M_PER_DEG] },
    extent: "point",
    geometryOrigin: "source",
    fuzziness: "exact",
  };
}

/** A local crowd report of an obstruction at the base point, by a fresh reporter. */
async function seedCrowdReport(): Promise<{ id: string; reporter: ReporterKey }> {
  const reporter = await enrolledKey(sql, T_REPORT);
  const landed = await landAs(sql, reporter, situationClaim({ reportedAt: T_REPORT }), T_REPORT);
  return { id: landed.record.id, reporter };
}

/** A local feed's obstruction `metres` north of the base point. */
function seedFeed(local: string, metres = 10, over: Rec = {}): Promise<string> {
  return seedFeedSituation(sql, local, { location: pointNorth(metres), ...over });
}

/** A feed situation a peer federated here (it carries an origin-chain hop). */
async function seedFederatedFeed(local: string, metres = 10): Promise<string> {
  const record = peerRecord(feedSituationDraft(local, { location: pointNorth(metres) }));
  const written = await writeRecord(
    sql,
    { stored: record },
    { registry, instanceId: INSTANCE, now: T_REPORT },
  );
  if (written.status === "rejected") throw new Error(JSON.stringify(written.issues));
  return record["id"] as string;
}

async function readReporter(key: ReporterKey): Promise<{ alpha: number; beta: number }> {
  const [row] = await sql<{ reputation_alpha: number; reputation_beta: number }[]>`
    SELECT reputation_alpha, reputation_beta FROM conditions.reporter WHERE key_id = ${key.keyId}`;
  return { alpha: row!.reputation_alpha, beta: row!.reputation_beta };
}

/** A stable snapshot of every reporter's trainable columns, to assert nobody was trained. */
async function reporterSnapshot(): Promise<string> {
  const rows = await sql<{ key_id: string; a: number; b: number; c: number }[]>`
    SELECT key_id, reputation_alpha AS a, reputation_beta AS b, corroborated_count AS c
    FROM conditions.reporter ORDER BY key_id`;
  return JSON.stringify(rows);
}

async function externalEvidenceCount(id: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM conditions.report_evidence
    WHERE record_class = 'situation' AND record_id = ${id}
      AND evidence_kind IN ('official_match', 'reviewer_accept', 'reviewer_reject')`;
  return row!.n;
}

/** Asserts a crowd report was left unrouted, without external evidence. */
async function expectUnrouted(id: string): Promise<void> {
  const row = await evidenceOf(sql, id);
  expect(row.routing_eligible).toBe(false);
  expect(row.evidence_state).not.toBe("externally_resolved");
  expect(await externalEvidenceCount(id)).toBe(0);
}

describe("crossValidateAgainstFeeds — official cross-validation routing", () => {
  it("routes a crowd report agreeing with a LOCAL feed: externally_resolved + routing + reputation trained", async () => {
    const { id, reporter } = await seedCrowdReport();
    const feed = await seedFeed("xv-match");

    expect(await crossValidateAgainstFeeds(sql, registry, id, T_RESOLVE)).toBe(feed);

    expect(await evidenceOf(sql, id)).toMatchObject({
      evidence_state: "externally_resolved",
      routing_eligible: true,
    });
    expect(await readReporter(reporter)).toEqual({ alpha: 3, beta: 2 });

    // The one external row NAMES the feed record that routed the report:
    // external resolution is the only path to routing, so it must be auditable.
    const official = await sql<{ source_id: string | null; details: Rec }[]>`
      SELECT source_id, details FROM conditions.report_evidence
      WHERE record_id = ${id} AND evidence_kind = 'official_match'`;
    expect(official).toHaveLength(1);
    expect(official[0]!.source_id).toBe("de-autobahn");
    expect(official[0]!.details).toEqual({
      source: "official",
      outcome: "confirmed",
      matchedRecord: { class: "situation", id: feed },
    });

    // The feed situation is authoritative and untouched.
    expect(await externalEvidenceCount(feed)).toBe(0);
    expect(await evidenceOf(sql, feed)).toMatchObject({
      evidence_state: null,
      routing_eligible: false,
      tombstone_reason: null,
    });
  }, 30_000);

  it("routes on a feed line whose nearest part is within the match distance", async () => {
    const { id } = await seedCrowdReport();
    const feed = await seedFeed("xv-line", 0, {
      location: {
        geometry: {
          type: "LineString",
          coordinates: [
            [LON, LAT + 200 / M_PER_DEG],
            [LON, LAT + 3000 / M_PER_DEG],
          ],
        },
        extent: "linear",
        geometryOrigin: "source",
        fuzziness: "exact",
      },
    });
    expect(await crossValidateAgainstFeeds(sql, registry, id, T_RESOLVE)).toBe(feed);
  }, 30_000);

  it("does NOT route when the only neighbour is another CROWD report (reputation untouched)", async () => {
    const { id, reporter } = await seedCrowdReport();
    await seedCrowdReport();

    expect(await crossValidateAgainstFeeds(sql, registry, id, T_RESOLVE)).toBeNull();
    await expectUnrouted(id);
    expect(await readReporter(reporter)).toEqual({ alpha: 2, beta: 2 });
  }, 30_000);

  it("does NOT route against a peer's keyless CROWD report", async () => {
    const { id, reporter } = await seedCrowdReport();
    await seedPeerCrowdReport(sql, "xv-peer-crowd", [LON, LAT], T_REPORT);

    expect(await crossValidateAgainstFeeds(sql, registry, id, T_RESOLVE)).toBeNull();
    await expectUnrouted(id);
    expect(await readReporter(reporter)).toEqual({ alpha: 2, beta: 2 });
  }, 30_000);

  it("does NOT route a FLAGGED (disputed) crowd report even when a feed agrees", async () => {
    const { id, reporter } = await seedCrowdReport();
    await sql`UPDATE conditions.situation SET flagged_at = ${T_REPORT} WHERE id = ${id}`;
    await seedFeed("xv-flagged");

    expect(await crossValidateAgainstFeeds(sql, registry, id, T_RESOLVE)).toBeNull();
    await expectUnrouted(id);
    expect(await readReporter(reporter)).toEqual({ alpha: 2, beta: 2 });
  }, 30_000);

  it("does NOT route against a feed beyond the kind's match distance (> 250 m)", async () => {
    const { id, reporter } = await seedCrowdReport();
    await seedFeed("xv-far", 270);

    expect(await crossValidateAgainstFeeds(sql, registry, id, T_RESOLVE)).toBeNull();
    await expectUnrouted(id);
    expect(await readReporter(reporter)).toEqual({ alpha: 2, beta: 2 });
  }, 30_000);

  it("does NOT route against a feed of a DIFFERENT type", async () => {
    const { id, reporter } = await seedCrowdReport();
    await seedFeed("xv-diff-type", 10, { type: "accident" });

    expect(await crossValidateAgainstFeeds(sql, registry, id, T_RESOLVE)).toBeNull();
    await expectUnrouted(id);
    expect(await readReporter(reporter)).toEqual({ alpha: 2, beta: 2 });
  }, 30_000);

  it("does NOT route against a feed not in effect when the report was made", async () => {
    const { id } = await seedCrowdReport();
    await seedFeed("xv-not-yet", 10, {
      validity: { status: "active", start: "2026-07-12T08:40:00Z" },
    });
    await seedFeed("xv-ended", 20, {
      validity: { status: "active", start: "2026-07-12T06:00:00Z", end: "2026-07-12T07:30:00Z" },
    });

    expect(await crossValidateAgainstFeeds(sql, registry, id, T_RESOLVE)).toBeNull();
    await expectUnrouted(id);
  }, 30_000);

  it("is idempotent: replaying the cross-validation does not double-insert or double-train", async () => {
    const { id, reporter } = await seedCrowdReport();
    await seedFeed("xv-idem");

    await crossValidateAgainstFeeds(sql, registry, id, T_RESOLVE);
    await crossValidateAgainstFeeds(sql, registry, id, "2026-07-12T08:12:00.000Z");

    expect(await externalEvidenceCount(id)).toBe(1);
    expect(await readReporter(reporter)).toEqual({ alpha: 3, beta: 2 });
  }, 30_000);

  it("does NOT route against a FEDERATED feed — only local feeds cross-validate", async () => {
    const { id, reporter } = await seedCrowdReport();
    await seedFederatedFeed("xv-federated");

    expect(await crossValidateAgainstFeeds(sql, registry, id, T_RESOLVE)).toBeNull();
    await expectUnrouted(id);
    expect(await readReporter(reporter)).toEqual({ alpha: 2, beta: 2 });
  }, 30_000);

  it("routes via the LOCAL feed only when both a LOCAL and a FEDERATED feed agree", async () => {
    const { id, reporter } = await seedCrowdReport();
    const federated = await seedFederatedFeed("xv-federated-both", 5);
    const local = await seedFeed("xv-local-both", 15);

    expect(await crossValidateAgainstFeeds(sql, registry, id, T_RESOLVE)).toBe(local);
    expect(await evidenceOf(sql, id)).toMatchObject({
      evidence_state: "externally_resolved",
      routing_eligible: true,
    });
    expect(await readReporter(reporter)).toEqual({ alpha: 3, beta: 2 });
    expect(await externalEvidenceCount(id)).toBe(1);
    expect(await externalEvidenceCount(federated)).toBe(0);
  }, 30_000);

  it("returns null when the target is itself a FEED situation", async () => {
    const target = await seedFeed("xv-target-feed", 0);
    await seedFeedSituation(sql, "xv-feed-neighbour", {
      location: pointNorth(10),
      provenance: {
        ...(feedSituationDraft("x")["provenance"] as Rec),
        sourceId: "nl-ndw",
        recordId: "xv-feed-neighbour",
      },
      id: "oc:situation:nl-ndw:xv-feed-neighbour",
    });

    expect(await crossValidateAgainstFeeds(sql, registry, target, T_RESOLVE)).toBeNull();
    expect(await externalEvidenceCount(target)).toBe(0);
  }, 30_000);

  it("returns null for a non-existent situation", async () => {
    expect(
      await crossValidateAgainstFeeds(sql, registry, "oc:situation:nope", T_RESOLVE),
    ).toBeNull();
  }, 30_000);
});

describe("crossValidateAgainstFeeds — allowFederatedTarget (route-without-training)", () => {
  it("routes a peer's crowd report on a LOCAL feed and trains NOBODY", async () => {
    const report = await seedPeerCrowdReport(sql, "xvf-crowd", [LON, LAT], T_REPORT);
    const feed = await seedFeed("xvf-local");
    // A reporter row makes the "trains nobody" snapshot a real comparison.
    await enrolledKey(sql, T_REPORT);

    const before = await reporterSnapshot();
    expect(
      await crossValidateAgainstFeeds(sql, registry, report, T_RESOLVE, {
        allowFederatedTarget: true,
      }),
    ).toBe(feed);

    expect(await evidenceOf(sql, report)).toMatchObject({
      evidence_state: "externally_resolved",
      routing_eligible: true,
    });
    expect(await externalEvidenceCount(report)).toBe(1);
    expect(await externalEvidenceCount(feed)).toBe(0);
    expect(await reporterSnapshot()).toBe(before);
  }, 30_000);

  it("does NOT route a peer's crowd report agreeing only with a FEDERATED feed", async () => {
    const report = await seedPeerCrowdReport(sql, "xvf-vs-fedfeed", [LON, LAT], T_REPORT);
    await seedFederatedFeed("xvf-fedfeed");

    expect(
      await crossValidateAgainstFeeds(sql, registry, report, T_RESOLVE, {
        allowFederatedTarget: true,
      }),
    ).toBeNull();
    await expectUnrouted(report);
  }, 30_000);

  it("does NOT route a FEDERATED FEED situation as target, even with allowFederatedTarget", async () => {
    const target = await seedFederatedFeed("xvf-fedfeed-target", 0);
    await seedFeed("xvf-local-for-fedtarget");

    expect(
      await crossValidateAgainstFeeds(sql, registry, target, T_RESOLVE, {
        allowFederatedTarget: true,
      }),
    ).toBeNull();
    expect(await externalEvidenceCount(target)).toBe(0);
  }, 30_000);

  it("does NOT route a keyless crowd report WITHOUT an origin chain, even with allowFederatedTarget", async () => {
    const report = await seedPeerCrowdReport(sql, "xvf-no-chain", [LON, LAT], T_REPORT);
    await sql`
      UPDATE conditions.situation SET record = record #- '{provenance,originChain}'
      WHERE id = ${report}`;
    await seedFeed("xvf-feed-for-nochain");

    expect(
      await crossValidateAgainstFeeds(sql, registry, report, T_RESOLVE, {
        allowFederatedTarget: true,
      }),
    ).toBeNull();
    await expectUnrouted(report);
  }, 30_000);

  it("keeps the STRICT guard by default: a peer's crowd report does not route without allowFederatedTarget", async () => {
    const report = await seedPeerCrowdReport(sql, "xvf-strict", [LON, LAT], T_REPORT);
    await seedFeed("xvf-feed-strict");

    expect(await crossValidateAgainstFeeds(sql, registry, report, T_RESOLVE)).toBeNull();
    await expectUnrouted(report);
  }, 30_000);

  it("is idempotent under allowFederatedTarget: replaying does not double-insert", async () => {
    const report = await seedPeerCrowdReport(sql, "xvf-idem", [LON, LAT], T_REPORT);
    await seedFeed("xvf-feed-idem");
    await enrolledKey(sql, T_REPORT);

    const before = await reporterSnapshot();
    for (const now of [T_RESOLVE, "2026-07-12T08:12:00.000Z"]) {
      await crossValidateAgainstFeeds(sql, registry, report, now, { allowFederatedTarget: true });
    }

    expect(await externalEvidenceCount(report)).toBe(1);
    expect(await evidenceOf(sql, report)).toMatchObject({ routing_eligible: true });
    expect(await reporterSnapshot()).toBe(before);
  }, 30_000);
});
