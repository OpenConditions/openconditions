import {
  generateReporterKey,
  type RecordRef,
  type ReporterKey,
  type SignedSubClaim,
  type SituationClaim,
  type SubClaimBody,
  type SubClaimType,
  signSubClaim,
} from "@openconditions/contrib-core";
import { crowdLocalId } from "@openconditions/model";
import { tombstoneRecords } from "@openconditions/storage";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createReportingGrant } from "../attester/grant.js";
import { build } from "../server.js";
import {
  createTestDatabase,
  feedSituationDraft,
  INSTANCE,
  registry,
  reportAs,
  seedFeedSituation,
  situationClaim,
} from "./crowd-fixtures.integration.js";

const NOW = "2026-07-12T08:00:00.000Z";
const GRANT_SECRET_VALUE = "subclaims-route-test-secret";
const GRANT_SECRET = new TextEncoder().encode(GRANT_SECRET_VALUE);

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
let app: FastifyInstance;
let ipCounter = 0;
let nowValue = NOW;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  app = await build({
    sql,
    env: {
      OPENCONDITIONS_GRANT_SECRET: GRANT_SECRET_VALUE,
      OPENCONDITIONS_INSTANCE_ID: INSTANCE,
    },
    logger: false,
    now: () => nowValue,
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
}, 30_000);

beforeEach(() => {
  nowValue = NOW;
});

/** A fresh per-call source IP so the enrollment per-IP limiter never trips. */
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 250}`;
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

/**
 * Distinct phenomenon per landed report: landing auto-corroborates two
 * INDEPENDENT reports of the same phenomenon, so these voting/flag tests —
 * which each want a single isolated report — land at their own coordinate
 * unless they override geometry. ~0.5° apart is far beyond the match distance.
 */
let landCounter = 0;
function nextLandGeometry(): SituationClaim["geometry"] {
  const lon = 8.0 + landCounter * 0.5;
  landCounter += 1;
  return { type: "Point", coordinates: [lon, 45.0] };
}

/** Enroll a key and land a fresh live crowd situation from it; returns id + grant. */
async function landSituation(
  nonce: string,
  overrides: Partial<SituationClaim> = {},
): Promise<{ key: ReporterKey; grant: string; id: string }> {
  const key = await generateReporterKey();
  const grant = await enroll(key);
  const report = await reportAs(
    key,
    situationClaim({ geometry: nextLandGeometry(), reportedAt: nowValue, nonce, ...overrides }),
  );
  const res = await app.inject({
    method: "POST",
    url: "/contrib/reports",
    payload: { report, reportingGrant: grant },
  });
  expect(res.statusCode).toBe(200);
  return { key, grant, id: (res.json() as { record: { id: string } }).record.id };
}

const situationRef = (id: string): RecordRef => ({ class: "situation", id });

async function signSub(
  key: ReporterKey,
  subject: RecordRef | string,
  claimType: SubClaimType,
  overrides: Partial<SubClaimBody> = {},
): Promise<SignedSubClaim> {
  const body: SubClaimBody = {
    subject: typeof subject === "string" ? situationRef(subject) : subject,
    claimType,
    reportedAt: nowValue,
    nonce: `sub-${claimType}-${Math.random().toString(36).slice(2, 14)}`,
    ...overrides,
  };
  return signSubClaim(body, key);
}

/**
 * A sub-claim whose body the wire contract refuses. Signing refuses such a
 * body, so a valid sub-claim's body field is swapped: verification checks the
 * body before it checks the signature.
 */
function withBody(sub: SignedSubClaim, over: Record<string, unknown>): SignedSubClaim {
  return { ...sub, ...over } as SignedSubClaim;
}

function vote(
  id: string,
  action: string,
  subClaim: SignedSubClaim,
  reportingGrant: string,
  opts: { recordClass?: string; component?: string } = {},
) {
  const query =
    opts.component === undefined ? "" : `?component=${encodeURIComponent(opts.component)}`;
  return app.inject({
    method: "POST",
    url: `/contrib/reports/${opts.recordClass ?? "situation"}/${encodeURIComponent(id)}/${action}${query}`,
    payload: { subClaim, reportingGrant },
  });
}

interface SituationRow {
  evidence_state: string | null;
  routing_eligible: boolean;
  confidence_score: number | null;
  corroborations: number;
  expires_at: Date | null;
  flagged_at: Date | null;
  freshness_expires_at: string | null;
}

async function readSituation(id: string): Promise<SituationRow | undefined> {
  const rows = await sql<SituationRow[]>`
    SELECT evidence_state, routing_eligible, confidence_score, corroborations, expires_at,
           flagged_at, record->'freshness'->>'expiresAt' AS freshness_expires_at
    FROM conditions.situation WHERE id = ${id}`;
  return rows[0];
}

async function countEvidence(id: string, kind: string, keyId?: string): Promise<number> {
  const rows = keyId
    ? await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM conditions.report_evidence
        WHERE record_class = 'situation' AND record_id = ${id}
          AND evidence_kind = ${kind} AND actor_key_id = ${keyId}`
    : await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM conditions.report_evidence
        WHERE record_class = 'situation' AND record_id = ${id} AND evidence_kind = ${kind}`;
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

describe("POST /contrib/reports/situation/:id/confirm — corroboration never routes", () => {
  it("two distinct keys corroborate: state corroborated, routing STILL false, score 0.525, expiry extended", async () => {
    const { id } = await landSituation("confirm-land-0000001");
    const landed = await readSituation(id);
    expect(landed!.evidence_state).toBe("self_reported");
    const landedExpiry = landed!.expires_at!.getTime();

    // A distinct enrolled key confirms 60s later.
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    nowValue = "2026-07-12T08:01:00.000Z";
    const res = await vote(id, "confirm", await signSub(keyB, id, "confirm"), grantB);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      record: { class: "situation", id },
      evidenceState: "corroborated",
      routingEligible: false,
      action: "confirm",
    });

    const row = await readSituation(id);
    expect(row!.evidence_state).toBe("corroborated");
    expect(row!.routing_eligible).toBe(false);
    expect(row!.corroborations).toBe(1);
    // Incremental crowd confidence for a single distinct confirmation (c=1):
    // 0.3 + (0.75 - 0.3) * (1 - 0.5^1) = 0.525.
    expect(row!.confidence_score).toBeCloseTo(0.525, 10);
    // Corroboration extends the lifetime from the confirm, in the column and
    // the record's freshness alike.
    expect(row!.expires_at!.getTime()).toBeGreaterThan(landedExpiry);
    expect(row!.expires_at!.toISOString()).toBe("2026-07-12T08:16:00.000Z");
    expect(row!.freshness_expires_at).toBe(row!.expires_at!.toISOString());

    expect(await countEvidence(id, "confirm", keyB.keyId)).toBe(1);
  }, 60_000);

  it("a third distinct confirm keeps the report corroborated and still not routing", async () => {
    const { id } = await landSituation("confirm-third-000001");
    const keyB = await generateReporterKey();
    const keyC = await generateReporterKey();
    const grantB = await enroll(keyB);
    const grantC = await enroll(keyC);
    expect((await vote(id, "confirm", await signSub(keyB, id, "confirm"), grantB)).statusCode).toBe(
      200,
    );
    const third = await vote(id, "confirm", await signSub(keyC, id, "confirm"), grantC);
    expect(third.statusCode).toBe(200);
    const body = third.json() as { evidenceState: string; routingEligible: boolean };
    expect(body.evidenceState).toBe("corroborated");
    expect(body.routingEligible).toBe(false);
    expect((await readSituation(id))!.corroborations).toBe(2);
  }, 60_000);
});

describe("POST /contrib/reports/situation/:id/confirm — crowd agreement never trains reputation", () => {
  it("five colluding distinct-key confirms through the real vote route leave every posterior at Beta(2,2)", async () => {
    const { key: originator, id } = await landSituation("collude-land-0000001");
    const colluders: ReporterKey[] = [];
    for (let i = 0; i < 5; i++) {
      const keyN = await generateReporterKey();
      const grantN = await enroll(keyN);
      colluders.push(keyN);
      const res = await vote(id, "confirm", await signSub(keyN, id, "confirm"), grantN);
      expect(res.statusCode).toBe(200);
    }

    const row = await readSituation(id);
    expect(row!.evidence_state).toBe("corroborated");
    expect(row!.routing_eligible).toBe(false);

    // Peer confirmation moved the evidence STATE but must not have touched a
    // single posterior.
    expect(await readPosterior(originator.keyId)).toEqual({ alpha: 2, beta: 2 });
    for (const colluder of colluders) {
      expect(await readPosterior(colluder.keyId)).toEqual({ alpha: 2, beta: 2 });
    }
  }, 120_000);
});

describe("POST /contrib/reports/situation/:id/confirm — idempotency", () => {
  it("the same key confirming twice appends exactly one evidence row and one sub_claim", async () => {
    const { id } = await landSituation("confirm-idem-000001");
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
    const { id } = await landSituation("confirm-idem2-00001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);

    expect((await vote(id, "confirm", await signSub(keyB, id, "confirm"), grantB)).statusCode).toBe(
      200,
    );
    const again = await vote(id, "confirm", await signSub(keyB, id, "confirm"), grantB);
    expect(again.statusCode).toBe(200);

    expect(await countEvidence(id, "confirm", keyB.keyId)).toBe(1);
    expect(await countSubClaims(id, keyB.keyId, "confirm")).toBe(1);
  }, 60_000);

  it("stores the sub-claim under the hash of its key and nonce, naming the record", async () => {
    const { id } = await landSituation("confirm-row-0000001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const nonce = "confirm-row-sub-0001";
    const sub = await signSub(keyB, id, "confirm", { nonce });
    expect((await vote(id, "confirm", sub, grantB)).statusCode).toBe(200);

    const rows = await sql<
      {
        id: string;
        subject_class: string;
        subject_id: string;
        subject_component_key: string;
        signature: string;
      }[]
    >`
      SELECT id, subject_class, subject_id, subject_component_key, signature
      FROM conditions.sub_claim WHERE key_id = ${keyB.keyId}`;
    expect(rows).toEqual([
      {
        id: crowdLocalId(keyB.keyId, nonce),
        subject_class: "situation",
        subject_id: id,
        subject_component_key: "",
        signature: sub.signature,
      },
    ]);
    expect(rows[0]!.id).not.toContain(keyB.keyId);
  }, 60_000);
});

describe("POST /contrib/reports/situation/:id/confirm — self-vote never corroborates", () => {
  it("the originating key confirming its OWN report stays self_reported", async () => {
    const { key, grant, id } = await landSituation("confirm-self-000001");
    const res = await vote(id, "confirm", await signSub(key, id, "confirm"), grant);

    expect(res.statusCode).toBe(200);
    expect((res.json() as { evidenceState: string }).evidenceState).toBe("self_reported");
    const row = await readSituation(id);
    expect(row!.evidence_state).toBe("self_reported");
    expect(row!.confidence_score).toBeCloseTo(0.3, 10);
    expect(row!.routing_eligible).toBe(false);
    expect(row!.corroborations).toBe(0);
  }, 60_000);
});

describe("POST /contrib/reports/situation/:id/negate — retraction vs peer negation", () => {
  it("a single distinct-key negate on a self_reported report is not enough (stays self_reported)", async () => {
    const { id } = await landSituation("negate-peer-000001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const res = await vote(id, "negate", await signSub(keyB, id, "negate"), grantB);

    expect(res.statusCode).toBe(200);
    expect((res.json() as { evidenceState: string }).evidenceState).toBe("self_reported");
    expect((await readSituation(id))!.evidence_state).toBe("self_reported");
  }, 60_000);

  it("the originating key negating its own report retracts it (negated)", async () => {
    const { key, grant, id } = await landSituation("negate-self-000001");
    const res = await vote(id, "negate", await signSub(key, id, "negate"), grant);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { evidenceState: string; routingEligible: boolean };
    expect(body.evidenceState).toBe("negated");
    expect(body.routingEligible).toBe(false);
    const row = await readSituation(id);
    expect(row!.evidence_state).toBe("negated");
    expect(row!.confidence_score).toBeCloseTo(0.1, 10);
  }, 60_000);
});

describe("POST /contrib/reports/situation/:id/flag — a flag is a marker, not evidence", () => {
  it("sets flagged_at, leaves evidence_state unchanged, and appends no evidence row", async () => {
    const { id } = await landSituation("flag-000000000001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const res = await vote(id, "flag", await signSub(keyB, id, "flag", { reason: "spam" }), grantB);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ flagged: true });

    const row = await readSituation(id);
    expect(row!.flagged_at).not.toBeNull();
    expect(row!.evidence_state).toBe("self_reported");
    expect(await countEvidence(id, "confirm")).toBe(0);
    expect(await countEvidence(id, "negate")).toBe(0);
    expect(await countSubClaims(id, keyB.keyId, "flag")).toBe(1);
  }, 60_000);

  it("a repeat flag is idempotent and keeps the first flagged_at", async () => {
    const { id } = await landSituation("flag-idem-00000001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const sub = await signSub(keyB, id, "flag");
    expect((await vote(id, "flag", sub, grantB)).statusCode).toBe(200);
    const firstFlaggedAt = (await readSituation(id))!.flagged_at!.toISOString();

    nowValue = "2026-07-12T08:10:00.000Z";
    expect((await vote(id, "flag", sub, grantB)).statusCode).toBe(200);
    expect((await readSituation(id))!.flagged_at!.toISOString()).toBe(firstFlaggedAt);
    expect(await countSubClaims(id, keyB.keyId, "flag")).toBe(1);
  }, 60_000);
});

describe("POST /contrib/reports/situation/:id/:action — votes on a feed situation", () => {
  it("records a confirm and a negate but never gives the feed record crowd evidence", async () => {
    const feedId = await seedFeedSituation(sql, "voted-feed-1", {
      location: {
        ...(feedSituationDraft("x")["location"] as object),
        geometry: { type: "Point", coordinates: [-3.0, 40.0] },
      },
    });
    const keyB = await generateReporterKey();
    const keyC = await generateReporterKey();
    const grantB = await enroll(keyB);
    const grantC = await enroll(keyC);

    const confirm = await vote(feedId, "confirm", await signSub(keyB, feedId, "confirm"), grantB);
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json()).toEqual({
      record: { class: "situation", id: feedId },
      evidenceState: null,
      routingEligible: false,
      action: "confirm",
    });
    const negate = await vote(feedId, "negate", await signSub(keyC, feedId, "negate"), grantC);
    expect(negate.statusCode).toBe(200);

    expect(await countSubClaims(feedId, keyB.keyId, "confirm")).toBe(1);
    expect(await countEvidence(feedId, "confirm", keyB.keyId)).toBe(1);
    expect(await countEvidence(feedId, "negate", keyC.keyId)).toBe(1);
    // Its lifetime is its source's: nothing was recomputed.
    expect(await readSituation(feedId)).toMatchObject({
      evidence_state: null,
      routing_eligible: false,
      confidence_score: null,
      corroborations: 0,
      expires_at: null,
      freshness_expires_at: null,
    });
  }, 60_000);

  it("flags a feed situation for review", async () => {
    const feedId = await seedFeedSituation(sql, "flagged-feed-1", {
      location: {
        ...(feedSituationDraft("x")["location"] as object),
        geometry: { type: "Point", coordinates: [-3.5, 40.0] },
      },
    });
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const res = await vote(feedId, "flag", await signSub(keyB, feedId, "flag"), grantB);
    expect(res.statusCode).toBe(200);
    expect((await readSituation(feedId))!.flagged_at).not.toBeNull();
  }, 60_000);
});

describe("POST /contrib/reports/situation/:id/:action — sub-claim geometry screen", () => {
  it("stores a valid Point geometry and reaches 200", async () => {
    const { id } = await landSituation("geo-valid-000000001");
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
      FROM conditions.sub_claim WHERE id = ${crowdLocalId(keyB.keyId, nonce)}`;
    expect(rows[0]!.x).toBeCloseTo(4.91, 9);
    expect(rows[0]!.y).toBeCloseTo(52.36, 9);
  }, 60_000);

  it("rejects a 3D Point with 422 at the geometry screen (records are 2D) and writes nothing", async () => {
    const { id } = await landSituation("geo-3d-0000000001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const sub = await signSub(keyB, id, "confirm", {
      geometry: { type: "Point", coordinates: [4.9, 52.37, 12] },
    });
    const res = await vote(id, "confirm", sub, grantB);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { reasons: string[] }).reasons).toContain("geometry_malformed");
    expect(await countSubClaims(id, keyB.keyId, "confirm")).toBe(0);
    expect(await countEvidence(id, "confirm", keyB.keyId)).toBe(0);
  }, 60_000);

  it.each([
    ["a nested position", { type: "Point", coordinates: [[4.9, 52.37]] }],
    ["an out-of-range Point", { type: "Point", coordinates: [999, 999] }],
    [
      "a LineString",
      {
        type: "LineString",
        coordinates: [
          [4.9, 52.37],
          [4.91, 52.38],
        ],
      },
    ],
  ])(
    "refuses %s at verification (400), never stores it and never 500s",
    async (label, geometry) => {
      const { id } = await landSituation(`geo-bad-${label.replaceAll(/[^a-z]/g, "")}`.slice(0, 40));
      const keyB = await generateReporterKey();
      const grantB = await enroll(keyB);
      const sub = withBody(await signSub(keyB, id, "confirm"), { geometry });
      const res = await vote(id, "confirm", sub, grantB);
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toMatch(/sub-claim verification failed/);
      expect(await countSubClaims(id, keyB.keyId, "confirm")).toBe(0);
      expect(await countEvidence(id, "confirm", keyB.keyId)).toBe(0);
    },
    60_000,
  );

  it("accepts an absent geometry (200, geom null)", async () => {
    const { id } = await landSituation("geo-absent-0000001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const nonce = "geo-absent-sub-0001";
    const res = await vote(id, "confirm", await signSub(keyB, id, "confirm", { nonce }), grantB);
    expect(res.statusCode).toBe(200);
    const rows = await sql<{ geom: string | null }[]>`
      SELECT geom FROM conditions.sub_claim WHERE id = ${crowdLocalId(keyB.keyId, nonce)}`;
    expect(rows[0]!.geom).toBeNull();
  }, 60_000);
});

describe("POST /contrib/reports/:class/:id/:action — rejections at the trust boundary", () => {
  it("rejects an unknown action with 404", async () => {
    const { id } = await landSituation("reject-action-00001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const res = await vote(id, "endorse", await signSub(keyB, id, "confirm"), grantB);
    expect(res.statusCode).toBe(404);
  }, 60_000);

  it("rejects an unknown record class with 404", async () => {
    const { id } = await landSituation("reject-class-000001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const res = await vote(id, "confirm", await signSub(keyB, id, "confirm"), grantB, {
      recordClass: "observations",
    });
    expect(res.statusCode).toBe(404);
  }, 60_000);

  it("answers a vote on a feature or an offer with 422 unsupported_record_class", async () => {
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const featureId = "oc:feature:de-bnetza:site-1";
    const onFeature = await vote(
      featureId,
      "confirm",
      await signSub(keyB, { class: "feature", id: featureId, componentKey: "evse-1" }, "confirm"),
      grantB,
      { recordClass: "feature", component: "evse-1" },
    );
    expect(onFeature.statusCode).toBe(422);
    expect((onFeature.json() as { reason: string }).reason).toBe("unsupported_record_class");

    const offerId = "oc:offer:de-bnetza:tariff-1";
    const onOffer = await vote(
      offerId,
      "negate",
      await signSub(keyB, { class: "offer", id: offerId }, "negate"),
      grantB,
      { recordClass: "offer" },
    );
    expect(onOffer.statusCode).toBe(422);
    expect((onOffer.json() as { reason: string }).reason).toBe("unsupported_record_class");

    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.sub_claim WHERE key_id = ${keyB.keyId}`;
    expect(n).toBe(0);
  }, 60_000);

  it("rejects a bad grant with 401", async () => {
    const { id } = await landSituation("reject-grant-000001");
    const keyB = await generateReporterKey();
    await enroll(keyB);
    const res = await vote(id, "confirm", await signSub(keyB, id, "confirm"), "bogus.grant");
    expect(res.statusCode).toBe(401);
  }, 60_000);

  it("rejects a grant minted for a different key with 401 (grant binds the key)", async () => {
    const { id } = await landSituation("reject-wrongkey-001");
    const keyB = await generateReporterKey();
    await enroll(keyB);
    const grantForOther = await createReportingGrant("some-other-key", nowValue, GRANT_SECRET);
    const res = await vote(id, "confirm", await signSub(keyB, id, "confirm"), grantForOther);
    expect(res.statusCode).toBe(401);
  }, 60_000);

  it("rejects a tampered signature with 400", async () => {
    const { id } = await landSituation("reject-sig-0000001");
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
    const { id } = await landSituation("reject-mismatch-001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    // Signed as a confirm but replayed on the negate route.
    const res = await vote(id, "negate", await signSub(keyB, id, "confirm"), grantB);
    expect(res.statusCode).toBe(400);
    expect(await countSubClaims(id, keyB.keyId, "confirm")).toBe(0);
  }, 60_000);

  it("rejects a signed subject that names another record with 400", async () => {
    const { id } = await landSituation("reject-subject-0001");
    const other = await landSituation("reject-subject-0002");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);

    const otherId = await vote(id, "confirm", await signSub(keyB, other.id, "confirm"), grantB);
    expect(otherId.statusCode).toBe(400);
    expect((otherId.json() as { error: string }).error).toMatch(/route's record/);

    const otherClass = await vote(
      id,
      "confirm",
      await signSub(keyB, { class: "feature", id }, "confirm"),
      grantB,
    );
    expect(otherClass.statusCode).toBe(400);

    const componentOnRouteOnly = await vote(
      id,
      "confirm",
      await signSub(keyB, id, "confirm"),
      grantB,
      {
        component: "evse-1",
      },
    );
    expect(componentOnRouteOnly.statusCode).toBe(400);

    expect(await countSubClaims(id, keyB.keyId, "confirm")).toBe(0);
    expect(await countSubClaims(other.id, keyB.keyId, "confirm")).toBe(0);
  }, 60_000);

  it("rejects an unknown (unenrolled) voting key with 403 and writes nothing", async () => {
    const { id } = await landSituation("reject-unenrolled-01");
    const strangerKey = await generateReporterKey();
    // A directly-minted grant is valid, but no enrollment ran → no reporter row.
    const grant = await createReportingGrant(strangerKey.keyId, nowValue, GRANT_SECRET);
    const res = await vote(id, "confirm", await signSub(strangerKey, id, "confirm"), grant);
    expect(res.statusCode).toBe(403);
    expect(await countSubClaims(id, strangerKey.keyId, "confirm")).toBe(0);
    expect(await countEvidence(id, "confirm", strangerKey.keyId)).toBe(0);
  }, 60_000);

  it("rejects a blocked reporter with 403", async () => {
    const { id } = await landSituation("reject-blocked-0001");
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    await sql`UPDATE conditions.reporter SET status = 'blocked' WHERE key_id = ${keyB.keyId}`;
    const res = await vote(id, "confirm", await signSub(keyB, id, "confirm"), grantB);
    expect(res.statusCode).toBe(403);
  }, 60_000);

  it("rejects a vote on a non-existent situation with 404", async () => {
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const missingId = `oc:situation:${INSTANCE}:${crowdLocalId(keyB.keyId, "does-not-exist0001")}`;
    const res = await vote(missingId, "confirm", await signSub(keyB, missingId, "confirm"), grantB);
    expect(res.statusCode).toBe(404);
  }, 60_000);

  it("rejects a vote on a tombstoned situation with 409", async () => {
    const { id } = await landSituation("reject-ended-000001");
    await tombstoneRecords(sql, "situation", [id], "withdrawn", { registry, now: nowValue });
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const res = await vote(id, "confirm", await signSub(keyB, id, "confirm"), grantB);
    expect(res.statusCode).toBe(409);
    expect(await countSubClaims(id, keyB.keyId, "confirm")).toBe(0);
  }, 60_000);
});

describe("POST /contrib/reports/situation/:id/:action — a settled report is closed to voting", () => {
  it("rejects a confirm on an externally_resolved report with 409 and writes nothing", async () => {
    const { id } = await landSituation("resolved-confirm-001");
    await sql`
      UPDATE conditions.situation
      SET evidence_state = 'externally_resolved', routing_eligible = true WHERE id = ${id}`;
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const res = await vote(id, "confirm", await signSub(keyB, id, "confirm"), grantB);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/already resolved/i);
    expect(await countSubClaims(id, keyB.keyId, "confirm")).toBe(0);
    expect(await countEvidence(id, "confirm", keyB.keyId)).toBe(0);
  }, 60_000);

  it("rejects a negate on a negated report with 409", async () => {
    const { id } = await landSituation("resolved-negate-0001");
    await sql`UPDATE conditions.situation SET evidence_state = 'negated' WHERE id = ${id}`;
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const res = await vote(id, "negate", await signSub(keyB, id, "negate"), grantB);
    expect(res.statusCode).toBe(409);
    expect(await countSubClaims(id, keyB.keyId, "negate")).toBe(0);
  }, 60_000);

  it("still allows flagging a resolved report for review", async () => {
    const { id } = await landSituation("resolved-flag-00001");
    await sql`
      UPDATE conditions.situation
      SET evidence_state = 'externally_resolved', routing_eligible = true WHERE id = ${id}`;
    const keyB = await generateReporterKey();
    const grantB = await enroll(keyB);
    const res = await vote(
      id,
      "flag",
      await signSub(keyB, id, "flag", { reason: "stale" }),
      grantB,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ flagged: true });
    const row = await readSituation(id);
    expect(row!.flagged_at).not.toBeNull();
    expect(row!.evidence_state).toBe("externally_resolved");
  }, 60_000);
});
