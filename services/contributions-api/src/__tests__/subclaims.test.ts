import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import type { FastifyInstance } from "fastify";
import {
  generateReporterKey,
  signReport,
  signSubClaim,
  type ReportClaim,
  type ReporterKey,
  type SignedReport,
  type SignedSubClaim,
  type SubClaimBody,
  type SubClaimType,
} from "@openconditions/contrib-core";
import { runMigrations } from "@openconditions/core/server";
import { createReportingGrant } from "../attester/grant.js";
import { build } from "../server.js";

const NOW = "2026-07-12T08:00:00.000Z";
const GRANT_SECRET_VALUE = "subclaims-route-test-secret";
const GRANT_SECRET = new TextEncoder().encode(GRANT_SECRET_VALUE);

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;
let app: FastifyInstance;
let ipCounter = 0;
let nowValue = NOW;

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
  sql = postgres(url, { max: 10 });
  await runMigrations(url);
  app = await build({
    sql,
    env: {
      OPENCONDITIONS_GRANT_SECRET: GRANT_SECRET_VALUE,
      OPENCONDITIONS_INSTANCE_ID: "maps.example.org",
    },
    logger: false,
    now: () => nowValue,
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await sql?.end();
  await containerStop?.();
}, 30_000);

beforeEach(() => {
  nowValue = NOW;
});

/** A fresh per-call source IP so the enrollment per-IP limiter never trips. */
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 250}`;
}

function makeClaim(overrides: Partial<ReportClaim> = {}): ReportClaim {
  return {
    domain: "roads",
    type: "congestion",
    geometry: { type: "Point", coordinates: [4.9, 52.37] },
    fuzziness: "low_res",
    reportedAt: NOW,
    nonce: "nonce-000000000001",
    ...overrides,
  };
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

/** Enroll a key and land a fresh active crowd observation from it; returns id + grant. */
async function landObs(
  nonce: string,
  overrides: Partial<ReportClaim> = {}
): Promise<{ key: ReporterKey; grant: string; id: string }> {
  const key = await generateReporterKey();
  const grant = await enroll(key);
  const report: SignedReport = await signReport(makeClaim({ nonce, ...overrides }), key);
  const res = await app.inject({
    method: "POST",
    url: "/contrib/reports",
    payload: { report, reportingGrant: grant },
  });
  expect(res.statusCode).toBe(200);
  return { key, grant, id: (res.json() as { observationId: string }).observationId };
}

async function signSub(
  key: ReporterKey,
  subject: string,
  claimType: SubClaimType,
  overrides: Partial<SubClaimBody> = {}
): Promise<SignedSubClaim> {
  const body: SubClaimBody = {
    subject,
    claimType,
    reportedAt: nowValue,
    nonce: `sub-${claimType}-${Math.random().toString(36).slice(2, 14)}`,
    ...overrides,
  };
  return signSubClaim(body, key);
}

function vote(id: string, action: string, subClaim: SignedSubClaim, reportingGrant: string) {
  return app.inject({
    method: "POST",
    url: `/contrib/reports/${id}/${action}`,
    payload: { subClaim, reportingGrant },
  });
}

interface ObsRow {
  status: string;
  evidence_state: string | null;
  routing_eligible: boolean;
  confidence_score: number | null;
  expires_at: Date | null;
  flagged_at: Date | null;
}

async function readObs(id: string): Promise<ObsRow | undefined> {
  const rows = await sql<ObsRow[]>`
    SELECT status, evidence_state, routing_eligible, confidence_score, expires_at, flagged_at
    FROM conditions.observations WHERE id = ${id}`;
  return rows[0];
}

async function countEvidence(id: string, kind: string, keyId?: string): Promise<number> {
  const rows = keyId
    ? await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM conditions.report_evidence
        WHERE observation_id = ${id} AND evidence_kind = ${kind} AND actor_key_id = ${keyId}`
    : await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM conditions.report_evidence
        WHERE observation_id = ${id} AND evidence_kind = ${kind}`;
  return rows[0]!.n;
}

async function countSubClaims(id: string, keyId: string, claimType: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM conditions.sub_claim
    WHERE subject_id = ${id} AND key_id = ${keyId} AND claim_type = ${claimType}`;
  return rows[0]!.n;
}

async function readPosterior(keyId: string): Promise<{ alpha: number; beta: number }> {
  const rows = await sql<{ reputation_alpha: number; reputation_beta: number }[]>`
    SELECT reputation_alpha, reputation_beta FROM conditions.reporter WHERE key_id = ${keyId}`;
  return { alpha: rows[0]!.reputation_alpha, beta: rows[0]!.reputation_beta };
}

describe("migration 0010 — flagged_at column", () => {
  it("adds a nullable flagged_at timestamptz to conditions.observations", async () => {
    const cols = await sql<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'conditions' AND table_name = 'observations'
        AND column_name = 'flagged_at'`;
    expect(cols[0]?.data_type).toBe("timestamp with time zone");
    expect(cols[0]?.is_nullable).toBe("YES");
  }, 30_000);
});

describe("POST /contrib/reports/:id/confirm — corroboration never routes", () => {
  it("two distinct keys corroborate: state corroborated, routing STILL false, score ~0.6, expiry extended", async () => {
    const { id } = await landObs("confirm-land-0000001");
    const landed = await readObs(id);
    expect(landed!.evidence_state).toBe("self_reported");
    const landedExpiry = landed!.expires_at!.getTime();

    // A distinct enrolled key confirms 60s later.
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    nowValue = "2026-07-12T08:01:00.000Z";
    const sub = await signSub(keyB, id, "confirm");
    const res = await vote(id, "confirm", sub, grantB);

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      observationId: string;
      evidenceState: string;
      routingEligible: boolean;
      action: string;
    };
    expect(body.observationId).toBe(id);
    expect(body.evidenceState).toBe("corroborated");
    expect(body.routingEligible).toBe(false);
    expect(body.action).toBe("confirm");

    const row = await readObs(id);
    expect(row!.evidence_state).toBe("corroborated");
    expect(row!.routing_eligible).toBe(false);
    expect(row!.confidence_score).toBeCloseTo(0.6, 10);
    // Corroboration extends expiry from the confirm's observation time.
    expect(row!.expires_at!.getTime()).toBeGreaterThan(landedExpiry);
    expect(row!.expires_at!.toISOString()).toBe("2026-07-12T08:06:00.000Z");

    expect(await countEvidence(id, "confirm", keyB.keyId)).toBe(1);
  }, 60_000);

  it("a third distinct confirm keeps the observation corroborated and still not routing", async () => {
    const { id } = await landObs("confirm-third-000001");
    const keyB = await generateReporterKey();
    const keyC = await generateReporterKey();
    const grantB = await enroll(keyB);
    const grantC = await enroll(keyC);
    expect((await vote(id, "confirm", await signSub(keyB, id, "confirm"), grantB)).statusCode).toBe(
      200
    );
    const third = await vote(id, "confirm", await signSub(keyC, id, "confirm"), grantC);
    expect(third.statusCode).toBe(200);
    const body = third.json() as { evidenceState: string; routingEligible: boolean };
    expect(body.evidenceState).toBe("corroborated");
    expect(body.routingEligible).toBe(false);
  }, 60_000);
});

describe("POST /contrib/reports/:id/confirm — crowd agreement never trains reputation", () => {
  it("five colluding distinct-key confirms through the real vote route leave every posterior at Beta(2,2)", async () => {
    const { key: originator, id } = await landObs("collude-land-0000001");
    const colluders: ReporterKey[] = [];
    for (let i = 0; i < 5; i++) {
      const keyN = await generateReporterKey();
      const grantN = await enroll(keyN);
      colluders.push(keyN);
      const res = await vote(id, "confirm", await signSub(keyN, id, "confirm"), grantN);
      expect(res.statusCode).toBe(200);
    }

    const row = await readObs(id);
    expect(row!.evidence_state).toBe("corroborated");
    expect(row!.routing_eligible).toBe(false);

    // The whole point: peer confirmation moved the evidence STATE but must not
    // have touched a single posterior. If the vote path ever trained
    // reputation, one of these would drift off the cohort prior.
    expect(await readPosterior(originator.keyId)).toEqual({ alpha: 2, beta: 2 });
    for (const colluder of colluders) {
      expect(await readPosterior(colluder.keyId)).toEqual({ alpha: 2, beta: 2 });
    }
  }, 120_000);
});

describe("POST /contrib/reports/:id/confirm — idempotency", () => {
  it("the same key confirming twice appends exactly one evidence row and one sub_claim", async () => {
    const { id } = await landObs("confirm-idem-000001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const sub = await signSub(keyB, id, "confirm");

    const first = await vote(id, "confirm", sub, grantB);
    const second = await vote(id, "confirm", sub, grantB);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect((first.json() as { evidenceState: string }).evidenceState).toBe("corroborated");
    expect((second.json() as { evidenceState: string }).evidenceState).toBe("corroborated");

    expect(await countEvidence(id, "confirm", keyB.keyId)).toBe(1);
    expect(await countSubClaims(id, keyB.keyId, "confirm")).toBe(1);
  }, 60_000);

  it("the same key confirming again with a different nonce is idempotent (unique on subject,key,type)", async () => {
    const { id } = await landObs("confirm-idem2-00001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);

    expect((await vote(id, "confirm", await signSub(keyB, id, "confirm"), grantB)).statusCode).toBe(
      200
    );
    const again = await vote(id, "confirm", await signSub(keyB, id, "confirm"), grantB);
    expect(again.statusCode).toBe(200);

    expect(await countEvidence(id, "confirm", keyB.keyId)).toBe(1);
    expect(await countSubClaims(id, keyB.keyId, "confirm")).toBe(1);
  }, 60_000);
});

describe("POST /contrib/reports/:id/confirm — self-vote never corroborates", () => {
  it("the originating key confirming its OWN observation stays self_reported", async () => {
    const { key, grant, id } = await landObs("confirm-self-000001");
    const sub = await signSub(key, id, "confirm");
    const res = await vote(id, "confirm", sub, grant);

    expect(res.statusCode).toBe(200);
    expect((res.json() as { evidenceState: string }).evidenceState).toBe("self_reported");
    const row = await readObs(id);
    expect(row!.evidence_state).toBe("self_reported");
    expect(row!.confidence_score).toBeCloseTo(0.3, 10);
    expect(row!.routing_eligible).toBe(false);
  }, 60_000);
});

describe("POST /contrib/reports/:id/negate — retraction vs peer negation", () => {
  it("a single distinct-key negate on a self_reported observation is not enough (stays self_reported)", async () => {
    const { id } = await landObs("negate-peer-000001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const res = await vote(id, "negate", await signSub(keyB, id, "negate"), grantB);

    expect(res.statusCode).toBe(200);
    expect((res.json() as { evidenceState: string }).evidenceState).toBe("self_reported");
    expect((await readObs(id))!.evidence_state).toBe("self_reported");
  }, 60_000);

  it("the originating key negating its own observation retracts it (negated)", async () => {
    const { key, grant, id } = await landObs("negate-self-000001");
    const res = await vote(id, "negate", await signSub(key, id, "negate"), grant);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { evidenceState: string; routingEligible: boolean };
    expect(body.evidenceState).toBe("negated");
    expect(body.routingEligible).toBe(false);
    const row = await readObs(id);
    expect(row!.evidence_state).toBe("negated");
    expect(row!.confidence_score).toBeCloseTo(0.1, 10);
  }, 60_000);
});

describe("POST /contrib/reports/:id/flag — a flag is a marker, not evidence", () => {
  it("sets flagged_at, leaves evidence_state unchanged, and appends no evidence row", async () => {
    const { id } = await landObs("flag-000000000001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const res = await vote(id, "flag", await signSub(keyB, id, "flag", { reason: "spam" }), grantB);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ flagged: true });

    const row = await readObs(id);
    expect(row!.flagged_at).not.toBeNull();
    expect(row!.evidence_state).toBe("self_reported");
    expect(await countEvidence(id, "confirm")).toBe(0);
    expect(await countEvidence(id, "negate")).toBe(0);
    expect(await countSubClaims(id, keyB.keyId, "flag")).toBe(1);
  }, 60_000);

  it("a repeat flag is idempotent and keeps the first flagged_at", async () => {
    const { id } = await landObs("flag-idem-00000001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const sub = await signSub(keyB, id, "flag");
    expect((await vote(id, "flag", sub, grantB)).statusCode).toBe(200);
    const firstFlaggedAt = (await readObs(id))!.flagged_at!.toISOString();

    nowValue = "2026-07-12T09:00:00.000Z";
    expect((await vote(id, "flag", sub, grantB)).statusCode).toBe(200);
    expect((await readObs(id))!.flagged_at!.toISOString()).toBe(firstFlaggedAt);
    expect(await countSubClaims(id, keyB.keyId, "flag")).toBe(1);
  }, 60_000);
});

describe("POST /contrib/reports/:id/:action — sub-claim geometry screen", () => {
  it("stores a valid Point geometry and reaches 200", async () => {
    const { id } = await landObs("geo-valid-000000001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const nonce = "geo-valid-sub-00001";
    const sub = await signSub(keyB, id, "confirm", {
      nonce,
      geometry: { type: "Point", coordinates: [4.91, 52.36] },
    });
    const res = await vote(id, "confirm", sub, grantB);
    expect(res.statusCode).toBe(200);

    const rows = await sql<{ x: number; y: number }[]>`
      SELECT ST_X(geom) AS x, ST_Y(geom) AS y
      FROM conditions.sub_claim WHERE id = ${`sub:${keyB.keyId}:${nonce}`}`;
    expect(rows[0]!.x).toBeCloseTo(4.91, 9);
    expect(rows[0]!.y).toBeCloseTo(52.36, 9);
  }, 60_000);

  it("rejects a malformed Point (nested position) with 422 and writes nothing (no 500)", async () => {
    const { id } = await landObs("geo-malformed-00001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const sub = await signSub(keyB, id, "confirm", {
      geometry: { type: "Point", coordinates: [[4.9, 52.37]] } as never,
    });
    const res = await vote(id, "confirm", sub, grantB);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { reasons: string[] }).reasons).toContain("geometry_malformed");
    expect(await countSubClaims(id, keyB.keyId, "confirm")).toBe(0);
    expect(await countEvidence(id, "confirm", keyB.keyId)).toBe(0);
  }, 60_000);

  it("rejects a 3D Point with 422 (v1 is 2D)", async () => {
    const { id } = await landObs("geo-3d-0000000001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const sub = await signSub(keyB, id, "confirm", {
      geometry: { type: "Point", coordinates: [4.9, 52.37, 12] } as never,
    });
    const res = await vote(id, "confirm", sub, grantB);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { reasons: string[] }).reasons).toContain("geometry_malformed");
    expect(await countSubClaims(id, keyB.keyId, "confirm")).toBe(0);
  }, 60_000);

  it("rejects an out-of-range Point with 422 (never silently stored)", async () => {
    const { id } = await landObs("geo-oob-000000001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const sub = await signSub(keyB, id, "confirm", {
      geometry: { type: "Point", coordinates: [999, 999] },
    });
    const res = await vote(id, "confirm", sub, grantB);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { reasons: string[] }).reasons).toContain("geometry_out_of_range");
    expect(await countSubClaims(id, keyB.keyId, "confirm")).toBe(0);
  }, 60_000);

  it("rejects a non-Point (LineString) geometry with 422 rather than dropping it", async () => {
    const { id } = await landObs("geo-line-00000001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const sub = await signSub(keyB, id, "confirm", {
      geometry: {
        type: "LineString",
        coordinates: [
          [4.9, 52.37],
          [4.91, 52.38],
        ],
      } as never,
    });
    const res = await vote(id, "confirm", sub, grantB);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { reasons: string[] }).reasons).toContain("geometry_not_point");
    expect(await countSubClaims(id, keyB.keyId, "confirm")).toBe(0);
  }, 60_000);

  it("accepts an absent geometry (200, geom null) as before", async () => {
    const { id } = await landObs("geo-absent-0000001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const nonce = "geo-absent-sub-0001";
    const res = await vote(id, "confirm", await signSub(keyB, id, "confirm", { nonce }), grantB);
    expect(res.statusCode).toBe(200);
    const rows = await sql<{ geom: string | null }[]>`
      SELECT geom FROM conditions.sub_claim WHERE id = ${`sub:${keyB.keyId}:${nonce}`}`;
    expect(rows[0]!.geom).toBeNull();
  }, 60_000);
});

describe("POST /contrib/reports/:id/:action — rejections at the trust boundary", () => {
  it("rejects an unknown action with 404", async () => {
    const { id } = await landObs("reject-action-00001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const sub = await signSub(keyB, id, "confirm");
    const res = await vote(id, "endorse", sub, grantB);
    expect(res.statusCode).toBe(404);
  }, 60_000);

  it("rejects a bad grant with 401", async () => {
    const { id } = await landObs("reject-grant-000001");
    const keyB = await generateReporterKey();
    await enroll(keyB);
    const sub = await signSub(keyB, id, "confirm");
    const res = await vote(id, "confirm", sub, "bogus.grant");
    expect(res.statusCode).toBe(401);
  }, 60_000);

  it("rejects a grant minted for a different key with 401 (grant binds the key)", async () => {
    const { id } = await landObs("reject-wrongkey-001");
    const keyB = await generateReporterKey();
    await enroll(keyB);
    const grantForOther = await createReportingGrant("some-other-key", nowValue, GRANT_SECRET);
    const sub = await signSub(keyB, id, "confirm");
    const res = await vote(id, "confirm", sub, grantForOther);
    expect(res.statusCode).toBe(401);
  }, 60_000);

  it("rejects a tampered signature with 400", async () => {
    const { id } = await landObs("reject-sig-0000001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const sub = await signSub(keyB, id, "confirm");
    const tampered: SignedSubClaim = {
      ...sub,
      signature: sub.signature.slice(0, -4) + (sub.signature.endsWith("A") ? "BBBB" : "AAAA"),
    };
    const res = await vote(id, "confirm", tampered, grantB);
    expect(res.statusCode).toBe(400);
  }, 60_000);

  it("rejects a claimType that disagrees with the route action with 400", async () => {
    const { id } = await landObs("reject-mismatch-001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    // Signed as a confirm but replayed on the negate route.
    const sub = await signSub(keyB, id, "confirm");
    const res = await vote(id, "negate", sub, grantB);
    expect(res.statusCode).toBe(400);
    expect(await countSubClaims(id, keyB.keyId, "confirm")).toBe(0);
  }, 60_000);

  it("rejects a subject that is not the target observation id with 400 (v1 accepts the id only)", async () => {
    const { id } = await landObs("reject-subject-0001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const sub = await signSub(keyB, "urn:openconditions:report:AAAABBBBCCCC", "confirm");
    const res = await vote(id, "confirm", sub, grantB);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/observation id/i);
  }, 60_000);

  it("rejects an unknown (unenrolled) voting key with 403 and writes nothing", async () => {
    const { id } = await landObs("reject-unenrolled-01");
    const strangerKey = await generateReporterKey();
    // A directly-minted grant is valid, but no enrollment ran → no reporter row.
    const grant = await createReportingGrant(strangerKey.keyId, nowValue, GRANT_SECRET);
    const sub = await signSub(strangerKey, id, "confirm");
    const res = await vote(id, "confirm", sub, grant);
    expect(res.statusCode).toBe(403);
    expect(await countSubClaims(id, strangerKey.keyId, "confirm")).toBe(0);
    expect(await countEvidence(id, "confirm", strangerKey.keyId)).toBe(0);
  }, 60_000);

  it("rejects a blocked reporter with 403", async () => {
    const { id } = await landObs("reject-blocked-0001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    await sql`UPDATE conditions.reporter SET status = 'blocked' WHERE key_id = ${keyB.keyId}`;
    const res = await vote(id, "confirm", await signSub(keyB, id, "confirm"), grantB);
    expect(res.statusCode).toBe(403);
    await sql`UPDATE conditions.reporter SET status = 'active' WHERE key_id = ${keyB.keyId}`;
  }, 60_000);

  it("rejects a vote on a non-existent observation with 404", async () => {
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const missingId = `crowd:${keyB.keyId}:does-not-exist0001`;
    const sub = await signSub(keyB, missingId, "confirm");
    const res = await vote(missingId, "confirm", sub, grantB);
    expect(res.statusCode).toBe(404);
  }, 60_000);

  it("rejects a vote on an inactive observation with 409", async () => {
    const { id } = await landObs("reject-inactive-0001");
    await sql`UPDATE conditions.observations SET status = 'cancelled' WHERE id = ${id}`;
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const res = await vote(id, "confirm", await signSub(keyB, id, "confirm"), grantB);
    expect(res.statusCode).toBe(409);
    expect(await countSubClaims(id, keyB.keyId, "confirm")).toBe(0);
  }, 60_000);
});

describe("POST /contrib/reports/:id/:action — a settled observation is closed to voting", () => {
  it("rejects a confirm on an externally_resolved observation with 409 and writes nothing", async () => {
    const { id } = await landObs("resolved-confirm-001");
    await sql`
      UPDATE conditions.observations
      SET evidence_state = 'externally_resolved', routing_eligible = true WHERE id = ${id}`;
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const res = await vote(id, "confirm", await signSub(keyB, id, "confirm"), grantB);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/already resolved/i);
    expect(await countSubClaims(id, keyB.keyId, "confirm")).toBe(0);
    expect(await countEvidence(id, "confirm", keyB.keyId)).toBe(0);
  }, 60_000);

  it("rejects a negate on a negated observation with 409", async () => {
    const { id } = await landObs("resolved-negate-0001");
    await sql`UPDATE conditions.observations SET evidence_state = 'negated' WHERE id = ${id}`;
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const res = await vote(id, "negate", await signSub(keyB, id, "negate"), grantB);
    expect(res.statusCode).toBe(409);
    expect(await countSubClaims(id, keyB.keyId, "negate")).toBe(0);
  }, 60_000);

  it("still allows flagging a resolved observation for review", async () => {
    const { id } = await landObs("resolved-flag-00001");
    await sql`
      UPDATE conditions.observations
      SET evidence_state = 'externally_resolved', routing_eligible = true WHERE id = ${id}`;
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const res = await vote(
      id,
      "flag",
      await signSub(keyB, id, "flag", { reason: "stale" }),
      grantB
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ flagged: true });
    expect((await readObs(id))!.flagged_at).not.toBeNull();
    expect((await readObs(id))!.evidence_state).toBe("externally_resolved");
  }, 60_000);
});
