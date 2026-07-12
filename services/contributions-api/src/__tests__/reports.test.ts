import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import type { FastifyInstance } from "fastify";
import {
  generateReporterKey,
  signReport,
  type ReportClaim,
  type ReporterKey,
  type SignedReport,
} from "@openconditions/contrib-core";
import { runMigrations } from "@openconditions/core/server";
import { createReportingGrant } from "../attester/grant.js";
import { build } from "../server.js";

const NOW = "2026-07-12T08:00:00.000Z";
const GRANT_SECRET_VALUE = "reports-route-test-secret";
const GRANT_SECRET = new TextEncoder().encode(GRANT_SECRET_VALUE);

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;
let app: FastifyInstance;
let ipCounter = 0;

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
    now: () => NOW,
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await sql?.end();
  await containerStop?.();
}, 30_000);

/** A fresh per-call source IP so the enrollment per-IP limiter never trips. */
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
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

async function sign(key: ReporterKey, overrides: Partial<ReportClaim> = {}): Promise<SignedReport> {
  return signReport(makeClaim(overrides), key);
}

async function postReport(report: SignedReport, reportingGrant: string) {
  return app.inject({
    method: "POST",
    url: "/contrib/reports",
    payload: { report, reportingGrant },
  });
}

interface LandedRow {
  privacy_class: string;
  canonical_id: string | null;
  phenomenon_fingerprint: string | null;
  evidence_state: string | null;
  routing_eligible: boolean;
  confidence_score: number | null;
  expires_at: Date | null;
  origin: { kind?: string } | null;
}

async function readObs(id: string): Promise<LandedRow | undefined> {
  const rows = await sql<LandedRow[]>`
    SELECT privacy_class, canonical_id, phenomenon_fingerprint, evidence_state,
           routing_eligible, confidence_score, expires_at, origin
    FROM conditions.observations WHERE id = ${id}`;
  return rows[0];
}

describe("POST /contrib/reports — happy path landing", () => {
  it("lands a signed report as a crowd observation with centrally-stamped provenance and evidence", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await sign(key, { nonce: "happy-000000000001" });

    const res = await postReport(report, grant);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      observationId: string;
      evidenceState: string;
      routingEligible: boolean;
    };
    const obsId = `crowd:${key.keyId}:happy-000000000001`;
    expect(body.observationId).toBe(obsId);
    expect(body.evidenceState).toBe("self_reported");
    expect(body.routingEligible).toBe(false);

    const row = await readObs(obsId);
    expect(row).toBeDefined();
    expect(row!.privacy_class).toBe("crowd_pseudonym");
    expect(row!.canonical_id).toEqual(expect.any(String));
    expect(row!.phenomenon_fingerprint).toEqual(expect.any(String));
    expect(row!.evidence_state).toBe("self_reported");
    expect(row!.routing_eligible).toBe(false);
    expect(row!.confidence_score).toBeCloseTo(0.3, 10);
    // congestion crowd TTL is 300s; occurred_at = server NOW → expiry NOW+300s.
    expect(row!.expires_at!.toISOString()).toBe("2026-07-12T08:05:00.000Z");
    expect(row!.origin?.kind).toBe("crowd");

    const evidence = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.report_evidence
      WHERE observation_id = ${obsId} AND evidence_kind = 'report' AND actor_key_id = ${key.keyId}`;
    expect(evidence[0]!.n).toBe(1);
  }, 60_000);

  it("does not fold the reporter signature into the observation origin (kept minimal)", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await sign(key, { nonce: "minimal-00000000001" });
    await postReport(report, grant);

    const rows = await sql<{ origin: Record<string, unknown> }[]>`
      SELECT origin FROM conditions.observations WHERE id = ${`crowd:${key.keyId}:minimal-00000000001`}`;
    const reporter = rows[0]!.origin["reporter"] as Record<string, unknown>;
    expect(reporter["keyId"]).toBe(key.keyId);
    expect(reporter).not.toHaveProperty("signature");
  }, 60_000);
});

describe("POST /contrib/reports — idempotent replay", () => {
  it("replaying the same nonce returns the same observation and adds no evidence row", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await sign(key, { nonce: "replay-000000000001" });

    const first = await postReport(report, grant);
    const second = await postReport(report, grant);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect((first.json() as { observationId: string }).observationId).toBe(
      (second.json() as { observationId: string }).observationId
    );

    const obsId = `crowd:${key.keyId}:replay-000000000001`;
    const evidence = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.report_evidence WHERE observation_id = ${obsId}`;
    expect(evidence[0]!.n).toBe(1);
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

  it("rejects an out-of-range geometry with 422 and named reasons", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await sign(key, {
      nonce: "oob-geo-000000001",
      geometry: { type: "Point", coordinates: [999, 52] },
    });

    const res = await postReport(report, grant);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { reasons: string[] }).reasons).toContain("geometry_out_of_range");
  }, 60_000);

  it("rejects a type/arity-mismatched geometry with 422 and never reaches the DB (no 500)", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    // A Point whose coordinates are a nested position array: passes the
    // authenticity layer + finite/range scan but would crash ST_GeomFromGeoJSON.
    const report = await sign(key, {
      nonce: "arity-mismatch-0001",
      geometry: { type: "Point", coordinates: [[4.9, 52.37]] } as never,
    });

    const res = await postReport(report, grant);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { reasons: string[] }).reasons).toContain("geometry_malformed");

    const row = await readObs(`crowd:${key.keyId}:arity-mismatch-0001`);
    expect(row).toBeUndefined();
  }, 60_000);

  it("rejects a 3D position with 422 at plausibility (v1 is 2D), no DB round-trip", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await sign(key, {
      nonce: "three-dee-00000001",
      geometry: { type: "Point", coordinates: [4.9, 52.37, 12] } as never,
    });

    const res = await postReport(report, grant);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { reasons: string[] }).reasons).toContain("geometry_malformed");

    const row = await readObs(`crowd:${key.keyId}:three-dee-00000001`);
    expect(row).toBeUndefined();
  }, 60_000);

  it("rate-limits the 11th report from one key inside 60s with 429", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const report = await sign(key, { nonce: `rate-00000000000${i}${i}` });
      const res = await postReport(report, grant);
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  }, 120_000);
});

describe("POST /contrib/reports — landing never auto-corroborates", () => {
  it("two distinct keys reporting the same phenomenon land as two self_reported rows", async () => {
    const keyA = await generateReporterKey();
    const keyB = await generateReporterKey();
    const grantA = await enroll(keyA);
    const grantB = await enroll(keyB);

    // Identical claim content (same type/geometry/validFrom) → matching
    // phenomenon fingerprint, but distinct keys → distinct observation ids.
    const shared: Partial<ReportClaim> = {
      geometry: { type: "Point", coordinates: [5.1, 52.1] },
      reportedAt: NOW,
    };
    const reportA = await sign(keyA, { ...shared, nonce: "corrob-A-000000001" });
    const reportB = await sign(keyB, { ...shared, nonce: "corrob-B-000000001" });

    expect((await postReport(reportA, grantA)).statusCode).toBe(200);
    expect((await postReport(reportB, grantB)).statusCode).toBe(200);

    const rowA = await readObs(`crowd:${keyA.keyId}:corrob-A-000000001`);
    const rowB = await readObs(`crowd:${keyB.keyId}:corrob-B-000000001`);
    expect(rowA!.evidence_state).toBe("self_reported");
    expect(rowB!.evidence_state).toBe("self_reported");
    // Fingerprints match (same phenomenon) …
    expect(rowA!.phenomenon_fingerprint).toBe(rowB!.phenomenon_fingerprint);
    // … but landing left them independent, not corroborated.
    expect(rowA!.confidence_score).toBeCloseTo(0.3, 10);
    expect(rowB!.confidence_score).toBeCloseTo(0.3, 10);
  }, 60_000);
});
