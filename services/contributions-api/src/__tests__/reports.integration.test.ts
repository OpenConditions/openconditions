import {
  generateReporterKey,
  type ReporterKey,
  type SignedReport,
  type SituationClaim,
  signReport,
} from "@openconditions/contrib-core";
import { reliabilityLowerBound } from "@openconditions/core";
import {
  buildRegistry,
  crowdLocalId,
  crowdRulesFor,
  type RegistryModule,
} from "@openconditions/model";
import { productionModules } from "@openconditions/model-registry";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReportingGrant } from "../attester/grant.js";
import { build } from "../server.js";
import {
  createTestDatabase,
  evidenceOf,
  feedSituationDraft,
  INSTANCE,
  registry,
  reportAs,
  seedFeedSituation,
  situationClaim,
} from "./crowd-fixtures.integration.js";

const NOW = "2026-07-12T08:00:00.000Z";
const GRANT_SECRET_VALUE = "reports-route-test-secret";
const GRANT_SECRET = new TextEncoder().encode(GRANT_SECRET_VALUE);
const ENV = {
  OPENCONDITIONS_GRANT_SECRET: GRANT_SECRET_VALUE,
  OPENCONDITIONS_INSTANCE_ID: INSTANCE,
};
/** An obstruction's crowd lifetime: the default claim's. */
const OBSTRUCTION_TTL_MS =
  crowdRulesFor(registry, { class: "situation", kind: "incident", type: "obstruction" })!.ttlSec *
  1000;

/**
 * The production registry with police presence open to the crowd, so the
 * police gate itself can be reached: production gives `authority` no crowd
 * rules, and such a claim fails verification before any gate.
 */
const policeRegistry = buildRegistry(
  productionModules.map(
    (module): RegistryModule =>
      module.name !== "roads"
        ? module
        : {
            ...module,
            entries: module.entries.map((entry) =>
              entry.entry === "kind" && entry.class === "situation" && entry.code === "authority"
                ? { ...entry, crowd: { ttlSec: 3600, maxLifetimeSec: 4 * 3600 } }
                : entry,
            ),
          },
  ),
);

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
let app: FastifyInstance;
/** An instance whose registry lets the crowd report police presence; the category stays off. */
let appPoliceRegistry: FastifyInstance;
/** The same registry with the police category explicitly enabled. */
let appPoliceEnabled: FastifyInstance;
let ipCounter = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  app = await build({ sql, env: ENV, logger: false, now: () => NOW });
  appPoliceRegistry = await build({
    sql,
    registry: policeRegistry,
    env: ENV,
    logger: false,
    now: () => NOW,
  });
  appPoliceEnabled = await build({
    sql,
    registry: policeRegistry,
    env: { ...ENV, OPENCONDITIONS_ALLOW_POLICE_CATEGORY: "true" },
    logger: false,
    now: () => NOW,
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await appPoliceRegistry?.close();
  await appPoliceEnabled?.close();
  await db?.close();
}, 30_000);

/** A fresh per-call source IP so the enrollment per-IP limiter never trips. */
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
}

/** The id a crowd report from a key with a nonce lands under here. */
function crowdId(key: ReporterKey, nonce: string): string {
  return `oc:situation:${INSTANCE}:${crowdLocalId(key.keyId, nonce)}`;
}

// Landing auto-corroborates two INDEPENDENT reports of the same phenomenon, so
// tests that don't override geometry each land at their OWN coordinate. Tests
// that care about a shared phenomenon override geometry explicitly.
let claimGeomCounter = 0;
function nextClaimGeometry(): SituationClaim["geometry"] {
  const lon = 9.0 + claimGeomCounter * 0.3;
  claimGeomCounter += 1;
  return { type: "Point", coordinates: [lon, 44.0] };
}

function makeClaim(overrides: Partial<SituationClaim> = {}): SituationClaim {
  return situationClaim({ geometry: nextClaimGeometry(), reportedAt: NOW, ...overrides });
}

async function enroll(key: ReporterKey): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/contrib/enroll",
    payload: { pubJwk: key.publicJwk, proof: { keyId: key.keyId } },
    remoteAddress: nextIp(),
  });
  return (res.json() as { reportingGrant: string }).reportingGrant;
}

function sign(key: ReporterKey, overrides: Partial<SituationClaim> = {}): Promise<SignedReport> {
  return reportAs(key, makeClaim(overrides));
}

/**
 * A report whose claim the registry refuses. Signing refuses such a claim, so
 * a valid report's claim is swapped: verification checks the claim against
 * the registry before it checks the signature.
 */
async function withClaim(key: ReporterKey, claim: unknown): Promise<SignedReport> {
  const valid = await sign(key, { nonce: "forged-base-000001" });
  return { ...valid, claim: claim as SignedReport["claim"] };
}

async function postReport(
  report: SignedReport,
  reportingGrant: string,
  instance: FastifyInstance = app,
) {
  return instance.inject({
    method: "POST",
    url: "/contrib/reports",
    payload: { report, reportingGrant },
  });
}

interface LandedRow {
  origin: string;
  source_id: string;
  evidence_state: string | null;
  routing_eligible: boolean;
  confidence_score: number | null;
  corroborations: number;
  expires_at: Date | null;
  tombstone_reason: string | null;
  record: Record<string, unknown>;
}

async function readSituation(id: string): Promise<LandedRow | undefined> {
  const rows = await sql<LandedRow[]>`
    SELECT origin, source_id, evidence_state, routing_eligible, confidence_score,
           corroborations, expires_at, tombstone_reason, record
    FROM conditions.situation WHERE id = ${id}`;
  return rows[0];
}

async function countEvidence(id: string, kind?: string): Promise<number> {
  const [row] = kind
    ? await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM conditions.report_evidence
        WHERE record_class = 'situation' AND record_id = ${id} AND evidence_kind = ${kind}`
    : await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM conditions.report_evidence
        WHERE record_class = 'situation' AND record_id = ${id}`;
  return row!.n;
}

describe("POST /contrib/reports — happy path landing", () => {
  it("lands a signed claim as a crowd situation with landed provenance and evidence", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await sign(key, { nonce: "happy-000000000001" });

    const res = await postReport(report, grant);
    expect(res.statusCode).toBe(200);
    const id = crowdId(key, "happy-000000000001");
    expect(res.json()).toEqual({
      record: { class: "situation", id },
      evidenceState: "self_reported",
      routingEligible: false,
    });

    const row = await readSituation(id);
    expect(row).toMatchObject({
      origin: "crowd",
      source_id: "crowd",
      evidence_state: "self_reported",
      routing_eligible: false,
      corroborations: 0,
      tombstone_reason: null,
    });
    expect(row!.confidence_score).toBeCloseTo(0.3, 10);
    // An obstruction lives its crowd lifetime from when it was reported.
    const expires = new Date(Date.parse(NOW) + OBSTRUCTION_TTL_MS);
    expect(row!.expires_at).toEqual(expires);
    expect(row!.record).toMatchObject({
      class: "situation",
      kind: "incident",
      type: "obstruction",
      validity: { status: "active", start: NOW },
      freshness: { fetchedAt: NOW, expiresAt: expires.toISOString() },
      location: { geometryOrigin: "crowd_device" },
      provenance: {
        origin: "crowd",
        sourceId: "crowd",
        privacy: { class: "crowd_pseudonym" },
        attribution: {
          provider: `OpenConditions contributors at ${INSTANCE}`,
          license: "ODbL-1.0",
        },
      },
    });

    const evidence = await sql<{ actor_key_id: string; details: Record<string, unknown> }[]>`
      SELECT actor_key_id, details FROM conditions.report_evidence
      WHERE record_class = 'situation' AND record_id = ${id} AND evidence_kind = 'report'`;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.actor_key_id).toBe(key.keyId);
    expect(evidence[0]!.details).toMatchObject({ reportedAt: NOW, cell: expect.any(String) });
  }, 60_000);

  it("keeps only the reporter's key on the record, never its signature, and the id hides the key", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await sign(key, { nonce: "minimal-00000000001" });
    expect((await postReport(report, grant)).statusCode).toBe(200);

    const id = crowdId(key, "minimal-00000000001");
    expect(id).not.toContain(key.keyId);
    const row = await readSituation(id);
    const provenance = row!.record["provenance"] as Record<string, unknown>;
    expect(provenance["reporter"]).toEqual({ keyId: key.keyId });
    expect(JSON.stringify(row!.record)).not.toContain(report.signature);
  }, 60_000);

  it("counts a late upload's lifetime from when it was reported, not when it arrived", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const reportedAt = "2026-07-12T07:50:00.000Z";
    const res = await postReport(
      await sign(key, { nonce: "late-upload-000001", reportedAt }),
      grant,
    );
    expect(res.statusCode).toBe(200);

    const row = await readSituation(crowdId(key, "late-upload-000001"));
    expect(row!.expires_at).toEqual(new Date(Date.parse(reportedAt) + OBSTRUCTION_TTL_MS));
    expect(row!.record).toMatchObject({ validity: { start: reportedAt } });
  }, 60_000);
});

describe("POST /contrib/reports — idempotent replay", () => {
  it("replaying the same nonce returns the same record and adds no evidence row", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await sign(key, { nonce: "replay-000000000001" });

    const first = await postReport(report, grant);
    const second = await postReport(report, grant);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());

    expect(await countEvidence(crowdId(key, "replay-000000000001"))).toBe(1);
  }, 60_000);
});

describe("POST /contrib/reports — rejections at the trust boundary", () => {
  it("rejects an unenrolled key with 403 and never auto-creates a reporter row", async () => {
    const key = await generateReporterKey();
    // A directly-minted grant is valid, but no enrollment ran → no reporter row.
    const grant = await createReportingGrant(key.keyId, NOW, GRANT_SECRET);
    const report = await sign(key, { nonce: "unenrolled-00000001" });

    const before = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.reporter WHERE key_id = ${key.keyId}`;
    expect(before[0]!.n).toBe(0);

    const res = await postReport(report, grant);
    expect(res.statusCode).toBe(403);

    const after = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.reporter WHERE key_id = ${key.keyId}`;
    expect(after[0]!.n).toBe(0);
  }, 60_000);

  it("rejects a blocked reporter with 403", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    await sql`UPDATE conditions.reporter SET status = 'blocked' WHERE key_id = ${key.keyId}`;
    const report = await sign(key, { nonce: "blocked-0000000001" });

    const res = await postReport(report, grant);
    expect(res.statusCode).toBe(403);
  }, 60_000);

  it("rejects a bad grant with 401", async () => {
    const key = await generateReporterKey();
    await enroll(key);
    const report = await sign(key, { nonce: "badgrant-000000001" });

    const res = await postReport(report, "bogus.grant");
    expect(res.statusCode).toBe(401);
  }, 60_000);

  it("rejects a grant minted for a different key with 401 (grant binds the key)", async () => {
    const keyA = await generateReporterKey();
    const keyB = await generateReporterKey();
    await enroll(keyA);
    const grantForB = await createReportingGrant(keyB.keyId, NOW, GRANT_SECRET);
    const reportFromA = await sign(keyA, { nonce: "wrongkey-000000001" });

    const res = await postReport(reportFromA, grantForB);
    expect(res.statusCode).toBe(401);
  }, 60_000);

  it("rejects a tampered signature with 400", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await sign(key, { nonce: "tampered-000000001" });
    const tampered: SignedReport = {
      ...report,
      signature: report.signature.slice(0, -4) + (report.signature.endsWith("A") ? "BBBB" : "AAAA"),
    };

    const res = await postReport(tampered, grant);
    expect(res.statusCode).toBe(400);
  }, 60_000);

  it("rejects a claim the registry refuses with 400 at verification and writes nothing", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const claim = makeClaim({ nonce: "bad-type-000000001", type: "teleporter" });

    const res = await postReport(await withClaim(key, claim), grant);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/report verification failed/);
    expect(await readSituation(crowdId(key, "bad-type-000000001"))).toBeUndefined();
  }, 60_000);

  it("rejects a claim carrying fields outside the model (an attributes bag) with 400", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const claim = {
      ...makeClaim({ nonce: "attributes-0000001" }),
      attributes: { media: "data:image/png;base64,AAAA" },
    };

    const res = await postReport(await withClaim(key, claim), grant);
    expect(res.statusCode).toBe(400);
    expect(await readSituation(crowdId(key, "attributes-0000001"))).toBeUndefined();
  }, 60_000);

  it("rejects an out-of-range geometry with 400: the claim schema refuses it before the screen", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const claim = makeClaim({
      nonce: "oob-geo-000000001",
      geometry: { type: "Point", coordinates: [999, 52] },
    });

    const res = await postReport(await withClaim(key, claim), grant);
    expect(res.statusCode).toBe(400);
    expect(await readSituation(crowdId(key, "oob-geo-000000001"))).toBeUndefined();
  }, 60_000);

  it("rejects a nested-position geometry with 400 and never reaches the DB (no 500)", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const claim = makeClaim({
      nonce: "arity-mismatch-0001",
      geometry: { type: "Point", coordinates: [[4.9, 52.37]] } as never,
    });

    const res = await postReport(await withClaim(key, claim), grant);
    expect(res.statusCode).toBe(400);
    expect(await readSituation(crowdId(key, "arity-mismatch-0001"))).toBeUndefined();
  }, 60_000);

  it("rejects a 3D position with 422 at the geometry screen (records are 2D), no DB round-trip", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await sign(key, {
      nonce: "three-dee-00000001",
      geometry: { type: "Point", coordinates: [4.9, 52.37, 12] },
    });

    const res = await postReport(report, grant);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { reasons: string[] }).reasons).toContain("geometry_malformed");
    expect(await readSituation(crowdId(key, "three-dee-00000001"))).toBeUndefined();
  }, 60_000);

  it("refuses an observation claim about a feature this instance does not hold with 422", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await signReport(
      registry,
      {
        claimClass: "observation",
        subject: { featureId: "oc:feature:de-bnetza:site-1", componentKey: "evse-1" },
        property: "charging.evse_status",
        result: { type: "category", value: "out_of_order", vocabulary: "evse_status" },
        geometry: { type: "Point", coordinates: [8.40478, 49.00062] },
        reportedAt: NOW,
        nonce: "observation-000001",
      },
      key,
    );

    const res = await postReport(report, grant);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ issues: [{ code: "unknown_subject" }] });
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.report_evidence WHERE actor_key_id = ${key.keyId}`;
    expect(n).toBe(0);
  }, 60_000);

  it.each([
    ["reported_in_future", "2026-07-12T08:10:00.000Z"],
    ["reported_too_long_ago", "2026-07-11T07:00:00.000Z"],
    ["expired_on_arrival", "2026-07-12T07:40:00.000Z"],
  ])(
    "refuses a claim %s with 422 and its issue",
    async (code, reportedAt) => {
      const key = await generateReporterKey();
      const grant = await enroll(key);
      const nonce = `refused-${code}`.replaceAll("_", "-");
      const res = await postReport(await sign(key, { nonce, reportedAt }), grant);

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: "claim refused", issues: [{ code }] });
      expect(await readSituation(crowdId(key, nonce))).toBeUndefined();
    },
    60_000,
  );

  it("rate-limits the 11th report from one key inside 60s with 429", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      // Spread the reports across distinct ~1km cells so only the per-key
      // ceiling is exercised here (the per-cell ceiling is covered in
      // abuse.integration.test.ts).
      const report = await sign(key, {
        nonce: `rate-00000000000${i}${i}`,
        geometry: { type: "Point", coordinates: [4.9 + i * 0.02, 52.37] },
      });
      const res = await postReport(report, grant);
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  }, 120_000);
});

describe("POST /contrib/reports — landing auto-corroborates independent reports", () => {
  async function posterior(keyId: string): Promise<{ alpha: number; beta: number }> {
    const rows = await sql<{ reputation_alpha: number; reputation_beta: number }[]>`
      SELECT reputation_alpha, reputation_beta FROM conditions.reporter WHERE key_id = ${keyId}`;
    return { alpha: rows[0]!.reputation_alpha, beta: rows[0]!.reputation_beta };
  }

  it("two distinct keys of the same phenomenon corroborate: earlier survives, later superseded, still not routing, posteriors unchanged", async () => {
    const keyA = await generateReporterKey();
    const keyB = await generateReporterKey();
    const grantA = await enroll(keyA);
    const grantB = await enroll(keyB);

    // Same kind, type and place, distinct keys → independent witnesses.
    // DISTINCT reportedAt a few seconds apart so the EARLIER report (A)
    // deterministically survives — an identical start would fall through to
    // the id tiebreak over RANDOM keyIds.
    const geometry = { type: "Point" as const, coordinates: [5.1, 52.1] as [number, number] };
    const reportA = await sign(keyA, {
      geometry,
      reportedAt: "2026-07-12T07:59:55.000Z",
      nonce: "corrob-A-000000001",
    });
    const reportB = await sign(keyB, { geometry, reportedAt: NOW, nonce: "corrob-B-000000001" });

    const beforeA = await posterior(keyA.keyId);
    const beforeB = await posterior(keyB.keyId);

    expect((await postReport(reportA, grantA)).statusCode).toBe(200);
    expect((await postReport(reportB, grantB)).statusCode).toBe(200);

    const idA = crowdId(keyA, "corrob-A-000000001");
    const idB = crowdId(keyB, "corrob-B-000000001");

    // The earlier report (A) survives and is corroborated; the later (B) merges in.
    expect(await evidenceOf(sql, idA)).toMatchObject({
      evidence_state: "corroborated",
      routing_eligible: false,
      corroborations: 1,
      tombstone_reason: null,
    });
    expect(await evidenceOf(sql, idB)).toMatchObject({ tombstone_reason: "superseded" });

    // A's ledger records B: a confirm from B's key naming the merged report.
    const confirms = await sql<{ details: Record<string, unknown> }[]>`
      SELECT details FROM conditions.report_evidence
      WHERE record_class = 'situation' AND record_id = ${idA}
        AND evidence_kind = 'confirm' AND actor_key_id = ${keyB.keyId}`;
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.details).toMatchObject({ merged: idB });

    // Corroboration NEVER trains reputation: both posteriors are unchanged.
    expect(await posterior(keyA.keyId)).toEqual(beforeA);
    expect(await posterior(keyB.keyId)).toEqual(beforeB);
  }, 60_000);

  it("does NOT corroborate incompatible reports (far apart) — both stay self_reported", async () => {
    const keyC = await generateReporterKey();
    const keyD = await generateReporterKey();
    const grantC = await enroll(keyC);
    const grantD = await enroll(keyD);

    const reportC = await sign(keyC, {
      geometry: { type: "Point", coordinates: [3.0, 51.0] },
      nonce: "corrob-far-C-00001",
    });
    const reportD = await sign(keyD, {
      geometry: { type: "Point", coordinates: [3.5, 51.5] },
      nonce: "corrob-far-D-00001",
    });

    expect((await postReport(reportC, grantC)).statusCode).toBe(200);
    expect((await postReport(reportD, grantD)).statusCode).toBe(200);

    const rowC = await readSituation(crowdId(keyC, "corrob-far-C-00001"));
    const rowD = await readSituation(crowdId(keyD, "corrob-far-D-00001"));
    expect(rowC!.evidence_state).toBe("self_reported");
    expect(rowD!.evidence_state).toBe("self_reported");
    expect(rowC!.confidence_score).toBeCloseTo(0.3, 10);
    expect(rowD!.confidence_score).toBeCloseTo(0.3, 10);
  }, 60_000);

  it("cross-validates a crowd report against a local feed situation of the same phenomenon and routes it", async () => {
    const geometry = { type: "Point" as const, coordinates: [1.0, 48.0] as [number, number] };
    const feedId = await seedFeedSituation(sql, "crowd-vs-feed-1", {
      location: { ...(feedSituationDraft("x")["location"] as object), geometry },
    });

    const key = await generateReporterKey();
    const grant = await enroll(key);
    const before = await sql<{ reputation_alpha: number }[]>`
      SELECT reputation_alpha FROM conditions.reporter WHERE key_id = ${key.keyId}`;
    const report = await sign(key, { geometry, nonce: "crowd-vs-feed-0001" });
    expect((await postReport(report, grant)).statusCode).toBe(200);

    // The FEED situation is authoritative and untouched — the external
    // resolution is appended to the CROWD report, never the feed.
    expect(await evidenceOf(sql, feedId)).toMatchObject({
      evidence_state: null,
      routing_eligible: false,
      flagged_at: null,
    });
    expect(await countEvidence(feedId)).toBe(0);

    // The CROWD report is externally resolved (routing-eligible) and carries
    // exactly one official_match row naming the feed; the reporter was trained.
    const crowd = crowdId(key, "crowd-vs-feed-0001");
    expect(await evidenceOf(sql, crowd)).toMatchObject({
      evidence_state: "externally_resolved",
      routing_eligible: true,
    });
    const official = await sql<{ source_id: string; details: Record<string, unknown> }[]>`
      SELECT source_id, details FROM conditions.report_evidence
      WHERE record_class = 'situation' AND record_id = ${crowd}
        AND evidence_kind = 'official_match'`;
    expect(official).toHaveLength(1);
    expect(official[0]).toMatchObject({
      source_id: "de-autobahn",
      details: { matchedRecord: { class: "situation", id: feedId } },
    });
    const after = await sql<{ reputation_alpha: number }[]>`
      SELECT reputation_alpha FROM conditions.reporter WHERE key_id = ${key.keyId}`;
    expect(after[0]!.reputation_alpha).toBe(before[0]!.reputation_alpha + 1);
  }, 60_000);

  it("a failing official cross-validation hook never fails the landing (best-effort)", async () => {
    const throwingApp = await build({
      sql,
      env: ENV,
      logger: false,
      now: () => NOW,
      crossValidateAgainstFeeds: async () => {
        throw new Error("cross-validate boom");
      },
    });
    try {
      const key = await generateReporterKey();
      const grant = await enroll(key);
      const report = await sign(key, {
        geometry: { type: "Point", coordinates: [2.4, 49.3] },
        nonce: "xval-boom-0000001",
      });
      const res = await postReport(report, grant, throwingApp);
      expect(res.statusCode).toBe(200);
      const row = await readSituation(crowdId(key, "xval-boom-0000001"));
      expect(row!.evidence_state).toBe("self_reported");
    } finally {
      await throwingApp.close();
    }
  }, 60_000);

  it("a failing auto-corroboration hook never fails the landing (best-effort)", async () => {
    const throwingApp = await build({
      sql,
      env: ENV,
      logger: false,
      now: () => NOW,
      autoCorroborate: async () => {
        throw new Error("matcher boom");
      },
    });
    try {
      const key = await generateReporterKey();
      const grant = await enroll(key);
      const report = await sign(key, {
        geometry: { type: "Point", coordinates: [2.0, 49.0] },
        nonce: "corrob-boom-000001",
      });
      const res = await postReport(report, grant, throwingApp);
      expect(res.statusCode).toBe(200);
      const row = await readSituation(crowdId(key, "corrob-boom-000001"));
      expect(row!.evidence_state).toBe("self_reported");
    } finally {
      await throwingApp.close();
    }
  }, 60_000);
});

describe("POST /contrib/reports — police-category gate (DEFAULT OFF)", () => {
  function policeClaim(nonce: string, subtype = "police_checkpoint"): SituationClaim {
    return makeClaim({ kind: "authority", type: "operation", subtype, nonce });
  }

  it("refuses police presence on a production instance: the crowd cannot report authority at all", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    await expect(signReport(registry, policeClaim("police-prod-000001"), key)).rejects.toThrow(
      TypeError,
    );

    const res = await postReport(await withClaim(key, policeClaim("police-prod-000001")), grant);
    expect(res.statusCode).toBe(400);
    expect(await readSituation(crowdId(key, "police-prod-000001"))).toBeUndefined();
  }, 60_000);

  it("rejects police presence with 422 police_category_disabled where the registry allows it", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await signReport(policeRegistry, policeClaim("police-off-0000001"), key);

    const res = await postReport(report, grant, appPoliceRegistry);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { reason: string }).reason).toBe("police_category_disabled");
    expect(await readSituation(crowdId(key, "police-off-0000001"))).toBeUndefined();
  }, 60_000);

  it("lands police presence when the instance enables the category", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await signReport(policeRegistry, policeClaim("police-on-00000001"), key);

    const res = await postReport(report, grant, appPoliceEnabled);
    expect(res.statusCode).toBe(200);
    const row = await readSituation(crowdId(key, "police-on-00000001"));
    expect(row!.evidence_state).toBe("self_reported");
    expect(row!.record).toMatchObject({ kind: "authority", subtype: "police_checkpoint" });
  }, 60_000);

  it("does not gate other authority activity (customs) with the category off", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await signReport(
      policeRegistry,
      policeClaim("customs-000000001", "customs"),
      key,
    );

    const res = await postReport(report, grant, appPoliceRegistry);
    expect(res.statusCode).toBe(200);
    expect(await readSituation(crowdId(key, "customs-000000001"))).toBeDefined();
  }, 60_000);

  it("an obstruction report never trips the gate", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await signReport(
      policeRegistry,
      makeClaim({ nonce: "hazard-nogate-0001" }),
      key,
    );

    const res = await postReport(report, grant, appPoliceRegistry);
    expect(res.statusCode).toBe(200);
  }, 60_000);
});

describe("POST /contrib/reports — media is disabled (no media path)", () => {
  it("serves no media route for a landed report", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    expect(
      (await postReport(await sign(key, { nonce: "media-none-000001" }), grant)).statusCode,
    ).toBe(200);
    const id = crowdId(key, "media-none-000001");
    const noRoute = await app.inject({
      method: "GET",
      url: `/contrib/reports/situation/${encodeURIComponent(id)}/media`,
    });
    expect(noRoute.statusCode).toBe(404);
  }, 60_000);
});

describe("GET /contrib/reporter/me — advisory own-reputation read", () => {
  const ADVISORY_NOTE = "advisory — not a probability of truth or a Sybil-resistance guarantee";

  async function getMe(grant: string, instance: FastifyInstance = app) {
    return instance.inject({
      method: "GET",
      url: "/contrib/reporter/me",
      headers: { authorization: `Bearer ${grant}` },
    });
  }

  it("returns a lower bound that reflects resolved outcomes and is below the posterior mean", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    // Simulate several confirmed resolutions: a confident α-heavy posterior.
    await sql`
      UPDATE conditions.reporter
      SET reputation_alpha = 8, reputation_beta = 2 WHERE key_id = ${key.keyId}`;

    const res = await getMe(grant);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      keyId: string;
      reliabilityLowerBound: number;
      status: string;
      note: string;
    };
    expect(body.keyId).toBe(key.keyId);
    expect(body.status).toBe("active");
    expect(body.note).toBe(ADVISORY_NOTE);
    const mean = 8 / (8 + 2);
    expect(body.reliabilityLowerBound).toBeGreaterThan(0);
    expect(body.reliabilityLowerBound).toBeLessThan(mean);
    // It is the core one-sided lower bound at the fixed 0.9 credible level.
    expect(body.reliabilityLowerBound).toBeCloseTo(
      reliabilityLowerBound({ alpha: 8, beta: 2 }, 0.9),
      10,
    );
  }, 60_000);

  it("gives a fresh reporter a wide-uncertainty low bound from the cohort prior Beta(2,2)", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);

    const res = await getMe(grant);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reliabilityLowerBound: number; note: string };
    expect(body.note).toBe(ADVISORY_NOTE);
    // Beta(2,2) mean is 0.5; the 0.9 lower bound sits well below it.
    expect(body.reliabilityLowerBound).toBeLessThan(0.5);
    expect(body.reliabilityLowerBound).toBeCloseTo(
      reliabilityLowerBound({ alpha: 2, beta: 2 }, 0.9),
      10,
    );
  }, 60_000);

  it("still returns the reputation for a blocked reporter, with status = blocked", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    await sql`UPDATE conditions.reporter SET status = 'blocked' WHERE key_id = ${key.keyId}`;

    const res = await getMe(grant);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; note: string };
    expect(body.status).toBe("blocked");
    expect(body.note).toBe(ADVISORY_NOTE);
  }, 60_000);

  it("404s a valid grant whose key was never enrolled", async () => {
    const key = await generateReporterKey();
    const grant = await createReportingGrant(key.keyId, NOW, GRANT_SECRET);

    const res = await getMe(grant);
    expect(res.statusCode).toBe(404);
  }, 60_000);

  it("401s a missing grant", async () => {
    const res = await app.inject({ method: "GET", url: "/contrib/reporter/me" });
    expect(res.statusCode).toBe(401);
  }, 60_000);

  it("401s a bad grant", async () => {
    const res = await getMe("bogus.grant");
    expect(res.statusCode).toBe(401);
  }, 60_000);
});
