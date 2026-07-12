import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import type { FastifyInstance } from "fastify";
import {
  crowdObservationId,
  generateReporterKey,
  signReport,
  type ReportClaim,
  type ReporterKey,
  type SignedReport,
} from "@openconditions/contrib-core";
import {
  phenomenonFingerprint,
  reliabilityLowerBound,
  type ConditionEvent,
} from "@openconditions/core";
import { runMigrations } from "@openconditions/core/server";
import { createReportingGrant } from "../attester/grant.js";
import { build } from "../server.js";

const NOW = "2026-07-12T08:00:00.000Z";
const GRANT_SECRET_VALUE = "reports-route-test-secret";
const GRANT_SECRET = new TextEncoder().encode(GRANT_SECRET_VALUE);

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;
let app: FastifyInstance;
/** A second instance with the police category explicitly enabled. */
let appPolice: FastifyInstance;
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
  appPolice = await build({
    sql,
    env: {
      OPENCONDITIONS_GRANT_SECRET: GRANT_SECRET_VALUE,
      OPENCONDITIONS_INSTANCE_ID: "maps.example.org",
      OPENCONDITIONS_ALLOW_POLICE_CATEGORY: "true",
    },
    logger: false,
    now: () => NOW,
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await appPolice?.close();
  await sql?.end();
  await containerStop?.();
}, 30_000);

/** A fresh per-call source IP so the enrollment per-IP limiter never trips. */
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
}

// Landing now auto-corroborates two INDEPENDENT reports of the same phenomenon,
// so tests that don't override geometry each land at their OWN coordinate — the
// default is unique per claim. Without this, unrelated default landings (happy
// path, replay, media, …) would cross-corroborate at one shared neighborhood and,
// with equal reportedAt, pick a survivor by the random-keyId tiebreak → flaky.
// Tests that DO care about a shared phenomenon override geometry explicitly.
let claimGeomCounter = 0;
function nextClaimGeometry(): ReportClaim["geometry"] {
  const lon = 9.0 + claimGeomCounter * 0.3;
  claimGeomCounter += 1;
  return { type: "Point", coordinates: [lon, 44.0] };
}

function makeClaim(overrides: Partial<ReportClaim> = {}): ReportClaim {
  const { geometry: overrideGeom, ...rest } = overrides;
  return {
    domain: "roads",
    type: "congestion",
    geometry: overrideGeom ?? nextClaimGeometry(),
    fuzziness: "low_res",
    reportedAt: NOW,
    nonce: "nonce-000000000001",
    ...rest,
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

async function postReport(
  report: SignedReport,
  reportingGrant: string,
  instance: FastifyInstance = app
) {
  return instance.inject({
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
    const obsId = await crowdObservationId(key.keyId, "happy-000000000001");
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
      SELECT origin FROM conditions.observations WHERE id = ${await crowdObservationId(key.keyId, "minimal-00000000001")}`;
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

    const obsId = await crowdObservationId(key.keyId, "replay-000000000001");
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

    const row = await readObs(await crowdObservationId(key.keyId, "arity-mismatch-0001"));
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

    const row = await readObs(await crowdObservationId(key.keyId, "three-dee-00000001"));
    expect(row).toBeUndefined();
  }, 60_000);

  it("rate-limits the 11th report from one key inside 60s with 429", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      // Spread the reports across distinct ~1km cells so only the per-key
      // ceiling is exercised here (the per-cell ceiling is covered in
      // abuse.test.ts).
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

  it("two distinct keys of the same phenomenon corroborate: earlier survives, later inactive, still not routing, posteriors unchanged", async () => {
    const keyA = await generateReporterKey();
    const keyB = await generateReporterKey();
    const grantA = await enroll(keyA);
    const grantB = await enroll(keyB);

    // Same type/place → matching phenomenon fingerprint, distinct keys →
    // independent witnesses. DISTINCT reportedAt a few seconds apart (well within
    // the 900s match window, the realistic case: two reporters don't file at the
    // same millisecond) so valid_from differs and the EARLIER report (A)
    // deterministically survives — an identical valid_from would fall through to
    // the id tiebreak over RANDOM keyIds and pick nondeterministically.
    const geometry = { type: "Point" as const, coordinates: [5.1, 52.1] };
    const EARLIER = "2026-07-12T07:59:55.000Z";
    const reportA = await sign(keyA, {
      geometry,
      reportedAt: EARLIER,
      nonce: "corrob-A-000000001",
    });
    const reportB = await sign(keyB, { geometry, reportedAt: NOW, nonce: "corrob-B-000000001" });

    const beforeA = await posterior(keyA.keyId);
    const beforeB = await posterior(keyB.keyId);

    expect((await postReport(reportA, grantA)).statusCode).toBe(200);
    expect((await postReport(reportB, grantB)).statusCode).toBe(200);

    const idA = await crowdObservationId(keyA.keyId, "corrob-A-000000001");
    const idB = await crowdObservationId(keyB.keyId, "corrob-B-000000001");
    const rowA = await readObs(idA);

    // The earlier report (A) survives and is corroborated; the later (B) merges in.
    expect(rowA!.evidence_state).toBe("corroborated");
    expect(rowA!.routing_eligible).toBe(false);
    const statusA = await sql<{ status: string }[]>`
      SELECT status FROM conditions.observations WHERE id = ${idA}`;
    const statusB = await sql<{ status: string }[]>`
      SELECT status FROM conditions.observations WHERE id = ${idB}`;
    expect(statusA[0]!.status).toBe("active");
    expect(statusB[0]!.status).toBe("inactive");

    // A's lineage records B; a confirm evidence row from B's key lands on A.
    const lineage = await sql<{ corroborations: string[] | null }[]>`
      SELECT corroborations FROM conditions.observations WHERE id = ${idA}`;
    expect(lineage[0]!.corroborations).toContain(idB);
    const confirms = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.report_evidence
      WHERE observation_id = ${idA} AND evidence_kind = 'confirm' AND actor_key_id = ${keyB.keyId}`;
    expect(confirms[0]!.n).toBe(1);

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
      reportedAt: NOW,
      nonce: "corrob-far-C-00001",
    });
    const reportD = await sign(keyD, {
      geometry: { type: "Point", coordinates: [3.5, 51.5] },
      reportedAt: NOW,
      nonce: "corrob-far-D-00001",
    });

    expect((await postReport(reportC, grantC)).statusCode).toBe(200);
    expect((await postReport(reportD, grantD)).statusCode).toBe(200);

    const rowC = await readObs(await crowdObservationId(keyC.keyId, "corrob-far-C-00001"));
    const rowD = await readObs(await crowdObservationId(keyD.keyId, "corrob-far-D-00001"));
    expect(rowC!.evidence_state).toBe("self_reported");
    expect(rowD!.evidence_state).toBe("self_reported");
    expect(rowC!.confidence_score).toBeCloseTo(0.3, 10);
    expect(rowD!.confidence_score).toBeCloseTo(0.3, 10);
  }, 60_000);

  it("does NOT auto-corroborate a crowd report onto an OFFICIAL FEED observation (cross-source pass is deferred)", async () => {
    // A feed road_closure at the same phenomenon as the incoming crowd report.
    const geometry = { type: "Point" as const, coordinates: [1.0, 48.0] };
    const feedEvt = {
      kind: "event",
      domain: "roads",
      type: "hazard",
      geometry,
      validFrom: NOW,
    } as ConditionEvent;
    const fp = phenomenonFingerprint(feedEvt);
    await sql`
      INSERT INTO conditions.observations
        (id, source, source_format, domain, kind, type, status, geom, origin,
         valid_from, phenomenon_fingerprint, data_updated_at, fetched_at, is_stale)
      VALUES
        ('feed:closure:1', 'ndw', 'datex2', 'roads', 'event', 'hazard', 'active',
         ST_SetSRID(ST_MakePoint(1.0, 48.0), 4326),
         ${sql.json({ kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" } } as never)},
         ${NOW}, ${fp}, ${NOW}, now(), false)`;

    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await sign(key, { type: "hazard", geometry, nonce: "crowd-vs-feed-0001" });
    expect((await postReport(report, grant)).statusCode).toBe(200);

    // The feed observation is untouched (no confirm evidence, still active,
    // evidence_state NULL) and the crowd report stays self_reported + active.
    const feed = await sql<{ status: string; evidence_state: string | null }[]>`
      SELECT status, evidence_state FROM conditions.observations WHERE id = 'feed:closure:1'`;
    expect(feed[0]!.status).toBe("active");
    expect(feed[0]!.evidence_state).toBeNull();
    const confirms = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.report_evidence
      WHERE observation_id = 'feed:closure:1'`;
    expect(confirms[0]!.n).toBe(0);
    const crowd = await readObs(await crowdObservationId(key.keyId, "crowd-vs-feed-0001"));
    expect(crowd!.evidence_state).toBe("self_reported");
  }, 60_000);

  it("a failing auto-corroboration hook never fails the landing (best-effort)", async () => {
    const throwingApp = await build({
      sql,
      env: {
        OPENCONDITIONS_GRANT_SECRET: GRANT_SECRET_VALUE,
        OPENCONDITIONS_INSTANCE_ID: "maps.example.org",
      },
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
      const row = await readObs(await crowdObservationId(key.keyId, "corrob-boom-000001"));
      expect(row!.evidence_state).toBe("self_reported");
    } finally {
      await throwingApp.close();
    }
  }, 60_000);
});

describe("POST /contrib/reports — police-category gate (DEFAULT OFF)", () => {
  it("rejects a police-typed report with 422 police_category_disabled and writes no row", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await sign(key, { type: "police", nonce: "police-off-0000001" });

    const res = await postReport(report, grant);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { reason: string }).reason).toBe("police_category_disabled");

    const row = await readObs(await crowdObservationId(key.keyId, "police-off-0000001"));
    expect(row).toBeUndefined();
  }, 60_000);

  it("lands a police-typed report normally when the instance enables the category", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await sign(key, { type: "police", nonce: "police-on-00000001" });

    const res = await postReport(report, grant, appPolice);
    expect(res.statusCode).toBe(200);

    const row = await readObs(await crowdObservationId(key.keyId, "police-on-00000001"));
    expect(row).toBeDefined();
    expect(row!.evidence_state).toBe("self_reported");
  }, 60_000);

  it("does not gate 'authority' — legitimate official activity lands even with the toggle off", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await sign(key, { type: "authority", nonce: "authority-0000001" });

    const res = await postReport(report, grant);
    expect(res.statusCode).toBe(200);

    const row = await readObs(await crowdObservationId(key.keyId, "authority-0000001"));
    expect(row).toBeDefined();
  }, 60_000);

  it("does not gate 'security' — a security-incident report lands with the toggle off", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await sign(key, { type: "security", nonce: "security-00000001" });

    const res = await postReport(report, grant);
    expect(res.statusCode).toBe(200);
  }, 60_000);

  it("a hazard report never trips the gate (the gated set is exactly {police})", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await sign(key, { type: "hazard", nonce: "hazard-nogate-0001" });

    const res = await postReport(report, grant);
    expect(res.statusCode).toBe(200);
  }, 60_000);
});

describe("POST /contrib/reports — media is disabled (no media path in v1)", () => {
  it("lands a report carrying attributes.media as inert attributes with no special handling", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const report = await sign(key, {
      nonce: "media-inert-000001",
      attributes: { media: "data:image/png;base64,AAAA", note: "kept as opaque data" },
    });

    const res = await postReport(report, grant);
    expect(res.statusCode).toBe(200);

    const obsId = await crowdObservationId(key.keyId, "media-inert-000001");
    const rows = await sql<{ attributes: Record<string, unknown> | null }[]>`
      SELECT attributes FROM conditions.observations WHERE id = ${obsId}`;
    // The media key survives as inert attribute data — there is no server-side
    // media storage, redaction, or retrieval; it is just opaque JSON.
    expect(rows[0]!.attributes).toMatchObject({ media: "data:image/png;base64,AAAA" });

    // No media route/field exists: a media sub-path is simply not a route.
    const noRoute = await app.inject({
      method: "GET",
      url: `/contrib/reports/${encodeURIComponent(obsId)}/media`,
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
      10
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
      10
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
