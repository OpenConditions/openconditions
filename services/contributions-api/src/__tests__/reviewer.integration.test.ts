import {
  generateReporterKey,
  type ReporterKey,
  type SignedSubClaim,
  type SituationClaim,
  type SubClaimType,
  signSubClaim,
} from "@openconditions/contrib-core";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "../server.js";
import {
  createTestDatabase,
  evidenceOf,
  feedSituationDraft,
  INSTANCE,
  reportAs,
  seedFeedSituation,
  seedPeerCrowdReport,
  situationClaim,
} from "./crowd-fixtures.integration.js";

const NOW = "2026-07-12T08:00:00.000Z";
const GRANT_SECRET_VALUE = "reviewer-route-test-grant-secret";
const REVIEWER_TOKEN = "reviewer-route-test-operator-token";
const ENV = {
  OPENCONDITIONS_GRANT_SECRET: GRANT_SECRET_VALUE,
  OPENCONDITIONS_REVIEWER_TOKEN: REVIEWER_TOKEN,
  OPENCONDITIONS_INSTANCE_ID: INSTANCE,
};

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
let app: FastifyInstance;
let ipCounter = 0;
let nowValue = NOW;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  app = await build({ sql, env: ENV, logger: false, now: () => nowValue });
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
  return `198.51.100.${ipCounter % 250}`;
}

async function enroll(key: ReporterKey): Promise<string> {
  const res = await enrollRaw(key);
  return (res.json() as { reportingGrant: string }).reportingGrant;
}

async function enrollRaw(key: ReporterKey) {
  return app.inject({
    method: "POST",
    url: "/contrib/enroll",
    payload: { pubJwk: key.publicJwk, proof: { keyId: key.keyId } },
    remoteAddress: nextIp(),
  });
}

async function landReportFrom(
  key: ReporterKey,
  grant: string,
  overrides: Partial<SituationClaim>,
): Promise<{ statusCode: number; id?: string }> {
  const report = await reportAs(key, situationClaim({ reportedAt: nowValue, ...overrides }));
  const res = await app.inject({
    method: "POST",
    url: "/contrib/reports",
    payload: { report, reportingGrant: grant },
  });
  return {
    statusCode: res.statusCode,
    id: res.statusCode === 200 ? (res.json() as { record: { id: string } }).record.id : undefined,
  };
}

/** Enroll a key and land a fresh live crowd situation from it. */
async function landSituation(
  overrides: Partial<SituationClaim>,
): Promise<{ key: ReporterKey; grant: string; id: string }> {
  const key = await generateReporterKey();
  const grant = await enroll(key);
  const landed = await landReportFrom(key, grant, overrides);
  expect(landed.statusCode).toBe(200);
  return { key, grant, id: landed.id! };
}

async function signSub(
  key: ReporterKey,
  id: string,
  claimType: SubClaimType,
  reason?: string,
): Promise<SignedSubClaim> {
  return signSubClaim(
    {
      subject: { class: "situation", id },
      claimType,
      reportedAt: nowValue,
      nonce: `sub-${claimType}-${Math.random().toString(36).slice(2, 14)}`,
      ...(reason === undefined ? {} : { reason }),
    },
    key,
  );
}

/** Flag a situation through the real sub-claim flag route. */
async function flagSituation(id: string, reason?: string): Promise<void> {
  const key = await generateReporterKey();
  const grant = await enroll(key);
  const res = await app.inject({
    method: "POST",
    url: `/contrib/reports/situation/${encodeURIComponent(id)}/flag`,
    payload: { subClaim: await signSub(key, id, "flag", reason), reportingGrant: grant },
  });
  expect(res.statusCode).toBe(200);
}

function reviewerInject(
  method: "GET" | "POST" | "DELETE",
  url: string,
  opts: { token?: string; payload?: unknown } = {},
) {
  const headers: Record<string, string> =
    opts.token === undefined ? {} : { authorization: `Bearer ${opts.token}` };
  return app.inject({ method, url, headers, payload: opts.payload as never });
}

function decide(id: string, decision: string, recordClass = "situation") {
  return reviewerInject(
    "POST",
    `/contrib/reviewer/${recordClass}/${encodeURIComponent(id)}/${decision}`,
    { token: REVIEWER_TOKEN },
  );
}

interface SituationRow {
  evidence_state: string | null;
  routing_eligible: boolean;
  flagged_at: Date | null;
  tombstone_reason: string | null;
  tombstoned_at: Date | null;
  revision: number;
  record: Record<string, unknown>;
}

async function readSituation(id: string): Promise<SituationRow | undefined> {
  const rows = await sql<SituationRow[]>`
    SELECT evidence_state, routing_eligible, flagged_at, tombstone_reason, tombstoned_at,
           revision, record
    FROM conditions.situation WHERE id = ${id}`;
  return rows[0];
}

async function readPosterior(keyId: string): Promise<{ alpha: number; beta: number }> {
  const rows = await sql<{ reputation_alpha: number; reputation_beta: number }[]>`
    SELECT reputation_alpha, reputation_beta FROM conditions.reporter WHERE key_id = ${keyId}`;
  return { alpha: rows[0]!.reputation_alpha, beta: rows[0]!.reputation_beta };
}

async function countEvidence(id: string, kind: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM conditions.report_evidence
    WHERE record_class = 'situation' AND record_id = ${id} AND evidence_kind = ${kind}`;
  return rows[0]!.n;
}

/**
 * Stores a flagged situation DIRECTLY (no HTTP landing) so the post-hoc
 * landing hooks can't race the reviewer query, with a chosen local id so the
 * keyset order is known. A feed situation is the simplest such record; the
 * queue reads any origin.
 */
async function insertFlagged(local: string, lon: number, flaggedAt: string): Promise<string> {
  const id = await seedFeedSituation(sql, local, {
    location: {
      ...(feedSituationDraft(local)["location"] as object),
      geometry: { type: "Point", coordinates: [lon, 47.0] },
    },
  });
  await sql`UPDATE conditions.situation SET flagged_at = ${flaggedAt}::timestamptz WHERE id = ${id}`;
  return id;
}

/** Seeds a `report` evidence row (the originating claim) for a situation. */
async function seedReportEvidence(
  id: string,
  keyId: string | null,
  occurredAt: string,
): Promise<void> {
  await sql`
    INSERT INTO conditions.report_evidence
      (record_class, record_id, evidence_kind, actor_key_id, occurred_at, details)
    VALUES ('situation', ${id}, 'report', ${keyId}, ${occurredAt}::timestamptz, '{}'::jsonb)`;
}

/** Seeds a reporter row directly with an explicit posterior and timestamps. */
async function seedReporter(opts: {
  keyId: string;
  alpha?: number;
  beta?: number;
  trustSignal?: number | null;
  corroboratedCount?: number;
  createdAt?: string;
  lastActiveAt?: string;
  status?: string;
}): Promise<void> {
  await sql`
    INSERT INTO conditions.reporter
      (key_id, pub_jwk, reputation_alpha, reputation_beta, corroborated_count,
       trust_signal, entitlement_expires_at, status, created_at, last_active_at)
    VALUES
      (${opts.keyId}, ${sql.json({ kty: "EC" } as never)},
       ${opts.alpha ?? 2}, ${opts.beta ?? 2}, ${opts.corroboratedCount ?? 0},
       ${opts.trustSignal ?? null}, '2099-01-01T00:00:00.000Z', ${opts.status ?? "active"},
       ${opts.createdAt ?? "2026-06-12T08:00:00.000Z"}::timestamptz,
       ${opts.lastActiveAt ?? "2026-07-10T08:00:00.000Z"}::timestamptz)`;
}

/** Clears every flag but the given situations', so a page's positions are known. */
async function onlyFlagged(ids: readonly string[]): Promise<void> {
  await sql`
    UPDATE conditions.situation SET flagged_at = NULL
    WHERE flagged_at IS NOT NULL AND id <> ALL(${sql.array([...ids])})`;
}

interface ReporterSignalShape {
  keyId: string;
  status: string;
  trustSignal: number | null;
  reliabilityLowerBound: number;
  corroboratedCount: number;
  tenureDays: number;
  lastActiveAt: string;
  note: string;
}

interface FlaggedItemShape {
  record: { class: string; id: string };
  flaggedAt: string;
  origin: string;
  evidenceState: string | null;
  kind: string;
  type: string;
  geometry: { type: string } | null;
  flagCount: number;
  flagReasons: string[];
  reporter: ReporterSignalShape | null;
}

interface FlaggedPageShape {
  items: FlaggedItemShape[];
  nextBefore: string | null;
  nextBeforeId: string | null;
}

async function flaggedPage(query = "limit=200"): Promise<FlaggedPageShape> {
  const res = await reviewerInject("GET", `/contrib/reviewer/flagged?${query}`, {
    token: REVIEWER_TOKEN,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as FlaggedPageShape;
}

async function fetchFlaggedItem(id: string): Promise<FlaggedItemShape | undefined> {
  return (await flaggedPage()).items.find((i) => i.record.id === id);
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

  it("guards the decisions too (401 without the bearer)", async () => {
    const res = await reviewerInject("POST", "/contrib/reviewer/situation/any/accept");
    expect(res.statusCode).toBe(401);
  });

  it("build() throws when the reviewer token is unset in production (fail closed)", async () => {
    await expect(
      build({
        sql,
        env: {
          NODE_ENV: "production",
          OPENCONDITIONS_GRANT_SECRET: GRANT_SECRET_VALUE,
          OPENCONDITIONS_INSTANCE_ID: INSTANCE,
        },
        logger: false,
        now: () => nowValue,
      }),
    ).rejects.toThrow(/OPENCONDITIONS_REVIEWER_TOKEN/);
  }, 30_000);
});

describe("GET /contrib/reviewer/flagged — the anomaly queue", () => {
  it("lists an open-flagged situation with its record, flagCount, flagReasons and reporter", async () => {
    const { key, id } = await landSituation({
      nonce: "queue-flag-00000001",
      geometry: { type: "Point", coordinates: [4.9, 52.37] },
    });
    nowValue = "2026-07-12T08:05:00.000Z";
    await flagSituation(id, "looks like spam");

    const item = await fetchFlaggedItem(id);
    expect(item).toMatchObject({
      record: { class: "situation", id },
      flaggedAt: "2026-07-12T08:05:00.000Z",
      origin: "crowd",
      evidenceState: "self_reported",
      kind: "incident",
      type: "obstruction",
      geometry: { type: "Point" },
      flagCount: 1,
      flagReasons: ["looks like spam"],
      reporter: { keyId: key.keyId, status: "active" },
    });
  }, 60_000);

  it("paginates newest-flag-first with a keyset cursor", async () => {
    const a = await landSituation({
      nonce: "queue-page-a-000001",
      geometry: { type: "Point", coordinates: [10.0, 45.0] },
    });
    const b = await landSituation({
      nonce: "queue-page-b-000001",
      geometry: { type: "Point", coordinates: [20.0, 40.0] },
    });
    nowValue = "2026-07-12T08:06:00.000Z";
    await flagSituation(a.id);
    nowValue = "2026-07-12T08:07:00.000Z";
    await flagSituation(b.id);

    const first = await flaggedPage("limit=1");
    expect(first.items).toHaveLength(1);
    // b was flagged latest, so it comes first.
    expect(first.items[0]!.record.id).toBe(b.id);
    expect(first.nextBefore).not.toBeNull();
    expect(first.nextBeforeId).not.toBeNull();

    const second = await flaggedPage(
      `limit=1&before=${encodeURIComponent(first.nextBefore!)}&beforeId=${encodeURIComponent(first.nextBeforeId!)}`,
    );
    const ids = second.items.map((i) => i.record.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  }, 90_000);

  it("omits situations that were never flagged", async () => {
    const { id } = await landSituation({
      nonce: "queue-unflagged-001",
      geometry: { type: "Point", coordinates: [30.0, 35.0] },
    });
    expect((await flaggedPage()).items.map((i) => i.record.id)).not.toContain(id);
  }, 60_000);

  it("a non-full page ends the list with null cursor fields", async () => {
    const body = await flaggedPage();
    // The DB never holds 200 flagged rows in this suite, so the page is not full.
    expect(body.items.length).toBeLessThan(200);
    expect(body.nextBefore).toBeNull();
    expect(body.nextBeforeId).toBeNull();
  }, 60_000);
});

describe("GET /contrib/reviewer/flagged — composite (flagged_at, id) keyset cursor", () => {
  it("does not skip a same-flagged_at tie row split across a page boundary", async () => {
    // Three rows; TWO share the EXACT same flagged_at, and the page boundary lands
    // in the middle of that tie — the case a flagged_at-only cursor would skip.
    const tie = "2027-01-01T00:00:01.000Z";
    const later = "2027-01-01T00:00:02.000Z";
    const newest = await insertFlagged("cursor-tie-newest", 11.0, later);
    const tieA = await insertFlagged("cursor-tie-a", 12.0, tie);
    const tieB = await insertFlagged("cursor-tie-b", 13.0, tie);
    const mine = new Set([newest, tieA, tieB]);
    const [tieHi, tieLo] = [tieA, tieB].sort((x, y) => (x < y ? 1 : -1)); // id DESC
    await onlyFlagged([...mine]);

    // Page 1: newest first, boundary in the middle of the tie (limit 2).
    const b1 = await flaggedPage("limit=2");
    expect(b1.items.map((i) => i.record.id)).toEqual([newest, tieHi]);
    expect(b1.nextBefore).toBe(tie);
    expect(b1.nextBeforeId).toBe(tieHi);

    // Page 2: with BOTH cursor fields, the remaining tie row must appear — a
    // flagged_at-only cursor (before=tie) would have excluded it entirely.
    const b2 = await flaggedPage(
      `limit=2&before=${encodeURIComponent(b1.nextBefore!)}&beforeId=${encodeURIComponent(b1.nextBeforeId!)}`,
    );
    const p2Ids = b2.items.map((i) => i.record.id);
    expect(p2Ids[0]).toBe(tieLo);

    // Full set across both pages: no dup, no skip; every seeded row present.
    const seen = [...b1.items.map((i) => i.record.id), ...p2Ids].filter((id) => mine.has(id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(mine);
    // Global order across pages is (flagged_at DESC, id DESC).
    expect(seen).toEqual([newest, tieHi, tieLo]);
  }, 90_000);

  it("rejects a before without a beforeId with 400", async () => {
    const res = await reviewerInject(
      "GET",
      `/contrib/reviewer/flagged?before=${encodeURIComponent("2027-01-01T00:00:01.000Z")}`,
      { token: REVIEWER_TOKEN },
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects a beforeId without a before with 400", async () => {
    const res = await reviewerInject(
      "GET",
      `/contrib/reviewer/flagged?beforeId=${encodeURIComponent("oc:situation:x:y")}`,
      { token: REVIEWER_TOKEN },
    );
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /contrib/reviewer/:class/:id/:decision — the route", () => {
  it("answers an unknown decision with 404", async () => {
    const res = await decide("oc:situation:x:y", "approve");
    expect(res.statusCode).toBe(404);
  });

  it.each(["feature", "offer", "observation"])(
    "answers a %s with 422 unsupported_record_class",
    async (recordClass) => {
      const res = await decide(`oc:${recordClass}:x:y`, "accept", recordClass);
      expect(res.statusCode).toBe(422);
      expect((res.json() as { reason: string }).reason).toBe("unsupported_record_class");
    },
  );
});

describe("POST /contrib/reviewer/situation/:id/accept", () => {
  it("externally resolves, routes, clears the flag, and trains the originator confirmed", async () => {
    const { key, id } = await landSituation({
      nonce: "accept-000000000001",
      geometry: { type: "Point", coordinates: [-10.0, 30.0] },
    });
    await flagSituation(id);
    expect((await readSituation(id))!.flagged_at).not.toBeNull();

    nowValue = "2026-07-12T08:10:00.000Z";
    const res = await decide(id, "accept");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      record: { class: "situation", id },
      evidenceState: "externally_resolved",
      routingEligible: true,
      tombstoned: false,
    });

    const row = await readSituation(id);
    expect(row).toMatchObject({
      evidence_state: "externally_resolved",
      routing_eligible: true,
      flagged_at: null,
      tombstone_reason: null,
    });
    expect(await countEvidence(id, "reviewer_accept")).toBe(1);
    // The originating reporter was trained confirmed (Beta(2,2) -> (3,2)).
    expect(await readPosterior(key.keyId)).toEqual({ alpha: 3, beta: 2 });
    expect(await fetchFlaggedItem(id)).toBeUndefined();
  }, 60_000);

  it("re-accepting a resolved report is a 409", async () => {
    const { id } = await landSituation({
      nonce: "accept-again-000001",
      geometry: { type: "Point", coordinates: [-20.0, 25.0] },
    });
    await flagSituation(id);
    expect((await decide(id, "accept")).statusCode).toBe(200);
    expect((await decide(id, "accept")).statusCode).toBe(409);
  }, 60_000);

  it("accepting a non-existent situation is a 404", async () => {
    const res = await decide(`oc:situation:${INSTANCE}:missing0001`, "accept");
    expect(res.statusCode).toBe(404);
  });

  it("on a feed situation only clears the flag: its source decides its truth", async () => {
    const id = await insertFlagged("accept-feed-1", -25.0, "2026-07-12T07:30:00.000Z");
    const res = await decide(id, "accept");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ evidenceState: null, routingEligible: false });

    expect(await readSituation(id)).toMatchObject({
      evidence_state: null,
      routing_eligible: false,
      flagged_at: null,
      tombstone_reason: null,
      revision: 1,
    });
    expect(await countEvidence(id, "reviewer_accept")).toBe(0);
  }, 60_000);
});

describe("POST /contrib/reviewer/situation/:id/reject — tombstone", () => {
  it("negates, tombstones the report `rejected` in a new revision, retains the ledger, and trains the originator rejected", async () => {
    const { key, id } = await landSituation({
      nonce: "reject-000000000001",
      geometry: { type: "Point", coordinates: [-30.0, 20.0] },
    });
    await flagSituation(id);
    const before = await readSituation(id);
    expect(before!.revision).toBe(1);

    nowValue = "2026-07-12T08:10:00.000Z";
    const res = await decide(id, "reject");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      record: { class: "situation", id },
      evidenceState: "negated",
      routingEligible: false,
      tombstoned: true,
    });

    const row = await readSituation(id);
    expect(row).toMatchObject({
      evidence_state: "negated",
      routing_eligible: false,
      flagged_at: null,
      tombstone_reason: "rejected",
      tombstoned_at: new Date(nowValue),
      revision: 2,
    });
    expect(row!.record).toMatchObject({
      revision: 2,
      tombstone: { reason: "rejected", at: nowValue },
    });
    // The audit ledger is retained.
    expect(await countEvidence(id, "report")).toBe(1);
    expect(await countEvidence(id, "reviewer_reject")).toBe(1);
    // The originating reporter was trained rejected (Beta(2,2) -> (2,3)).
    expect(await readPosterior(key.keyId)).toEqual({ alpha: 2, beta: 3 });
    // A tombstoned report leaves the queue.
    expect(await fetchFlaggedItem(id)).toBeUndefined();
  }, 60_000);

  it("rejecting an already-tombstoned report is a 409", async () => {
    const { id } = await landSituation({
      nonce: "reject-again-000001",
      geometry: { type: "Point", coordinates: [-40.0, 15.0] },
    });
    await flagSituation(id);
    expect((await decide(id, "reject")).statusCode).toBe(200);
    expect((await decide(id, "reject")).statusCode).toBe(409);
  }, 60_000);

  it("rejecting a non-existent situation is a 404", async () => {
    const res = await decide(`oc:situation:${INSTANCE}:missing0002`, "reject");
    expect(res.statusCode).toBe(404);
  });

  it("refuses to reject a feed situation (409) and leaves it flagged", async () => {
    const id = await insertFlagged("reject-feed-1", -45.0, "2026-07-12T07:30:00.000Z");
    const res = await decide(id, "reject");
    expect(res.statusCode).toBe(409);
    expect(await readSituation(id)).toMatchObject({
      tombstone_reason: null,
      flagged_at: new Date("2026-07-12T07:30:00.000Z"),
      revision: 1,
    });
    expect(await countEvidence(id, "reviewer_reject")).toBe(0);
  }, 60_000);

  it("tombstones a community-NEGATED flagged report (no erasure-reachability gap)", async () => {
    const { id } = await landSituation({
      nonce: "reject-negated-0001",
      geometry: { type: "Point", coordinates: [-15.0, 12.0] },
    });
    // Peers negate it (it stays live); it is also flagged for review.
    await sql`UPDATE conditions.situation SET evidence_state = 'negated' WHERE id = ${id}`;
    await flagSituation(id, "disputed and negated");

    // It shows up in the queue despite being peer-negated.
    expect(await fetchFlaggedItem(id)).toBeDefined();

    // Reject is allowed regardless of the negated state and tombstones it.
    expect((await decide(id, "reject")).statusCode).toBe(200);
    expect(await readSituation(id)).toMatchObject({
      tombstone_reason: "rejected",
      evidence_state: "negated",
    });

    // A second reject on the tombstoned report is a 409.
    expect((await decide(id, "reject")).statusCode).toBe(409);
  }, 60_000);
});

describe("reviewer block list", () => {
  it("blocks a key end-to-end: reporter blocked, new reports 403, listed, then unblock lands again", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);
    // The key can report before it is blocked.
    const cell: SituationClaim["geometry"] = { type: "Point", coordinates: [-50.0, 10.0] };
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
      { token: REVIEWER_TOKEN },
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
      ).statusCode,
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

describe("GET /contrib/reviewer/flagged — originating-reporter advisory trust surface", () => {
  it("attaches the originating reporter's advisory component signals to a flagged item", async () => {
    const keyId = "trust-reporter-present-1";
    await seedReporter({
      keyId,
      alpha: 5,
      beta: 2,
      trustSignal: 0.8,
      corroboratedCount: 3,
      createdAt: "2026-06-12T08:00:00.000Z",
      lastActiveAt: "2026-07-10T08:00:00.000Z",
    });
    const id = await insertFlagged("trust-present-1", 11.11, "2027-02-01T00:00:00.000Z");
    await seedReportEvidence(id, keyId, "2026-06-12T08:00:00.000Z");

    const item = await fetchFlaggedItem(id);
    expect(item).toBeDefined();
    const reporter = item!.reporter;
    expect(reporter).not.toBeNull();
    expect(reporter!.keyId).toBe(keyId);
    expect(reporter!.status).toBe("active");
    expect(reporter!.trustSignal).toBe(0.8);
    expect(reporter!.corroboratedCount).toBe(3);
    expect(reporter!.reliabilityLowerBound).toBeGreaterThan(0);
    expect(reporter!.reliabilityLowerBound).toBeLessThan(1);
    // now = 2026-07-12, created = 2026-06-12 → ~30 days.
    expect(reporter!.tenureDays).toBeGreaterThan(29);
    expect(reporter!.tenureDays).toBeLessThan(31);
    expect(reporter!.lastActiveAt).toBe("2026-07-10T08:00:00.000Z");
    // Mirrors the /contrib/reporter/me advisory disclaimer — not a probability of truth.
    expect(reporter!.note).toMatch(/advisory/);
  }, 60_000);

  it("surfaces a BLOCKED originating reporter's status so a reviewer sees it", async () => {
    const keyId = "trust-reporter-blocked-1";
    await seedReporter({ keyId, alpha: 2, beta: 6, status: "blocked" });
    const id = await insertFlagged("trust-blocked-1", 15.55, "2027-03-01T00:00:00.000Z");
    await seedReportEvidence(id, keyId, "2026-06-12T08:00:00.000Z");

    const item = await fetchFlaggedItem(id);
    expect(item!.reporter).not.toBeNull();
    expect(item!.reporter!.status).toBe("blocked");
  }, 60_000);

  it("leaves reporter null for a flagged situation with no originating key", async () => {
    // A peer's crowd report: its report row carries no key.
    const federated = await seedPeerCrowdReport(sql, "trust-federated-1", [12.22, 47.0]);
    await sql`
      UPDATE conditions.situation SET flagged_at = '2027-02-01T00:00:01.000Z'
      WHERE id = ${federated}`;
    // A keyless auto-flag on a record with no report evidence at all.
    const autoFlag = await insertFlagged("trust-autoflag-1", 13.33, "2027-02-01T00:00:02.000Z");

    const fed = await fetchFlaggedItem(federated);
    const auto = await fetchFlaggedItem(autoFlag);
    expect(fed).toBeDefined();
    expect(fed!.origin).toBe("crowd");
    expect(fed!.reporter).toBeNull();
    expect(auto).toBeDefined();
    expect(auto!.origin).toBe("feed");
    expect(auto!.reporter).toBeNull();
  }, 60_000);

  it("is read-only: a GET mutates neither the reporter nor the situation", async () => {
    const keyId = "trust-readonly-key";
    await seedReporter({ keyId, alpha: 4, beta: 3, trustSignal: 0.5, corroboratedCount: 2 });
    const id = await insertFlagged("trust-readonly-1", 14.44, "2027-02-05T00:00:00.000Z");
    await seedReportEvidence(id, keyId, "2026-06-12T08:00:00.000Z");

    const snapshot = async () => ({
      reporter: (
        await sql`
          SELECT reputation_alpha, reputation_beta, corroborated_count, trust_signal,
                 last_active_at, created_at
          FROM conditions.reporter WHERE key_id = ${keyId}`
      )[0],
      situation: await readSituation(id),
    });
    const before = await snapshot();

    const item = await fetchFlaggedItem(id);
    expect(item!.reporter).not.toBeNull();

    expect(await snapshot()).toEqual(before);
  }, 60_000);

  it("computes a sane conservative reliabilityLowerBound for a fresh Beta(2,2) reporter", async () => {
    const keyId = "trust-fresh-key";
    await seedReporter({ keyId, alpha: 2, beta: 2 });
    const id = await insertFlagged("trust-fresh-1", 15.65, "2027-02-06T00:00:00.000Z");
    await seedReportEvidence(id, keyId, "2026-06-12T08:00:00.000Z");

    const item = await fetchFlaggedItem(id);
    // Beta(2,2) 10th-percentile lower bound at the 0.9 advisory level ≈ 0.2 —
    // conservative, well under the 0.5 symmetric mean, so it never over-claims.
    expect(item!.reporter!.reliabilityLowerBound).toBeGreaterThan(0.1);
    expect(item!.reporter!.reliabilityLowerBound).toBeLessThan(0.3);
  }, 60_000);

  it("keeps the (flagged_at, id) tie-break exact when the LATERAL reporter join is present", async () => {
    // Each tie row's originating reporter has MULTIPLE report rows: a
    // non-LIMIT-1 join would multiply rows and corrupt the keyset.
    const tie = "2027-03-01T00:00:01.000Z";
    const later = "2027-03-01T00:00:02.000Z";
    const newest = await insertFlagged("trust-tie-newest", 21.0, later);
    const tieA = await insertFlagged("trust-tie-a", 22.0, tie);
    const tieB = await insertFlagged("trust-tie-b", 23.0, tie);
    const keyA = "trust-tie-a-key";
    await seedReporter({ keyId: keyA });
    await seedReportEvidence(tieA, keyA, "2026-06-01T00:00:00.000Z");
    await seedReportEvidence(tieA, keyA, "2026-06-02T00:00:00.000Z");
    await seedReportEvidence(tieA, keyA, "2026-06-03T00:00:00.000Z");
    const mine = new Set([newest, tieA, tieB]);
    const [tieHi, tieLo] = [tieA, tieB].sort((x, y) => (x < y ? 1 : -1)); // id DESC
    await onlyFlagged([...mine]);

    const b1 = await flaggedPage("limit=2");
    // Exactly two rows despite tieA's three report rows — no multiplication.
    expect(b1.items.map((i) => i.record.id)).toEqual([newest, tieHi]);
    expect(b1.nextBefore).toBe(tie);
    expect(b1.nextBeforeId).toBe(tieHi);

    const b2 = await flaggedPage(
      `limit=2&before=${encodeURIComponent(b1.nextBefore!)}&beforeId=${encodeURIComponent(b1.nextBeforeId!)}`,
    );
    const p2Ids = b2.items.map((i) => i.record.id);
    expect(p2Ids[0]).toBe(tieLo);

    const seen = [...b1.items.map((i) => i.record.id), ...p2Ids].filter((id) => mine.has(id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(mine);
    expect(seen).toEqual([newest, tieHi, tieLo]);
  }, 90_000);
});

describe("StreetComplete rule — piling onto a disputed element", () => {
  it("flags a second report that lands onto an open-flagged situation (still 200, not merged)", async () => {
    const a = await landSituation({
      nonce: "sc-first-000000001",
      geometry: { type: "Point", coordinates: [5.12, 51.7] },
    });
    await flagSituation(a.id);
    expect((await readSituation(a.id))!.flagged_at).not.toBeNull();

    // A DIFFERENT key reports the same phenomenon (same kind, type, place, time).
    const b = await landSituation({
      nonce: "sc-second-00000001",
      geometry: { type: "Point", coordinates: [5.12, 51.7] },
    });
    expect(b.id).not.toBe(a.id);
    // Flagged, and as a disputed witness it stays its own report.
    expect(await evidenceOf(sql, b.id)).toMatchObject({
      tombstone_reason: null,
      evidence_state: "self_reported",
      flagged_at: expect.any(Date),
    });
    expect(await evidenceOf(sql, a.id)).toMatchObject({ corroborations: 0 });
  }, 90_000);

  it("flags a report that lands onto an open-flagged FEED situation", async () => {
    const feed = await insertFlagged("sc-feed-1", 6.3, "2026-07-12T07:30:00.000Z");
    const { id } = await landSituation({
      nonce: "sc-onto-feed-00001",
      geometry: { type: "Point", coordinates: [6.3, 47.0] },
    });
    expect(feed).not.toBe(id);
    expect((await readSituation(id))!.flagged_at).not.toBeNull();
  }, 60_000);

  it("does NOT flag a report with no open-flagged neighbor", async () => {
    const { id } = await landSituation({
      nonce: "sc-lonely-00000001",
      geometry: { type: "Point", coordinates: [6.9, 50.9] },
    });
    expect((await readSituation(id))!.flagged_at).toBeNull();
  }, 60_000);

  it("still lands 200 when the post-hoc flag check throws (never fails the landing)", async () => {
    const throwingApp = await build({
      sql,
      env: ENV,
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
      const report = await reportAs(
        key,
        situationClaim({
          nonce: "sc-throws-00000001",
          geometry: { type: "Point", coordinates: [7.5, 47.5] },
          reportedAt: nowValue,
        }),
      );
      const res = await throwingApp.inject({
        method: "POST",
        url: "/contrib/reports",
        payload: { report, reportingGrant: grant },
      });
      // The landing still succeeds despite the hook throwing.
      expect(res.statusCode).toBe(200);
      const id = (res.json() as { record: { id: string } }).record.id;
      expect((await readSituation(id))!.tombstone_reason).toBeNull();
    } finally {
      await throwingApp.close();
    }
  }, 60_000);
});
