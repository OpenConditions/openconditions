import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { phenomenonFingerprint, type ConditionEvent } from "@openconditions/core";
import { runMigrations } from "@openconditions/core/server";
import { crossValidateAgainstFeeds } from "../evidence/crossValidate.js";
import { sweepCrossValidate } from "../evidence/crossValidateSweep.js";
import { recomputeEvidence } from "../evidence/recompute.js";

const T_REPORT = "2026-07-12T08:00:00.000Z";
const T_FEED = "2026-07-12T08:04:00.000Z";
const T_SWEEP = "2026-07-12T08:10:00.000Z";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

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
  sql = postgres(url, { max: 5 });
  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

// Each test seeds its own candidates and the sweep scans the WHOLE table, so
// isolate rows between tests.
beforeEach(async () => {
  await sql`TRUNCATE conditions.observations, conditions.reporter, conditions.report_evidence CASCADE`;
});

interface EventOpts {
  id: string;
  lon: number;
  lat: number;
  validFrom: string;
  type?: string;
  reporterKey?: string;
  source?: string;
  status?: string;
}

async function insertCrowdEvent(opts: EventOpts): Promise<void> {
  const type = opts.type ?? "hazard";
  const fp = phenomenonFingerprint({
    kind: "event",
    domain: "roads",
    type,
    geometry: { type: "Point", coordinates: [opts.lon, opts.lat] },
    validFrom: opts.validFrom,
  } as ConditionEvent);
  const origin =
    opts.reporterKey !== undefined
      ? { kind: "crowd", reporter: { keyId: opts.reporterKey } }
      : { kind: "crowd" };
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, type, status, geom, origin,
       valid_from, phenomenon_fingerprint, data_updated_at, fetched_at, is_stale)
    VALUES
      (${opts.id}, ${opts.source ?? "crowd"}, 'native', 'roads', 'event', ${type},
       ${opts.status ?? "active"},
       ST_SetSRID(ST_MakePoint(${opts.lon}, ${opts.lat}), 4326),
       ${sql.json(origin as never)}, ${opts.validFrom}, ${fp},
       ${opts.validFrom}, now(), false)`;
}

async function insertFeedEvent(opts: EventOpts): Promise<void> {
  const type = opts.type ?? "hazard";
  const fp = phenomenonFingerprint({
    kind: "event",
    domain: "roads",
    type,
    geometry: { type: "Point", coordinates: [opts.lon, opts.lat] },
    validFrom: opts.validFrom,
  } as ConditionEvent);
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, type, status, geom, origin,
       valid_from, phenomenon_fingerprint, data_updated_at, fetched_at, is_stale)
    VALUES
      (${opts.id}, ${opts.source ?? "ndw"}, 'datex2', 'roads', 'event', ${type},
       ${opts.status ?? "active"},
       ST_SetSRID(ST_MakePoint(${opts.lon}, ${opts.lat}), 4326),
       ${sql.json({ kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" } } as never)},
       ${opts.validFrom}, ${fp}, ${opts.validFrom}, now(), false)`;
}

/** A FEDERATED (peer-relayed) FEED EVENT — origin.kind "feed" WITH an originChain hop. */
async function insertFederatedFeedEvent(opts: EventOpts): Promise<void> {
  const type = opts.type ?? "hazard";
  const fp = phenomenonFingerprint({
    kind: "event",
    domain: "roads",
    type,
    geometry: { type: "Point", coordinates: [opts.lon, opts.lat] },
    validFrom: opts.validFrom,
  } as ConditionEvent);
  const origin = {
    kind: "feed",
    attribution: { provider: "NDW", license: "CC0-1.0" },
    originChain: [{ instanceId: "peer-b", receivedAt: opts.validFrom }],
  };
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, type, status, geom, origin,
       valid_from, phenomenon_fingerprint, data_updated_at, fetched_at, is_stale)
    VALUES
      (${opts.id}, ${opts.source ?? "peer-b"}, 'datex2', 'roads', 'event', ${type},
       ${opts.status ?? "active"},
       ST_SetSRID(ST_MakePoint(${opts.lon}, ${opts.lat}), 4326),
       ${sql.json(origin as never)},
       ${opts.validFrom}, ${fp}, ${opts.validFrom}, now(), false)`;
}

async function addReport(obsId: string, key: string, occurredAt: string): Promise<void> {
  await sql`
    INSERT INTO conditions.report_evidence
      (observation_id, evidence_kind, actor_key_id, occurred_at, details)
    VALUES (${obsId}, 'report', ${key}, ${occurredAt}, '{}'::jsonb)`;
}

async function insertReporter(keyId: string, alpha = 2, beta = 2): Promise<void> {
  await sql`
    INSERT INTO conditions.reporter
      (key_id, pub_jwk, reputation_alpha, reputation_beta,
       entitlement_expires_at, status, created_at, last_active_at)
    VALUES
      (${keyId}, '{}'::jsonb, ${alpha}, ${beta},
       '2027-01-01T00:00:00Z', 'active', ${T_REPORT}, ${T_REPORT})`;
}

/** Seed a crowd report with its reporter row + originating report evidence. */
async function seedCrowdReport(opts: EventOpts & { reporterKey: string }): Promise<void> {
  await insertCrowdEvent(opts);
  await insertReporter(opts.reporterKey);
  await addReport(opts.id, opts.reporterKey, opts.validFrom);
  await recomputeEvidence(sql, opts.id, opts.validFrom);
}

interface ObsRow {
  status: string;
  evidence_state: string | null;
  routing_eligible: boolean;
}

async function obs(id: string): Promise<ObsRow> {
  const rows = await sql<ObsRow[]>`
    SELECT status, evidence_state, routing_eligible
    FROM conditions.observations WHERE id = ${id}`;
  return rows[0]!;
}

async function readReporterAlpha(keyId: string): Promise<number> {
  const rows = await sql<{ reputation_alpha: number }[]>`
    SELECT reputation_alpha FROM conditions.reporter WHERE key_id = ${keyId}`;
  return rows[0]!.reputation_alpha;
}

async function externalEvidenceCount(obsId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM conditions.report_evidence
    WHERE observation_id = ${obsId}
      AND evidence_kind IN ('official_match', 'reviewer_accept', 'reviewer_reject')`;
  return rows[0]!.n;
}

describe("sweepCrossValidate — feed-arrives-later periodic cross-match", () => {
  it("routes a crowd report whose confirming FEED arrived AFTER it landed", async () => {
    await seedCrowdReport({
      id: "sw:crowd-late-feed",
      lon: 6.5,
      lat: 52.0,
      validFrom: T_REPORT,
      reporterKey: "sw-rep-late",
    });
    // No feed present at landing → the report stays non-routing.
    expect((await obs("sw:crowd-late-feed")).routing_eligible).toBe(false);

    // The official feed lands LATER (the case A1's landing hook alone misses).
    await insertFeedEvent({ id: "sw:feed-late", lon: 6.5001, lat: 52.0, validFrom: T_FEED });

    const result = await sweepCrossValidate(sql, T_SWEEP);
    expect(result.scanned).toBe(1);
    expect(result.routed).toBe(1);

    const crowd = await obs("sw:crowd-late-feed");
    expect(crowd.evidence_state).toBe("externally_resolved");
    expect(crowd.routing_eligible).toBe(true);
    expect(await readReporterAlpha("sw-rep-late")).toBe(3);
    expect(await externalEvidenceCount("sw:crowd-late-feed")).toBe(1);
  }, 30_000);

  it("scans but does not route a candidate with no matching feed (left unchanged)", async () => {
    await seedCrowdReport({
      id: "sw:crowd-nofeed",
      lon: 5.0,
      lat: 51.0,
      validFrom: T_REPORT,
      reporterKey: "sw-rep-nofeed",
    });

    const result = await sweepCrossValidate(sql, T_SWEEP);
    expect(result.scanned).toBe(1);
    expect(result.routed).toBe(0);

    const crowd = await obs("sw:crowd-nofeed");
    expect(crowd.routing_eligible).toBe(false);
    expect(crowd.evidence_state).not.toBe("externally_resolved");
    expect(await externalEvidenceCount("sw:crowd-nofeed")).toBe(0);
    expect(await readReporterAlpha("sw-rep-nofeed")).toBe(2);
  }, 30_000);

  it("does not re-route an already-routed report (excluded from the candidate scan; idempotent)", async () => {
    await seedCrowdReport({
      id: "sw:crowd-done",
      lon: 4.0,
      lat: 50.0,
      validFrom: T_REPORT,
      reporterKey: "sw-rep-done",
    });
    await insertFeedEvent({ id: "sw:feed-done", lon: 4.0001, lat: 50.0, validFrom: T_FEED });

    // First cross-validation routes it (routing_eligible flips to true).
    await crossValidateAgainstFeeds(sql, "sw:crowd-done", T_FEED);
    expect((await obs("sw:crowd-done")).routing_eligible).toBe(true);
    expect(await externalEvidenceCount("sw:crowd-done")).toBe(1);

    // A subsequent sweep must not scan (already routing_eligible) or double-train.
    const result = await sweepCrossValidate(sql, T_SWEEP);
    expect(result.scanned).toBe(0);
    expect(result.routed).toBe(0);
    expect(await externalEvidenceCount("sw:crowd-done")).toBe(1);
    expect(await readReporterAlpha("sw-rep-done")).toBe(3);
  }, 30_000);

  it("scans a FLAGGED candidate but never routes it, even with a matching feed", async () => {
    await seedCrowdReport({
      id: "sw:crowd-flagged",
      lon: 6.9,
      lat: 52.9,
      validFrom: T_REPORT,
      reporterKey: "sw-rep-flagged",
    });
    await sql`UPDATE conditions.observations SET flagged_at = ${T_REPORT} WHERE id = 'sw:crowd-flagged'`;
    await insertFeedEvent({ id: "sw:feed-flagged", lon: 6.9001, lat: 52.9, validFrom: T_FEED });

    const result = await sweepCrossValidate(sql, T_SWEEP);
    expect(result.scanned).toBe(1);
    expect(result.routed).toBe(0);

    const crowd = await obs("sw:crowd-flagged");
    expect(crowd.routing_eligible).toBe(false);
    expect(await externalEvidenceCount("sw:crowd-flagged")).toBe(0);
    expect(await readReporterAlpha("sw-rep-flagged")).toBe(2);
  }, 30_000);

  it("does NOT enumerate a keyId-less REMOTE crowd row (federation strips reporter → A1 can never route it → must not clog the sweep)", async () => {
    // A federation-exported peer crowd report: origin.kind stays "crowd" but the
    // reporter (and keyId) was stripped on export. It lands active with a
    // phenomenon_fingerprint and routing_eligible=false, so it would match the
    // naive candidate predicate — but A1 rejects it forever (no keyId to route),
    // so it must be excluded from enumeration or it starves real candidates.
    const fp = phenomenonFingerprint({
      kind: "event",
      domain: "roads",
      type: "hazard",
      geometry: { type: "Point", coordinates: [7.0, 53.0] },
      validFrom: T_REPORT,
    } as ConditionEvent);
    await sql`
      INSERT INTO conditions.observations
        (id, source, source_format, domain, kind, type, status, geom, origin,
         valid_from, phenomenon_fingerprint, data_updated_at, fetched_at, is_stale)
      VALUES
        ('sw:remote-crowd', 'peer-a', 'native', 'roads', 'event', 'hazard', 'active',
         ST_SetSRID(ST_MakePoint(7.0, 53.0), 4326),
         ${sql.json({ kind: "crowd" } as never)},
         ${T_REPORT}, ${fp}, ${T_REPORT}, now(), false)`;
    // A matching feed IS present — proving it's the missing keyId, not a missing
    // feed, that keeps it out of the batch.
    await insertFeedEvent({ id: "sw:feed-remote", lon: 7.0001, lat: 53.0, validFrom: T_FEED });

    const result = await sweepCrossValidate(sql, T_SWEEP);
    expect(result.scanned).toBe(0);
    expect(result.routed).toBe(0);
    expect((await obs("sw:remote-crowd")).routing_eligible).toBe(false);
  }, 30_000);

  it("scans a candidate but never routes it against a FEDERATED-only feed (inherits the local-feed guard)", async () => {
    await seedCrowdReport({
      id: "sw:crowd-federated",
      lon: 8.0,
      lat: 54.0,
      validFrom: T_REPORT,
      reporterKey: "sw-rep-federated",
    });
    // Only a FEDERATED (peer-relayed) feed matches — the shared local-feed guard
    // must keep the sweep from routing it.
    await insertFederatedFeedEvent({
      id: "sw:feed-federated",
      lon: 8.0001,
      lat: 54.0,
      validFrom: T_FEED,
    });

    const result = await sweepCrossValidate(sql, T_SWEEP);
    expect(result.scanned).toBe(1);
    expect(result.routed).toBe(0);

    const crowd = await obs("sw:crowd-federated");
    expect(crowd.routing_eligible).toBe(false);
    expect(crowd.evidence_state).not.toBe("externally_resolved");
    expect(await externalEvidenceCount("sw:crowd-federated")).toBe(0);
    expect(await readReporterAlpha("sw-rep-federated")).toBe(2);
  }, 30_000);

  it("excludes an EXPIRED candidate from the scan", async () => {
    await seedCrowdReport({
      id: "sw:crowd-expired",
      lon: 3.0,
      lat: 49.0,
      validFrom: T_REPORT,
      reporterKey: "sw-rep-expired",
    });
    await sql`UPDATE conditions.observations SET expires_at = ${T_REPORT} WHERE id = 'sw:crowd-expired'`;
    await insertFeedEvent({ id: "sw:feed-expired", lon: 3.0001, lat: 49.0, validFrom: T_FEED });

    const result = await sweepCrossValidate(sql, T_SWEEP);
    expect(result.scanned).toBe(0);
    expect(result.routed).toBe(0);
    expect((await obs("sw:crowd-expired")).routing_eligible).toBe(false);
  }, 30_000);

  it("caps the batch at maxBatch and logs the deferred overflow (no silent drop)", async () => {
    for (let i = 0; i < 3; i += 1) {
      await seedCrowdReport({
        id: `sw:crowd-cap-${i}`,
        lon: 2.0 + i,
        lat: 48.0,
        validFrom: `2026-07-12T08:0${i}:00.000Z`,
        reporterKey: `sw-rep-cap-${i}`,
      });
    }

    const logs: string[] = [];
    const result = await sweepCrossValidate(sql, T_SWEEP, {
      maxBatch: 2,
      log: (m) => logs.push(m),
    });

    expect(result.scanned).toBe(2);
    // Logs the exact deferred count (3 candidates − cap 2 = 1), not just "≥1".
    expect(logs.some((m) => /deferring 1 candidate/.test(m))).toBe(true);
  }, 30_000);

  it("is best-effort: a throw on one candidate is logged and does not abort the sweep", async () => {
    await seedCrowdReport({
      id: "sw:crowd-boom",
      lon: 1.0,
      lat: 47.0,
      validFrom: "2026-07-12T08:00:00.000Z",
      reporterKey: "sw-rep-boom",
    });
    await seedCrowdReport({
      id: "sw:crowd-ok",
      lon: 1.5,
      lat: 47.0,
      validFrom: "2026-07-12T08:01:00.000Z",
      reporterKey: "sw-rep-ok",
    });

    const logs: string[] = [];
    const result = await sweepCrossValidate(sql, T_SWEEP, {
      crossValidateAgainstFeeds: async (_sql, id) => {
        if (id === "sw:crowd-boom") throw new Error("boom");
        return null;
      },
      log: (m) => logs.push(m),
    });

    // Both candidates were visited despite the first throwing.
    expect(result.scanned).toBe(2);
    expect(result.routed).toBe(0);
    expect(logs.some((m) => m.includes("sw:crowd-boom"))).toBe(true);
  }, 30_000);
});
