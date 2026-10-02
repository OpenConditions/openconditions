import type { ReporterKey } from "@openconditions/contrib-core";
import { writeRecord } from "@openconditions/storage";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { autoCorroborateOnLanding } from "../evidence/autoCorroborate.js";
import { crossValidateAgainstFeeds } from "../evidence/crossValidate.js";
import { sweepCrossValidate, sweepFederatedCrossValidate } from "../evidence/crossValidateSweep.js";
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
const T_FEED = "2026-07-12T08:04:00.000Z";
const T_SWEEP = "2026-07-12T08:10:00.000Z";
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

// Each test seeds its own candidates and the sweep scans the WHOLE table.
beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.report_evidence, conditions.reporter CASCADE`;
});

/** A position `km` east of the base point, so candidates never agree with each other. */
function east(km: number): [number, number] {
  return [LON + (km * 1000) / (M_PER_DEG * Math.cos((LAT * Math.PI) / 180)), LAT];
}

function pointAt(coordinates: [number, number], northMetres = 10): Rec {
  return {
    geometry: {
      type: "Point",
      coordinates: [coordinates[0], coordinates[1] + northMetres / M_PER_DEG],
    },
    extent: "point",
    geometryOrigin: "source",
    fuzziness: "exact",
  };
}

/** A local crowd report by a fresh reporter, made and received at `at`. */
async function seedCrowdReport(
  at = T_REPORT,
  coordinates = east(0),
): Promise<{ id: string; reporter: ReporterKey }> {
  const reporter = await enrolledKey(sql, at);
  const landed = await landAs(
    sql,
    reporter,
    situationClaim({ reportedAt: at, geometry: { type: "Point", coordinates } }),
    at,
  );
  return { id: landed.record.id, reporter };
}

/** A local feed's obstruction near `coordinates`, published at `T_FEED`. */
function seedFeed(local: string, coordinates = east(0)): Promise<string> {
  return seedFeedSituation(sql, local, { location: pointAt(coordinates) }, T_FEED);
}

async function seedFederatedFeed(local: string, coordinates = east(0)): Promise<string> {
  const record = peerRecord(feedSituationDraft(local, { location: pointAt(coordinates) }));
  const written = await writeRecord(
    sql,
    { stored: record },
    { registry, instanceId: INSTANCE, now: T_FEED },
  );
  if (written.status === "rejected") throw new Error(JSON.stringify(written.issues));
  return record["id"] as string;
}

async function readAlpha(key: ReporterKey): Promise<number> {
  const [row] = await sql<{ reputation_alpha: number }[]>`
    SELECT reputation_alpha FROM conditions.reporter WHERE key_id = ${key.keyId}`;
  return row!.reputation_alpha;
}

/** Byte-snapshot of the WHOLE reporter table — proves a route trained NOBODY. */
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

async function setExpiry(id: string, expiresAt: string | null): Promise<void> {
  await sql`UPDATE conditions.situation SET expires_at = ${expiresAt} WHERE id = ${id}`;
}

/** A cross-validation stand-in that records the candidates it was given. */
function recorder(throwFor?: string) {
  const seen: { id: string; allowFederatedTarget: boolean | undefined }[] = [];
  const crossValidate: typeof crossValidateAgainstFeeds = async (_sql, _r, id, _now, deps) => {
    seen.push({ id, allowFederatedTarget: deps?.allowFederatedTarget });
    if (id === throwFor) throw new Error("boom");
    return null;
  };
  return { seen, crossValidate };
}

describe("sweepCrossValidate — feed-arrives-later periodic cross-match", () => {
  it("routes a crowd report whose agreeing FEED arrived AFTER it landed", async () => {
    const { id, reporter } = await seedCrowdReport();
    expect(await crossValidateAgainstFeeds(sql, registry, id, T_REPORT)).toBeNull();

    await seedFeed("sw-late");

    expect(await sweepCrossValidate(sql, registry, T_SWEEP)).toEqual({ scanned: 1, routed: 1 });
    expect(await evidenceOf(sql, id)).toMatchObject({
      evidence_state: "externally_resolved",
      routing_eligible: true,
    });
    expect(await readAlpha(reporter)).toBe(3);
    expect(await externalEvidenceCount(id)).toBe(1);
  }, 30_000);

  it("scans but does not route a candidate with no agreeing feed (left unchanged)", async () => {
    const { id, reporter } = await seedCrowdReport();

    expect(await sweepCrossValidate(sql, registry, T_SWEEP)).toEqual({ scanned: 1, routed: 0 });
    expect(await evidenceOf(sql, id)).toMatchObject({
      evidence_state: "self_reported",
      routing_eligible: false,
    });
    expect(await externalEvidenceCount(id)).toBe(0);
    expect(await readAlpha(reporter)).toBe(2);
  }, 30_000);

  it("does not re-scan an already-routed report (idempotent)", async () => {
    const { id, reporter } = await seedCrowdReport();
    await seedFeed("sw-done");
    await crossValidateAgainstFeeds(sql, registry, id, T_FEED);
    expect(await evidenceOf(sql, id)).toMatchObject({ routing_eligible: true });

    expect(await sweepCrossValidate(sql, registry, T_SWEEP)).toEqual({ scanned: 0, routed: 0 });
    expect(await externalEvidenceCount(id)).toBe(1);
    expect(await readAlpha(reporter)).toBe(3);
  }, 30_000);

  it("scans a FLAGGED candidate but never routes it, even with an agreeing feed", async () => {
    const { id, reporter } = await seedCrowdReport();
    await sql`UPDATE conditions.situation SET flagged_at = ${T_REPORT} WHERE id = ${id}`;
    await seedFeed("sw-flagged");

    expect(await sweepCrossValidate(sql, registry, T_SWEEP)).toEqual({ scanned: 1, routed: 0 });
    expect(await evidenceOf(sql, id)).toMatchObject({ routing_eligible: false });
    expect(await externalEvidenceCount(id)).toBe(0);
    expect(await readAlpha(reporter)).toBe(2);
  }, 30_000);

  it("does NOT enumerate a peer's keyless crowd report (the federated sweep owns it)", async () => {
    const report = await seedPeerCrowdReport(sql, "sw-peer", east(0), T_REPORT);
    await seedFeed("sw-for-peer");

    expect(await sweepCrossValidate(sql, registry, T_SWEEP)).toEqual({ scanned: 0, routed: 0 });
    expect(await evidenceOf(sql, report)).toMatchObject({ routing_eligible: false });
  }, 30_000);

  it("does NOT enumerate feed situations or reports merged into another", async () => {
    await seedFeed("sw-feed-only");
    const first = await seedCrowdReport(T_REPORT);
    const second = await seedCrowdReport("2026-07-12T08:01:00.000Z");
    await autoCorroborateOnLanding(sql, registry, second.id, "2026-07-12T08:01:30.000Z");
    expect(await evidenceOf(sql, second.id)).toMatchObject({ tombstone_reason: "superseded" });

    const { seen, crossValidate } = recorder();
    await sweepCrossValidate(sql, registry, T_SWEEP, { crossValidateAgainstFeeds: crossValidate });
    expect(seen.map((s) => s.id)).toEqual([first.id]);
  }, 30_000);

  it("scans a candidate but never routes it against a FEDERATED-only feed", async () => {
    const { id, reporter } = await seedCrowdReport();
    await seedFederatedFeed("sw-federated");

    expect(await sweepCrossValidate(sql, registry, T_SWEEP)).toEqual({ scanned: 1, routed: 0 });
    expect(await evidenceOf(sql, id)).toMatchObject({ routing_eligible: false });
    expect(await externalEvidenceCount(id)).toBe(0);
    expect(await readAlpha(reporter)).toBe(2);
  }, 30_000);

  it("excludes a candidate whose lifetime has run out", async () => {
    const { id } = await seedCrowdReport();
    await seedFeed("sw-expired");

    // An obstruction report lives 15 minutes: gone by 08:16.
    expect(await sweepCrossValidate(sql, registry, "2026-07-12T08:16:00.000Z")).toEqual({
      scanned: 0,
      routed: 0,
    });
    expect(await evidenceOf(sql, id)).toMatchObject({ routing_eligible: false });
  }, 30_000);

  it("takes the oldest reports first, caps the batch and logs the deferred overflow", async () => {
    const reports: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const at = `2026-07-12T08:0${2 - i}:00.000Z`;
      reports.push((await seedCrowdReport(at, east(i + 1))).id);
    }

    const logs: string[] = [];
    const { seen, crossValidate } = recorder();
    const result = await sweepCrossValidate(sql, registry, T_SWEEP, {
      crossValidateAgainstFeeds: crossValidate,
      maxBatch: 2,
      log: (m) => logs.push(m),
    });

    expect(result.scanned).toBe(2);
    // reports[2] was made at 08:00, reports[1] at 08:01; reports[0] (08:02) waits.
    expect(seen.map((s) => s.id)).toEqual([reports[2], reports[1]]);
    expect(logs.some((m) => /deferring 1 candidate/.test(m))).toBe(true);
  }, 30_000);

  it("is best-effort: a throw on one candidate is logged and does not abort the sweep", async () => {
    const boom = await seedCrowdReport(T_REPORT, east(1));
    await seedCrowdReport("2026-07-12T08:01:00.000Z", east(2));

    const logs: string[] = [];
    const { seen, crossValidate } = recorder(boom.id);
    const result = await sweepCrossValidate(sql, registry, T_SWEEP, {
      crossValidateAgainstFeeds: crossValidate,
      log: (m) => logs.push(m),
    });

    expect(result).toEqual({ scanned: 2, routed: 0 });
    expect(logs.some((m) => m.includes(boom.id))).toBe(true);
    // The local sweep never opts into the federated target.
    expect(seen.every((c) => c.allowFederatedTarget === undefined)).toBe(true);
  }, 30_000);
});

const T_SOON = "2026-07-12T08:20:00.000Z";
const T_LATE = "2026-07-12T08:50:00.000Z";

describe("sweepFederatedCrossValidate — starvation-safe federated feed-arrives-later cross-match", () => {
  it("routes a peer's crowd report whose agreeing LOCAL feed arrived AFTER it landed, training nobody", async () => {
    await enrolledKey(sql, T_REPORT);
    const report = await seedPeerCrowdReport(sql, "fsw-late", east(0), T_REPORT);
    expect(await evidenceOf(sql, report)).toMatchObject({ routing_eligible: false });

    await seedFeed("fsw-late");

    const before = await reporterSnapshot();
    expect(await sweepFederatedCrossValidate(sql, registry, T_SWEEP)).toEqual({
      scanned: 1,
      routed: 1,
    });
    expect(await evidenceOf(sql, report)).toMatchObject({
      evidence_state: "externally_resolved",
      routing_eligible: true,
    });
    expect(await externalEvidenceCount(report)).toBe(1);
    expect(await reporterSnapshot()).toBe(before);
  }, 30_000);

  it("scans but does NOT route a peer's crowd report agreeing only with a FEDERATED feed", async () => {
    const report = await seedPeerCrowdReport(sql, "fsw-vs-fedfeed", east(0), T_REPORT);
    await seedFederatedFeed("fsw-fedfeed");

    expect(await sweepFederatedCrossValidate(sql, registry, T_SWEEP)).toEqual({
      scanned: 1,
      routed: 0,
    });
    expect(await evidenceOf(sql, report)).toMatchObject({ routing_eligible: false });
    expect(await externalEvidenceCount(report)).toBe(0);
  }, 30_000);

  it("does NOT enumerate a LOCAL crowd report (it carries a key; the local sweep owns it)", async () => {
    const { id, reporter } = await seedCrowdReport();
    await seedFeed("fsw-local");

    expect(await sweepFederatedCrossValidate(sql, registry, T_SWEEP)).toEqual({
      scanned: 0,
      routed: 0,
    });
    expect(await evidenceOf(sql, id)).toMatchObject({ routing_eligible: false });
    expect(await readAlpha(reporter)).toBe(2);
  }, 30_000);

  it("does NOT enumerate a peer's crowd report with no expiry (NULL > now is not true)", async () => {
    const report = await seedPeerCrowdReport(sql, "fsw-null-expiry", east(0), T_REPORT);
    await setExpiry(report, null);
    await seedFeed("fsw-null-expiry");

    expect(await sweepFederatedCrossValidate(sql, registry, T_SWEEP)).toEqual({
      scanned: 0,
      routed: 0,
    });
  }, 30_000);

  it("does NOT enumerate an EXPIRED peer crowd report", async () => {
    const report = await seedPeerCrowdReport(sql, "fsw-expired", east(0), T_REPORT);
    await setExpiry(report, T_REPORT);
    await seedFeed("fsw-expired");

    expect(await sweepFederatedCrossValidate(sql, registry, T_SWEEP)).toEqual({
      scanned: 0,
      routed: 0,
    });
    expect(await evidenceOf(sql, report)).toMatchObject({ routing_eligible: false });
  }, 30_000);

  it("does NOT enumerate a keyless crowd report WITHOUT an origin chain (not genuinely federated)", async () => {
    const report = await seedPeerCrowdReport(sql, "fsw-no-chain", east(0), T_REPORT);
    await sql`
      UPDATE conditions.situation SET record = record #- '{provenance,originChain}'
      WHERE id = ${report}`;
    await seedFeed("fsw-no-chain");

    expect(await sweepFederatedCrossValidate(sql, registry, T_SWEEP)).toEqual({
      scanned: 0,
      routed: 0,
    });
  }, 30_000);

  it("orders soonest-to-expire FIRST, honours the batch cap, and logs the deferred overflow", async () => {
    const late = await seedPeerCrowdReport(sql, "fsw-late-expiry", east(1), T_REPORT);
    await setExpiry(late, T_LATE);
    await seedFeed("fsw-late-expiry", east(1));
    const soon = await seedPeerCrowdReport(sql, "fsw-soon-expiry", east(2), T_REPORT);
    await setExpiry(soon, T_SOON);
    await seedFeed("fsw-soon-expiry", east(2));

    const logs: string[] = [];
    const result = await sweepFederatedCrossValidate(sql, registry, T_SWEEP, {
      maxBatch: 1,
      log: (m) => logs.push(m),
    });

    expect(result).toEqual({ scanned: 1, routed: 1 });
    expect(await evidenceOf(sql, soon)).toMatchObject({ routing_eligible: true });
    expect(await evidenceOf(sql, late)).toMatchObject({ routing_eligible: false });
    expect(logs.some((m) => /deferring 1 candidate/.test(m))).toBe(true);
  }, 30_000);

  it("passes allowFederatedTarget and is best-effort: a throw on one candidate is logged, the sweep continues", async () => {
    const boom = await seedPeerCrowdReport(sql, "fsw-boom", east(1), T_REPORT);
    await seedPeerCrowdReport(sql, "fsw-ok", east(2), T_REPORT);

    const logs: string[] = [];
    const { seen, crossValidate } = recorder(boom);
    const result = await sweepFederatedCrossValidate(sql, registry, T_SWEEP, {
      crossValidateAgainstFeeds: crossValidate,
      log: (m) => logs.push(m),
    });

    expect(result).toEqual({ scanned: 2, routed: 0 });
    expect(logs.some((m) => m.includes(boom))).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen.every((c) => c.allowFederatedTarget === true)).toBe(true);
  }, 30_000);
});
