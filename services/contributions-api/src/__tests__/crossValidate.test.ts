import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { phenomenonFingerprint, type ConditionEvent } from "@openconditions/core";
import { runMigrations } from "@openconditions/core/server";
import { crossValidateAgainstFeeds } from "../evidence/crossValidate.js";
import { recomputeEvidence } from "../evidence/recompute.js";

const T_REPORT = "2026-07-12T08:00:00.000Z";
const T_RESOLVE = "2026-07-12T08:10:00.000Z";

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

/** A crowd EVENT observation carrying a reporter keyId in its origin. */
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

/** An OFFICIAL FEED EVENT observation — origin.kind "feed", no reporter key. */
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

/**
 * A FEDERATED (peer-relayed) FEED EVENT — origin.kind "feed" WITH a non-empty
 * originChain (≥1 hop stamped by federation ingest). This is the weaker,
 * peer-dependent trust signal that must NOT grant local routing eligibility.
 */
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

/**
 * A FEDERATED (peer-relayed) CROWD EVENT — origin.kind "crowd" with the reporter
 * (and its keyId) STRIPPED on export, carrying a NON-EMPTY originChain (≥1 hop).
 * This is the genuinely-federated crowd row the strict landing guard skips and
 * that only `allowFederatedTarget: true` may route (on a LOCAL feed).
 */
async function insertFederatedCrowdEvent(opts: EventOpts): Promise<void> {
  const type = opts.type ?? "hazard";
  const fp = phenomenonFingerprint({
    kind: "event",
    domain: "roads",
    type,
    geometry: { type: "Point", coordinates: [opts.lon, opts.lat] },
    validFrom: opts.validFrom,
  } as ConditionEvent);
  const origin = {
    kind: "crowd",
    attribution: { provider: "Peer X", license: "ODbL-1.0" },
    originChain: [{ instanceId: "peer-x", viaPeer: "peer-x", receivedAt: opts.validFrom }],
  };
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, type, status, geom, origin,
       valid_from, phenomenon_fingerprint, data_updated_at, fetched_at, is_stale)
    VALUES
      (${opts.id}, ${opts.source ?? "peer-x"}, 'native', 'roads', 'event', ${type},
       ${opts.status ?? "active"},
       ST_SetSRID(ST_MakePoint(${opts.lon}, ${opts.lat}), 4326),
       ${sql.json(origin as never)},
       ${opts.validFrom}, ${fp}, ${opts.validFrom}, now(), false)`;
  // Mirror the federated landing: a `report` evidence row with a NULL actor key
  // (no federated reporter key), so applyExternalResolution has an originator row
  // to read — resolving to NULL → trains nobody.
  await sql`
    INSERT INTO conditions.report_evidence
      (observation_id, evidence_kind, actor_key_id, occurred_at, details)
    VALUES (${opts.id}, 'report', ${null}, ${opts.validFrom}, '{}'::jsonb)`;
}

/**
 * A keyId-less CROWD EVENT WITHOUT an originChain — a local anomaly that should
 * never exist (a local crowd row always carries a reporter keyId). Even under
 * allowFederatedTarget it must NOT route: an empty/absent originChain fails the
 * genuinely-federated check.
 */
async function insertKeyIdlessCrowdNoChain(opts: EventOpts): Promise<void> {
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
      (${opts.id}, ${opts.source ?? "peer-x"}, 'native', 'roads', 'event', ${type},
       ${opts.status ?? "active"},
       ST_SetSRID(ST_MakePoint(${opts.lon}, ${opts.lat}), 4326),
       ${sql.json({ kind: "crowd" } as never)},
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

interface ReporterRow {
  reputation_alpha: number;
  reputation_beta: number;
}

async function readReporter(keyId: string): Promise<ReporterRow> {
  const rows = await sql<ReporterRow[]>`
    SELECT reputation_alpha, reputation_beta FROM conditions.reporter WHERE key_id = ${keyId}`;
  return rows[0]!;
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

/** A stable snapshot of every reporter's trainable columns, to assert nobody was trained. */
async function reporterSnapshot(): Promise<string> {
  const rows = await sql<{ key_id: string; a: number; b: number; c: number }[]>`
    SELECT key_id, reputation_alpha AS a, reputation_beta AS b, corroborated_count AS c
    FROM conditions.reporter ORDER BY key_id`;
  return JSON.stringify(rows);
}

async function externalEvidenceCount(obsId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM conditions.report_evidence
    WHERE observation_id = ${obsId}
      AND evidence_kind IN ('official_match', 'reviewer_accept', 'reviewer_reject')`;
  return rows[0]!.n;
}

describe("crossValidateAgainstFeeds — official cross-validation routing", () => {
  it("routes a crowd report that phenomenon-matches an OFFICIAL FEED: externally_resolved + routing + reputation trained", async () => {
    await seedCrowdReport({
      id: "xv:crowd-match",
      lon: 6.5,
      lat: 52.0,
      validFrom: T_REPORT,
      reporterKey: "xv-rep-match",
    });
    await insertFeedEvent({
      id: "xv:feed-match",
      lon: 6.5001,
      lat: 52.0,
      validFrom: "2026-07-12T08:04:00.000Z",
    });

    const matched = await crossValidateAgainstFeeds(sql, "xv:crowd-match", T_RESOLVE);
    expect(matched).toBe("xv:feed-match");

    const crowd = await obs("xv:crowd-match");
    expect(crowd.evidence_state).toBe("externally_resolved");
    expect(crowd.routing_eligible).toBe(true);

    // The reporter's Beta posterior was trained (α incremented from the prior 2).
    expect((await readReporter("xv-rep-match")).reputation_alpha).toBe(3);

    // Exactly one external `official_match` row on the CROWD observation.
    expect(await externalEvidenceCount("xv:crowd-match")).toBe(1);

    // ...and it NAMES the feed row that routed the report. External resolution
    // is the only path to routing_eligible, so which row said so must be
    // auditable — not an unattributable "an official feed confirmed this".
    const official = await sql<
      { source_id: string | null; details: { source?: string; matchedObservationId?: string } }[]
    >`
      SELECT source_id, details FROM conditions.report_evidence
      WHERE observation_id = 'xv:crowd-match' AND evidence_kind = 'official_match'`;
    expect(official[0]!.details.matchedObservationId).toBe("xv:feed-match");
    expect(official[0]!.source_id).toBe("ndw");
    expect(official[0]!.details.source).toBe("official");

    // The FEED observation is authoritative and untouched — no evidence appended.
    expect(await externalEvidenceCount("xv:feed-match")).toBe(0);
    expect((await obs("xv:feed-match")).status).toBe("active");
  }, 30_000);

  it("does NOT route when the only neighbor is another CROWD report (crowd↔crowd stays non-routing, reputation untouched)", async () => {
    await seedCrowdReport({
      id: "xv:crowd-only",
      lon: 5.0,
      lat: 51.0,
      validFrom: T_REPORT,
      reporterKey: "xv-rep-crowdonly",
    });
    // A second, independent CROWD report of the same phenomenon (no feed nearby).
    await insertCrowdEvent({
      id: "xv:crowd-neighbor",
      lon: 5.0001,
      lat: 51.0,
      validFrom: "2026-07-12T08:04:00.000Z",
      reporterKey: "xv-rep-neighbor",
    });

    const matched = await crossValidateAgainstFeeds(sql, "xv:crowd-only", T_RESOLVE);
    expect(matched).toBeNull();

    const crowd = await obs("xv:crowd-only");
    expect(crowd.routing_eligible).toBe(false);
    expect(crowd.evidence_state).not.toBe("externally_resolved");
    expect(await externalEvidenceCount("xv:crowd-only")).toBe(0);
    // Reputation is NEVER trained by a crowd-only landing.
    expect((await readReporter("xv-rep-crowdonly")).reputation_alpha).toBe(2);
    expect((await readReporter("xv-rep-crowdonly")).reputation_beta).toBe(2);
  }, 30_000);

  it("does NOT route against a keyId-less REMOTE CROWD row (federation strips reporter, keeps kind=crowd)", async () => {
    await seedCrowdReport({
      id: "xv:crowd-vs-remote",
      lon: 7.0,
      lat: 53.0,
      validFrom: T_REPORT,
      reporterKey: "xv-rep-remote",
    });
    // A federation-exported peer crowd report: origin.kind stays "crowd" but the
    // reporter (and its keyId) was stripped on export. It lands active with a
    // phenomenon_fingerprint, so it enters the neighborhood — but it is NOT a feed
    // and must never route a local crowd report.
    const fp = phenomenonFingerprint({
      kind: "event",
      domain: "roads",
      type: "hazard",
      geometry: { type: "Point", coordinates: [7.0001, 53.0] },
      validFrom: "2026-07-12T08:04:00.000Z",
    } as ConditionEvent);
    await sql`
      INSERT INTO conditions.observations
        (id, source, source_format, domain, kind, type, status, geom, origin,
         valid_from, phenomenon_fingerprint, data_updated_at, fetched_at, is_stale)
      VALUES
        ('xv:remote-crowd', 'peer-a', 'native', 'roads', 'event', 'hazard', 'active',
         ST_SetSRID(ST_MakePoint(7.0001, 53.0), 4326),
         ${sql.json({ kind: "crowd" } as never)},
         '2026-07-12T08:04:00.000Z', ${fp}, '2026-07-12T08:04:00.000Z', now(), false)`;

    expect(await crossValidateAgainstFeeds(sql, "xv:crowd-vs-remote", T_RESOLVE)).toBeNull();
    const crowd = await obs("xv:crowd-vs-remote");
    expect(crowd.routing_eligible).toBe(false);
    expect(crowd.evidence_state).not.toBe("externally_resolved");
    expect(await externalEvidenceCount("xv:crowd-vs-remote")).toBe(0);
    // The keyId-less crowd row was not treated as a feed → reporter untrained.
    expect((await readReporter("xv-rep-remote")).reputation_alpha).toBe(2);
  }, 30_000);

  it("does NOT route a FLAGGED (disputed) crowd report even when a feed matches", async () => {
    await seedCrowdReport({
      id: "xv:crowd-flagged",
      lon: 6.9,
      lat: 52.9,
      validFrom: T_REPORT,
      reporterKey: "xv-rep-flagged",
    });
    await sql`UPDATE conditions.observations SET flagged_at = ${T_REPORT} WHERE id = 'xv:crowd-flagged'`;
    await insertFeedEvent({
      id: "xv:feed-for-flagged",
      lon: 6.9001,
      lat: 52.9,
      validFrom: "2026-07-12T08:04:00.000Z",
    });

    expect(await crossValidateAgainstFeeds(sql, "xv:crowd-flagged", T_RESOLVE)).toBeNull();
    const crowd = await obs("xv:crowd-flagged");
    expect(crowd.routing_eligible).toBe(false);
    expect(await externalEvidenceCount("xv:crowd-flagged")).toBe(0);
    expect((await readReporter("xv-rep-flagged")).reputation_alpha).toBe(2);
  }, 30_000);

  it("does NOT route against a feed within the fingerprint neighborhood but TOO FAR (> 250 m)", async () => {
    // Both points sit inside the same 3x3 fingerprint neighborhood (so the feed
    // IS a candidate), but their centroids are ~267 m apart — past the matcher's
    // 250 m gate — so matchPhenomenonCandidates rejects on distance, not because
    // the feed was never a candidate.
    await seedCrowdReport({
      id: "xv:crowd-far",
      lon: 0.00005,
      lat: 0.00005,
      validFrom: T_REPORT,
      reporterKey: "xv-rep-far",
    });
    await insertFeedEvent({
      id: "xv:feed-far",
      lon: 0.00175,
      lat: 0.00175,
      validFrom: "2026-07-12T08:04:00.000Z",
    });

    expect(await crossValidateAgainstFeeds(sql, "xv:crowd-far", T_RESOLVE)).toBeNull();
    expect((await obs("xv:crowd-far")).routing_eligible).toBe(false);
    expect((await readReporter("xv-rep-far")).reputation_alpha).toBe(2);
  }, 30_000);

  it("does NOT route against a feed of a DIFFERENT type", async () => {
    await seedCrowdReport({
      id: "xv:crowd-diff-type",
      lon: 4.0,
      lat: 50.0,
      validFrom: T_REPORT,
      type: "hazard",
      reporterKey: "xv-rep-difftype",
    });
    await insertFeedEvent({
      id: "xv:feed-diff-type",
      lon: 4.0001,
      lat: 50.0,
      validFrom: "2026-07-12T08:04:00.000Z",
      type: "congestion",
    });

    expect(await crossValidateAgainstFeeds(sql, "xv:crowd-diff-type", T_RESOLVE)).toBeNull();
    expect((await obs("xv:crowd-diff-type")).routing_eligible).toBe(false);
    expect((await readReporter("xv-rep-difftype")).reputation_alpha).toBe(2);
  }, 30_000);

  it("does NOT route against a feed OUTSIDE the temporal window", async () => {
    await seedCrowdReport({
      id: "xv:crowd-late",
      lon: 3.0,
      lat: 49.0,
      validFrom: T_REPORT,
      reporterKey: "xv-rep-late",
    });
    // Same cell but > 15 min apart (default maxValidFromDeltaSec = 900).
    await insertFeedEvent({
      id: "xv:feed-late",
      lon: 3.0001,
      lat: 49.0,
      validFrom: "2026-07-12T08:40:00.000Z",
    });

    expect(await crossValidateAgainstFeeds(sql, "xv:crowd-late", T_RESOLVE)).toBeNull();
    expect((await obs("xv:crowd-late")).routing_eligible).toBe(false);
  }, 30_000);

  it("treats a crowd↔feed pair as INDEPENDENT even when their source strings coincide", async () => {
    // The crowd report's `source` deliberately equals the feed's `source`. The
    // matcher's same-source guard applies only to feed↔feed pairs, so this must
    // still route.
    await seedCrowdReport({
      id: "xv:crowd-samesrc",
      lon: 2.0,
      lat: 48.0,
      validFrom: T_REPORT,
      source: "ndw",
      reporterKey: "xv-rep-samesrc",
    });
    await insertFeedEvent({
      id: "xv:feed-samesrc",
      lon: 2.0001,
      lat: 48.0,
      validFrom: "2026-07-12T08:04:00.000Z",
      source: "ndw",
    });

    expect(await crossValidateAgainstFeeds(sql, "xv:crowd-samesrc", T_RESOLVE)).toBe(
      "xv:feed-samesrc"
    );
    expect((await obs("xv:crowd-samesrc")).evidence_state).toBe("externally_resolved");
    expect((await readReporter("xv-rep-samesrc")).reputation_alpha).toBe(3);
  }, 30_000);

  it("is idempotent: replaying the cross-validation does not double-insert or double-train", async () => {
    await seedCrowdReport({
      id: "xv:crowd-idem",
      lon: 1.0,
      lat: 47.0,
      validFrom: T_REPORT,
      reporterKey: "xv-rep-idem",
    });
    await insertFeedEvent({
      id: "xv:feed-idem",
      lon: 1.0001,
      lat: 47.0,
      validFrom: "2026-07-12T08:04:00.000Z",
    });

    await crossValidateAgainstFeeds(sql, "xv:crowd-idem", T_RESOLVE);
    await crossValidateAgainstFeeds(sql, "xv:crowd-idem", "2026-07-12T08:20:00.000Z");

    expect(await externalEvidenceCount("xv:crowd-idem")).toBe(1);
    expect((await readReporter("xv-rep-idem")).reputation_alpha).toBe(3);
  }, 30_000);

  it("does NOT route against a FEDERATED (peer-relayed) feed — only local official feeds cross-validate", async () => {
    await seedCrowdReport({
      id: "xv:crowd-vs-federated",
      lon: 8.0,
      lat: 54.0,
      validFrom: T_REPORT,
      reporterKey: "xv-rep-federated",
    });
    // An official feed relayed from a peer: origin.kind "feed" but carrying an
    // originChain hop. A weaker, peer-dependent signal that must not route.
    await insertFederatedFeedEvent({
      id: "xv:feed-federated",
      lon: 8.0001,
      lat: 54.0,
      validFrom: "2026-07-12T08:04:00.000Z",
    });

    expect(await crossValidateAgainstFeeds(sql, "xv:crowd-vs-federated", T_RESOLVE)).toBeNull();
    const crowd = await obs("xv:crowd-vs-federated");
    expect(crowd.routing_eligible).toBe(false);
    expect(crowd.evidence_state).not.toBe("externally_resolved");
    expect(await externalEvidenceCount("xv:crowd-vs-federated")).toBe(0);
    // The federated feed did not train the reporter.
    expect((await readReporter("xv-rep-federated")).reputation_alpha).toBe(2);
  }, 30_000);

  it("routes via the LOCAL feed only when both a LOCAL and a FEDERATED feed match", async () => {
    await seedCrowdReport({
      id: "xv:crowd-both",
      lon: 9.0,
      lat: 55.0,
      validFrom: T_REPORT,
      reporterKey: "xv-rep-both",
    });
    // A local official feed AND a federated (peer-relayed) feed both match the
    // same crowd report; routing must go through the LOCAL one.
    await insertFeedEvent({
      id: "xv:feed-local-both",
      lon: 9.0001,
      lat: 55.0,
      validFrom: "2026-07-12T08:04:00.000Z",
    });
    await insertFederatedFeedEvent({
      id: "xv:feed-federated-both",
      lon: 9.00015,
      lat: 55.0,
      validFrom: "2026-07-12T08:05:00.000Z",
    });

    const matched = await crossValidateAgainstFeeds(sql, "xv:crowd-both", T_RESOLVE);
    expect(matched).toBe("xv:feed-local-both");

    const crowd = await obs("xv:crowd-both");
    expect(crowd.evidence_state).toBe("externally_resolved");
    expect(crowd.routing_eligible).toBe(true);
    expect((await readReporter("xv-rep-both")).reputation_alpha).toBe(3);
    // The crowd report resolved via exactly ONE external (official_match) row —
    // the local feed — not two: the federated feed did not also cross-validate it.
    expect(await externalEvidenceCount("xv:crowd-both")).toBe(1);
    // The federated feed is authoritative-but-untrusted-for-routing and untouched.
    expect(await externalEvidenceCount("xv:feed-federated-both")).toBe(0);
  }, 30_000);

  it("no-ops (returns null) when the just-landed observation is itself a FEED", async () => {
    await insertFeedEvent({
      id: "xv:target-is-feed",
      lon: 0.0,
      lat: 46.0,
      validFrom: T_REPORT,
    });
    await insertFeedEvent({
      id: "xv:feed-neighbor",
      lon: 0.0001,
      lat: 46.0,
      validFrom: "2026-07-12T08:04:00.000Z",
      source: "other",
    });

    expect(await crossValidateAgainstFeeds(sql, "xv:target-is-feed", T_RESOLVE)).toBeNull();
    expect(await externalEvidenceCount("xv:target-is-feed")).toBe(0);
  }, 30_000);

  it("returns null for a non-existent observation", async () => {
    expect(await crossValidateAgainstFeeds(sql, "xv:nope", T_RESOLVE)).toBeNull();
  }, 30_000);
});

describe("crossValidateAgainstFeeds — allowFederatedTarget (route-without-training)", () => {
  it("routes a FEDERATED crowd target on a LOCAL feed and trains NOBODY", async () => {
    await insertFederatedCrowdEvent({
      id: "xvf:fed-crowd",
      lon: 10.5,
      lat: 48.5,
      validFrom: T_REPORT,
    });
    await insertFeedEvent({
      id: "xvf:local-feed",
      lon: 10.5001,
      lat: 48.5,
      validFrom: "2026-07-12T08:04:00.000Z",
    });
    // Seed a reporter so the "trains nobody" snapshot is a genuine, self-contained
    // comparison even when this test runs in isolation (not an empty [] === []).
    await insertReporter("xvf-witness");

    const before = await reporterSnapshot();
    const matched = await crossValidateAgainstFeeds(sql, "xvf:fed-crowd", T_RESOLVE, {
      allowFederatedTarget: true,
    });
    expect(matched).toBe("xvf:local-feed");

    const crowd = await obs("xvf:fed-crowd");
    expect(crowd.evidence_state).toBe("externally_resolved");
    expect(crowd.routing_eligible).toBe(true);
    expect(await externalEvidenceCount("xvf:fed-crowd")).toBe(1);
    // The trust anchor is OUR local feed; the feed itself is untouched.
    expect(await externalEvidenceCount("xvf:local-feed")).toBe(0);
    // No reporter row's alpha/beta/corroborated_count changed anywhere.
    expect(await reporterSnapshot()).toBe(before);
  }, 30_000);

  it("THE #3 FIX: routes a federated crowd target on a LOCAL feed whose SOURCE STRING COINCIDES, training nobody", async () => {
    // The federated crowd row's `source` deliberately equals the local feed's
    // `source` ("ndw"). Before A4, the matcher inferred crowd-vs-feed from keyId
    // presence: a federated crowd row is keyId-less, so it read as feed-like and
    // the same-source guard fail-closed BLOCKED the route (the #3 missed route).
    // Keyed on the real origin.kind, the crowd/feed pair is independent → routes.
    await insertFederatedCrowdEvent({
      id: "xvf:fed-crowd-samesrc",
      lon: 16.5,
      lat: 44.5,
      validFrom: T_REPORT,
      source: "ndw",
    });
    await insertFeedEvent({
      id: "xvf:local-feed-samesrc",
      lon: 16.5001,
      lat: 44.5,
      validFrom: "2026-07-12T08:04:00.000Z",
      source: "ndw",
    });
    await insertReporter("xvf-samesrc-witness");

    const before = await reporterSnapshot();
    const matched = await crossValidateAgainstFeeds(sql, "xvf:fed-crowd-samesrc", T_RESOLVE, {
      allowFederatedTarget: true,
    });
    expect(matched).toBe("xvf:local-feed-samesrc");

    const crowd = await obs("xvf:fed-crowd-samesrc");
    expect(crowd.evidence_state).toBe("externally_resolved");
    expect(crowd.routing_eligible).toBe(true);
    expect(await externalEvidenceCount("xvf:fed-crowd-samesrc")).toBe(1);
    // The feed itself is authoritative and untouched, and nobody was trained.
    expect(await externalEvidenceCount("xvf:local-feed-samesrc")).toBe(0);
    expect(await reporterSnapshot()).toBe(before);
  }, 30_000);

  it("does NOT route a federated crowd target matching only a FEDERATED feed", async () => {
    await insertFederatedCrowdEvent({
      id: "xvf:fed-crowd-vs-fedfeed",
      lon: 11.5,
      lat: 49.5,
      validFrom: T_REPORT,
    });
    await insertFederatedFeedEvent({
      id: "xvf:fed-feed-only",
      lon: 11.5001,
      lat: 49.5,
      validFrom: "2026-07-12T08:04:00.000Z",
    });

    expect(
      await crossValidateAgainstFeeds(sql, "xvf:fed-crowd-vs-fedfeed", T_RESOLVE, {
        allowFederatedTarget: true,
      })
    ).toBeNull();
    const crowd = await obs("xvf:fed-crowd-vs-fedfeed");
    expect(crowd.routing_eligible).toBe(false);
    expect(crowd.evidence_state).not.toBe("externally_resolved");
    expect(await externalEvidenceCount("xvf:fed-crowd-vs-fedfeed")).toBe(0);
  }, 30_000);

  it("does NOT route a federated FEED row as target even with allowFederatedTarget (kind==='crowd' guard)", async () => {
    // A federated FEED row is ALSO keyId-less + originChain-present, but it is a
    // feed, not crowd — it must never become a routable target.
    await insertFederatedFeedEvent({
      id: "xvf:fed-feed-target",
      lon: 12.5,
      lat: 50.5,
      validFrom: T_REPORT,
    });
    await insertFeedEvent({
      id: "xvf:local-feed-for-fedtarget",
      lon: 12.5001,
      lat: 50.5,
      validFrom: "2026-07-12T08:04:00.000Z",
      source: "other",
    });

    expect(
      await crossValidateAgainstFeeds(sql, "xvf:fed-feed-target", T_RESOLVE, {
        allowFederatedTarget: true,
      })
    ).toBeNull();
    expect(await externalEvidenceCount("xvf:fed-feed-target")).toBe(0);
  }, 30_000);

  it("does NOT route a keyId-less crowd target WITHOUT an originChain even with allowFederatedTarget", async () => {
    await insertKeyIdlessCrowdNoChain({
      id: "xvf:crowd-no-chain",
      lon: 13.5,
      lat: 51.5,
      validFrom: T_REPORT,
    });
    await insertFeedEvent({
      id: "xvf:feed-for-nochain",
      lon: 13.5001,
      lat: 51.5,
      validFrom: "2026-07-12T08:04:00.000Z",
    });

    expect(
      await crossValidateAgainstFeeds(sql, "xvf:crowd-no-chain", T_RESOLVE, {
        allowFederatedTarget: true,
      })
    ).toBeNull();
    expect((await obs("xvf:crowd-no-chain")).routing_eligible).toBe(false);
    expect(await externalEvidenceCount("xvf:crowd-no-chain")).toBe(0);
  }, 30_000);

  it("keeps the STRICT guard by default: a federated crowd target does NOT route without allowFederatedTarget", async () => {
    await insertFederatedCrowdEvent({
      id: "xvf:fed-crowd-strict",
      lon: 14.5,
      lat: 52.5,
      validFrom: T_REPORT,
    });
    await insertFeedEvent({
      id: "xvf:feed-strict",
      lon: 14.5001,
      lat: 52.5,
      validFrom: "2026-07-12T08:04:00.000Z",
    });

    // No deps → allowFederatedTarget defaults false → the crowd-landing/sweep guard.
    expect(await crossValidateAgainstFeeds(sql, "xvf:fed-crowd-strict", T_RESOLVE)).toBeNull();
    expect((await obs("xvf:fed-crowd-strict")).routing_eligible).toBe(false);
    expect(await externalEvidenceCount("xvf:fed-crowd-strict")).toBe(0);
  }, 30_000);

  it("is idempotent under allowFederatedTarget: replaying does not double-insert or re-route", async () => {
    await insertFederatedCrowdEvent({
      id: "xvf:fed-crowd-idem",
      lon: 15.5,
      lat: 53.5,
      validFrom: T_REPORT,
    });
    await insertFeedEvent({
      id: "xvf:feed-idem",
      lon: 15.5001,
      lat: 53.5,
      validFrom: "2026-07-12T08:04:00.000Z",
    });
    // Self-contained snapshot: at least one reporter exists to prove nobody trained.
    await insertReporter("xvf-idem-witness");

    const before = await reporterSnapshot();
    await crossValidateAgainstFeeds(sql, "xvf:fed-crowd-idem", T_RESOLVE, {
      allowFederatedTarget: true,
    });
    await crossValidateAgainstFeeds(sql, "xvf:fed-crowd-idem", "2026-07-12T08:20:00.000Z", {
      allowFederatedTarget: true,
    });

    expect(await externalEvidenceCount("xvf:fed-crowd-idem")).toBe(1);
    expect((await obs("xvf:fed-crowd-idem")).routing_eligible).toBe(true);
    expect(await reporterSnapshot()).toBe(before);
  }, 30_000);
});
