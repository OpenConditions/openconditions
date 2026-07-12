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
import { build } from "../server.js";

const NOW = "2026-07-12T08:00:00.000Z";
const GRANT_SECRET_VALUE = "reviewer-route-test-grant-secret";
const REVIEWER_TOKEN = "reviewer-route-test-operator-token";

let sql: postgres.Sql;
let dbUrl: string;
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
  dbUrl = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  sql = postgres(dbUrl, { max: 10 });
  await runMigrations(dbUrl);
  app = await build({
    sql,
    env: {
      OPENCONDITIONS_GRANT_SECRET: GRANT_SECRET_VALUE,
      OPENCONDITIONS_REVIEWER_TOKEN: REVIEWER_TOKEN,
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
  return `198.51.100.${ipCounter % 250}`;
}

function makeClaim(overrides: Partial<ReportClaim> = {}): ReportClaim {
  return {
    domain: "roads",
    type: "congestion",
    geometry: { type: "Point", coordinates: [4.9, 52.37] },
    fuzziness: "low_res",
    reportedAt: nowValue,
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

async function landReportFrom(
  key: ReporterKey,
  grant: string,
  overrides: Partial<ReportClaim>
): Promise<{ statusCode: number; id?: string }> {
  const report: SignedReport = await signReport(makeClaim(overrides), key);
  const res = await app.inject({
    method: "POST",
    url: "/contrib/reports",
    payload: { report, reportingGrant: grant },
  });
  return {
    statusCode: res.statusCode,
    id:
      res.statusCode === 200 ? (res.json() as { observationId: string }).observationId : undefined,
  };
}

/** Enroll a key and land a fresh active crowd observation from it. */
async function landObs(
  overrides: Partial<ReportClaim>
): Promise<{ key: ReporterKey; grant: string; id: string }> {
  const key = await generateReporterKey();
  const grant = await enroll(key);
  const landed = await landReportFrom(key, grant, overrides);
  expect(landed.statusCode).toBe(200);
  return { key, grant, id: landed.id! };
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

/** Flag an observation through the real T6 sub-claim flag route. */
async function flagObs(id: string, reason?: string): Promise<void> {
  const key = await generateReporterKey();
  const grant = await enroll(key);
  const sub = await signSub(key, id, "flag", reason === undefined ? {} : { reason });
  const res = await app.inject({
    method: "POST",
    url: `/contrib/reports/${id}/flag`,
    payload: { subClaim: sub, reportingGrant: grant },
  });
  expect(res.statusCode).toBe(200);
}

function reviewerInject(
  method: "GET" | "POST" | "DELETE",
  url: string,
  opts: { token?: string; payload?: unknown } = {}
) {
  const headers: Record<string, string> =
    opts.token === undefined ? {} : { authorization: `Bearer ${opts.token}` };
  return app.inject({ method, url, headers, payload: opts.payload as never });
}

interface ObsRow {
  status: string;
  evidence_state: string | null;
  routing_eligible: boolean;
  flagged_at: Date | null;
  headline: string | null;
  description: string | null;
  subject: unknown;
  label: string | null;
  severity: string | null;
  severity_level: number | null;
  attributes: Record<string, unknown> | null;
  origin: { kind?: string; reporter?: { keyId?: string } } | null;
  canonical_id: string | null;
  instance_id: string | null;
  phenomenon_fingerprint: string | null;
}

async function readObs(id: string): Promise<ObsRow | undefined> {
  const rows = await sql<ObsRow[]>`
    SELECT status, evidence_state, routing_eligible, flagged_at, headline, description,
           subject, label, severity, severity_level, attributes, origin,
           canonical_id, instance_id, phenomenon_fingerprint
    FROM conditions.observations WHERE id = ${id}`;
  return rows[0];
}

async function enrollRaw(key: ReporterKey) {
  return app.inject({
    method: "POST",
    url: "/contrib/enroll",
    payload: { pubJwk: key.publicJwk, proof: { keyId: key.keyId } },
    remoteAddress: nextIp(),
  });
}

async function readPosterior(keyId: string): Promise<{ alpha: number; beta: number }> {
  const rows = await sql<{ reputation_alpha: number; reputation_beta: number }[]>`
    SELECT reputation_alpha, reputation_beta FROM conditions.reporter WHERE key_id = ${keyId}`;
  return { alpha: rows[0]!.reputation_alpha, beta: rows[0]!.reputation_beta };
}

async function countEvidence(id: string, kind: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM conditions.report_evidence
    WHERE observation_id = ${id} AND evidence_kind = ${kind}`;
  return rows[0]!.n;
}

describe("migration 0012 — conditions.block_list", () => {
  it("creates the block_list table with the expected columns", async () => {
    const cols = await sql<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'conditions' AND table_name = 'block_list'
      ORDER BY column_name`;
    const names = cols.map((c) => c.column_name).sort();
    expect(names).toEqual(["created_at", "created_by", "key_id", "reason"]);
  }, 30_000);
});

describe("reviewer auth — operator bearer token", () => {
  it("rejects a request with no bearer with 401", async () => {
    const res = await reviewerInject("GET", "/contrib/reviewer/flagged");
    expect(res.statusCode).toBe(401);
  });

  it("rejects a wrong bearer with 401", async () => {
    const res = await reviewerInject("GET", "/contrib/reviewer/flagged", {
      token: "not-the-token",
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the correct bearer with 200", async () => {
    const res = await reviewerInject("GET", "/contrib/reviewer/flagged", { token: REVIEWER_TOKEN });
    expect(res.statusCode).toBe(200);
  });

  it("build() throws when the reviewer token is unset in production (fail closed)", async () => {
    await expect(
      build({
        sql,
        env: {
          NODE_ENV: "production",
          OPENCONDITIONS_GRANT_SECRET: GRANT_SECRET_VALUE,
          OPENCONDITIONS_INSTANCE_ID: "maps.example.org",
        },
        logger: false,
        now: () => nowValue,
      })
    ).rejects.toThrow(/OPENCONDITIONS_REVIEWER_TOKEN/);
  }, 30_000);
});

describe("GET /contrib/reviewer/flagged — the anomaly queue", () => {
  it("lists an open-flagged observation with its flagCount and flagReasons", async () => {
    const { id } = await landObs({
      nonce: "queue-flag-00000001",
      geometry: { type: "Point", coordinates: [4.9, 52.37] },
    });
    nowValue = "2026-07-12T08:05:00.000Z";
    await flagObs(id, "looks like spam");

    const res = await reviewerInject("GET", "/contrib/reviewer/flagged", { token: REVIEWER_TOKEN });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Record<string, unknown>[]; nextBefore: string | null };
    const item = body.items.find((i) => i.observationId === id);
    expect(item).toBeDefined();
    expect(item!.type).toBe("congestion");
    expect(item!.flagCount).toBe(1);
    expect(item!.flagReasons).toEqual(["looks like spam"]);
    expect((item!.geometry as { type: string }).type).toBe("Point");
  }, 60_000);

  it("paginates newest-flag-first with a keyset cursor", async () => {
    const a = await landObs({
      nonce: "queue-page-a-000001",
      geometry: { type: "Point", coordinates: [10.0, 45.0] },
    });
    const b = await landObs({
      nonce: "queue-page-b-000001",
      geometry: { type: "Point", coordinates: [20.0, 40.0] },
    });
    nowValue = "2026-07-12T09:00:00.000Z";
    await flagObs(a.id);
    nowValue = "2026-07-12T09:05:00.000Z";
    await flagObs(b.id);

    const first = await reviewerInject("GET", "/contrib/reviewer/flagged?limit=1", {
      token: REVIEWER_TOKEN,
    });
    const firstBody = first.json() as { items: { observationId: string }[]; nextBefore: string };
    expect(firstBody.items).toHaveLength(1);
    // b was flagged latest, so it comes first.
    expect(firstBody.items[0]!.observationId).toBe(b.id);
    expect(firstBody.nextBefore).not.toBeNull();

    const second = await reviewerInject(
      "GET",
      `/contrib/reviewer/flagged?limit=1&before=${encodeURIComponent(firstBody.nextBefore)}`,
      { token: REVIEWER_TOKEN }
    );
    const secondBody = second.json() as { items: { observationId: string }[] };
    const ids = secondBody.items.map((i) => i.observationId);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  }, 90_000);

  it("omits observations that were never flagged", async () => {
    const { id } = await landObs({
      nonce: "queue-unflagged-001",
      geometry: { type: "Point", coordinates: [30.0, 35.0] },
    });
    const res = await reviewerInject("GET", "/contrib/reviewer/flagged?limit=200", {
      token: REVIEWER_TOKEN,
    });
    const body = res.json() as { items: { observationId: string }[] };
    expect(body.items.map((i) => i.observationId)).not.toContain(id);
  }, 60_000);
});

describe("POST /contrib/reviewer/observations/:id/accept", () => {
  it("externally resolves, routes, clears the flag, and trains the originator confirmed", async () => {
    const { key, id } = await landObs({
      nonce: "accept-000000000001",
      geometry: { type: "Point", coordinates: [-10.0, 30.0] },
    });
    await flagObs(id);
    expect((await readObs(id))!.flagged_at).not.toBeNull();

    nowValue = "2026-07-12T08:10:00.000Z";
    const res = await reviewerInject("POST", `/contrib/reviewer/observations/${id}/accept`, {
      token: REVIEWER_TOKEN,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      observationId: string;
      evidenceState: string;
      routingEligible: boolean;
    };
    expect(body.evidenceState).toBe("externally_resolved");
    expect(body.routingEligible).toBe(true);

    const row = await readObs(id);
    expect(row!.evidence_state).toBe("externally_resolved");
    expect(row!.routing_eligible).toBe(true);
    expect(row!.flagged_at).toBeNull();
    expect(row!.status).toBe("active");
    // The originating reporter was trained confirmed (Beta(2,2) -> (3,2)).
    expect(await readPosterior(key.keyId)).toEqual({ alpha: 3, beta: 2 });
  }, 60_000);

  it("re-accepting a resolved observation is a 409", async () => {
    const { id } = await landObs({
      nonce: "accept-again-000001",
      geometry: { type: "Point", coordinates: [-20.0, 25.0] },
    });
    await flagObs(id);
    expect(
      (
        await reviewerInject("POST", `/contrib/reviewer/observations/${id}/accept`, {
          token: REVIEWER_TOKEN,
        })
      ).statusCode
    ).toBe(200);
    const again = await reviewerInject("POST", `/contrib/reviewer/observations/${id}/accept`, {
      token: REVIEWER_TOKEN,
    });
    expect(again.statusCode).toBe(409);
  }, 60_000);

  it("accepting a non-existent observation is a 404", async () => {
    const res = await reviewerInject(
      "POST",
      "/contrib/reviewer/observations/crowd:none:missing0001/accept",
      { token: REVIEWER_TOKEN }
    );
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /contrib/reviewer/observations/:id/reject — tombstone", () => {
  it("negates, tombstones the row, retains the ledger, and trains the originator rejected", async () => {
    const { key, id } = await landObs({
      nonce: "reject-000000000001",
      geometry: { type: "Point", coordinates: [-30.0, 20.0] },
      subject: [{ type: "osm", id: "way/123" }],
      attributes: { direction: "N" },
    });
    await flagObs(id);
    const before = await readObs(id);
    expect(before!.canonical_id).not.toBeNull();

    nowValue = "2026-07-12T08:20:00.000Z";
    const res = await reviewerInject("POST", `/contrib/reviewer/observations/${id}/reject`, {
      token: REVIEWER_TOKEN,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { evidenceState: string; tombstoned: boolean };
    expect(body.evidenceState).toBe("negated");
    expect(body.tombstoned).toBe(true);

    const row = await readObs(id);
    expect(row!.status).toBe("archived");
    expect(row!.evidence_state).toBe("negated");
    expect(row!.flagged_at).toBeNull();
    // Content scrubbed to a minimal deletion record.
    expect(row!.headline).toBeNull();
    expect(row!.description).toBeNull();
    expect(row!.subject).toBeNull();
    expect(row!.label).toBeNull();
    expect(row!.severity).toBeNull();
    expect(row!.severity_level).toBeNull();
    expect(row!.attributes).toEqual({
      tombstone: true,
      reason: "reviewer_reject",
      at: "2026-07-12T08:20:00.000Z",
    });
    // origin scrubbed to a minimal marker — the reporter key is dropped from the
    // PUBLIC row (the ledger keeps the linkage for audit).
    expect(row!.origin).toEqual({ kind: "crowd" });
    expect(row!.origin?.reporter).toBeUndefined();
    // Federation identity kept.
    expect(row!.canonical_id).toBe(before!.canonical_id);
    expect(row!.instance_id).toBe(before!.instance_id);
    expect(row!.phenomenon_fingerprint).toBe(before!.phenomenon_fingerprint);
    // The audit ledger is retained.
    expect(await countEvidence(id, "report")).toBe(1);
    expect(await countEvidence(id, "reviewer_reject")).toBe(1);
    // The originating reporter was trained rejected (Beta(2,2) -> (2,3)).
    expect(await readPosterior(key.keyId)).toEqual({ alpha: 2, beta: 3 });
  }, 60_000);

  it("rejecting an already-tombstoned observation is a 409", async () => {
    const { id } = await landObs({
      nonce: "reject-again-000001",
      geometry: { type: "Point", coordinates: [-40.0, 15.0] },
    });
    await flagObs(id);
    expect(
      (
        await reviewerInject("POST", `/contrib/reviewer/observations/${id}/reject`, {
          token: REVIEWER_TOKEN,
        })
      ).statusCode
    ).toBe(200);
    const again = await reviewerInject("POST", `/contrib/reviewer/observations/${id}/reject`, {
      token: REVIEWER_TOKEN,
    });
    expect(again.statusCode).toBe(409);
  }, 60_000);

  it("rejecting a non-existent observation is a 404", async () => {
    const res = await reviewerInject(
      "POST",
      "/contrib/reviewer/observations/crowd:none:missing0002/reject",
      { token: REVIEWER_TOKEN }
    );
    expect(res.statusCode).toBe(404);
  });

  it("tombstones a community-NEGATED flagged observation (no GDPR-reachability gap)", async () => {
    const { id } = await landObs({
      nonce: "reject-negated-0001",
      geometry: { type: "Point", coordinates: [-15.0, 12.0] },
    });
    // Peers negate it (status stays 'active'); it is also flagged for review.
    await sql`UPDATE conditions.observations SET evidence_state = 'negated' WHERE id = ${id}`;
    await flagObs(id, "disputed and negated");

    // It shows up in the queue despite being peer-negated.
    const queue = await reviewerInject("GET", "/contrib/reviewer/flagged?limit=200", {
      token: REVIEWER_TOKEN,
    });
    const ids = (queue.json() as { items: { observationId: string }[] }).items.map(
      (i) => i.observationId
    );
    expect(ids).toContain(id);

    // Reject is allowed regardless of the negated state and tombstones it.
    const res = await reviewerInject("POST", `/contrib/reviewer/observations/${id}/reject`, {
      token: REVIEWER_TOKEN,
    });
    expect(res.statusCode).toBe(200);
    const row = await readObs(id);
    expect(row!.status).toBe("archived");
    expect(row!.evidence_state).toBe("negated");
    expect(row!.attributes).toMatchObject({ tombstone: true });

    // A second reject on the tombstoned row is a 409.
    const again = await reviewerInject("POST", `/contrib/reviewer/observations/${id}/reject`, {
      token: REVIEWER_TOKEN,
    });
    expect(again.statusCode).toBe(409);
  }, 60_000);
});

describe("reviewer block list", () => {
  it("blocks a key end-to-end: reporter blocked, new reports 403, listed, then unblock lands again", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    // The key can report before it is blocked.
    const cell: ReportClaim["geometry"] = { type: "Point", coordinates: [-50.0, 10.0] };
    const before = await landReportFrom(key, grant, {
      nonce: "block-before-00001",
      geometry: cell,
    });
    expect(before.statusCode).toBe(200);

    const blockRes = await reviewerInject("POST", "/contrib/reviewer/blocklist", {
      token: REVIEWER_TOKEN,
      payload: { keyId: key.keyId, reason: "abuse" },
    });
    expect(blockRes.statusCode).toBe(200);
    expect(blockRes.json()).toEqual({ keyId: key.keyId, blocked: true });

    const reporterStatus = await sql<{ status: string }[]>`
      SELECT status FROM conditions.reporter WHERE key_id = ${key.keyId}`;
    expect(reporterStatus[0]!.status).toBe("blocked");

    // A subsequent report from the blocked key is refused.
    const blocked = await landReportFrom(key, grant, {
      nonce: "block-after-000001",
      geometry: cell,
    });
    expect(blocked.statusCode).toBe(403);

    // The block is listed.
    const list = await reviewerInject("GET", "/contrib/reviewer/blocklist", {
      token: REVIEWER_TOKEN,
    });
    const listBody = list.json() as { items: { keyId: string; reason: string | null }[] };
    const listed = listBody.items.find((i) => i.keyId === key.keyId);
    expect(listed).toBeDefined();
    expect(listed!.reason).toBe("abuse");

    // Unblock restores reporting.
    const unblockRes = await reviewerInject(
      "DELETE",
      `/contrib/reviewer/blocklist/${encodeURIComponent(key.keyId)}`,
      { token: REVIEWER_TOKEN }
    );
    expect(unblockRes.statusCode).toBe(200);
    expect(unblockRes.json()).toEqual({ keyId: key.keyId, blocked: false });

    const restored = await landReportFrom(key, grant, {
      nonce: "block-restored-0001",
      geometry: cell,
    });
    expect(restored.statusCode).toBe(200);
  }, 90_000);

  it("requires a keyId in the block body (400)", async () => {
    const res = await reviewerInject("POST", "/contrib/reviewer/blocklist", {
      token: REVIEWER_TOKEN,
      payload: { reason: "no key" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires the operator bearer (401 without it)", async () => {
    const res = await reviewerInject("POST", "/contrib/reviewer/blocklist", {
      payload: { keyId: "whatever" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("blocks a key BEFORE it enrolls: a later enroll is refused (403) and lands blocked", async () => {
    const key = await generateReporterKey();
    // Block the key while it has no reporter row at all.
    const blockRes = await reviewerInject("POST", "/contrib/reviewer/blocklist", {
      token: REVIEWER_TOKEN,
      payload: { keyId: key.keyId, reason: "pre-emptive" },
    });
    expect(blockRes.statusCode).toBe(200);

    // The subsequent enrollment is refused with no grant.
    const enrolled = await enrollRaw(key);
    expect(enrolled.statusCode).toBe(403);
    expect((enrolled.json() as { reportingGrant?: string }).reportingGrant).toBeUndefined();

    // The reporter row exists but is blocked, so no report path is reachable.
    const status = await sql<{ status: string }[]>`
      SELECT status FROM conditions.reporter WHERE key_id = ${key.keyId}`;
    expect(status[0]!.status).toBe("blocked");
  }, 60_000);

  it("refuses token issuance for a blocked key holding a still-valid grant (403)", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    // Block the (already-enrolled) key AFTER it obtained a grant.
    expect(
      (
        await reviewerInject("POST", "/contrib/reviewer/blocklist", {
          token: REVIEWER_TOKEN,
          payload: { keyId: key.keyId },
        })
      ).statusCode
    ).toBe(200);

    // The grant still verifies, but the token path re-checks reporter status.
    const res = await app.inject({
      method: "POST",
      url: "/contrib/tokens",
      payload: { reportingGrant: grant, blindedRequest: "AA" },
    });
    expect(res.statusCode).toBe(403);
  }, 60_000);
});

describe("StreetComplete rule — piling onto a disputed element", () => {
  it("flags a second report that lands onto an open-flagged phenomenon (still 200)", async () => {
    const a = await landObs({
      nonce: "sc-first-000000001",
      geometry: { type: "Point", coordinates: [5.12, 51.7] },
    });
    await flagObs(a.id);
    expect((await readObs(a.id))!.flagged_at).not.toBeNull();

    // A DIFFERENT key reports the same phenomenon (same type, place, time).
    const b = await landObs({
      nonce: "sc-second-00000001",
      geometry: { type: "Point", coordinates: [5.12, 51.7] },
    });
    expect(b.id).not.toBe(a.id);
    const row = await readObs(b.id);
    expect(row!.status).toBe("active");
    expect(row!.flagged_at).not.toBeNull();
  }, 90_000);

  it("does NOT flag a report with no open-flagged neighbor", async () => {
    const { id } = await landObs({
      nonce: "sc-lonely-00000001",
      geometry: { type: "Point", coordinates: [6.9, 50.9] },
    });
    expect((await readObs(id))!.flagged_at).toBeNull();
  }, 60_000);

  it("still lands 200 when the post-hoc flag check throws (never fails the landing)", async () => {
    const throwingApp = await build({
      sql,
      env: {
        OPENCONDITIONS_GRANT_SECRET: GRANT_SECRET_VALUE,
        OPENCONDITIONS_REVIEWER_TOKEN: REVIEWER_TOKEN,
        OPENCONDITIONS_INSTANCE_ID: "maps.example.org",
      },
      logger: false,
      now: () => nowValue,
      streetCompleteCheck: async () => {
        throw new Error("boom: matcher blew up");
      },
    });
    try {
      const key = await generateReporterKey();
      const enrollRes = await throwingApp.inject({
        method: "POST",
        url: "/contrib/enroll",
        payload: { pubJwk: key.publicJwk, proof: { keyId: key.keyId } },
        remoteAddress: nextIp(),
      });
      const grant = (enrollRes.json() as { reportingGrant: string }).reportingGrant;
      const report = await signReport(
        makeClaim({
          nonce: "sc-throws-00000001",
          geometry: { type: "Point", coordinates: [7.5, 47.5] },
        }),
        key
      );
      const res = await throwingApp.inject({
        method: "POST",
        url: "/contrib/reports",
        payload: { report, reportingGrant: grant },
      });
      // The landing still succeeds despite the hook throwing.
      expect(res.statusCode).toBe(200);
      const id = (res.json() as { observationId: string }).observationId;
      expect((await readObs(id))!.status).toBe("active");
    } finally {
      await throwingApp.close();
    }
  }, 60_000);
});
