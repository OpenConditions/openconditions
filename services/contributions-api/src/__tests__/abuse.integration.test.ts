import { readFileSync } from "node:fs";
import { generateReporterKey, type ReporterKey } from "@openconditions/contrib-core";
import { crowdLocalId } from "@openconditions/model";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coReportingClusters } from "../abuse/coreporting.js";
import { checkReportRate, type RateRule } from "../abuse/rate.js";
import { build } from "../server.js";
import {
  createTestDatabase,
  evidenceOf,
  INSTANCE,
  reportAs,
  situationClaim,
} from "./crowd-fixtures.integration.js";

const BASE_NOW = "2026-07-12T08:00:00.000Z";
const GRANT_SECRET_VALUE = "abuse-route-test-secret";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: postgres.Sql;
let app: FastifyInstance;
let currentNow = BASE_NOW;
let ipCounter = 0;

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
    now: () => currentNow,
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
}, 30_000);

/** A fresh per-call source IP so the enrollment per-IP limiter never trips. */
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 250}`;
}

/** The id a crowd report from a key with a nonce lands under here. */
function crowdId(key: ReporterKey, nonce: string): string {
  return `oc:situation:${INSTANCE}:${crowdLocalId(key.keyId, nonce)}`;
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

async function report(
  key: ReporterKey,
  grant: string,
  nonce: string,
  lon: number,
  lat: number,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const signed = await reportAs(
    key,
    situationClaim({
      geometry: { type: "Point", coordinates: [lon, lat] },
      reportedAt: currentNow,
      nonce,
    }),
  );
  const res = await app.inject({
    method: "POST",
    url: "/contrib/reports",
    payload: { report: signed, reportingGrant: grant },
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe("report rate limiting — per key across all cells", () => {
  it("admits only ten concurrent reports and returns quota-full replays without new evidence", async () => {
    currentNow = "2026-07-12T07:00:00.000Z";
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const responses = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        report(key, grant, `parallel-key-${String(i).padStart(8, "0")}`, 4.9 + i * 0.02, 52.37),
      ),
    );
    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(10);
    expect(
      responses.filter((r) => r.statusCode === 429 && r.body["reason"] === "per-key"),
    ).toHaveLength(6);
    const accepted = responses.findIndex((r) => r.statusCode === 200);
    const replay = await report(
      key,
      grant,
      `parallel-key-${String(accepted).padStart(8, "0")}`,
      4.9 + accepted * 0.02,
      52.37,
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toEqual(responses[accepted]!.body);
    const [evidence] = await sql<{ count: number }[]>`SELECT count(*)::int AS count
      FROM conditions.report_evidence WHERE actor_key_id = ${key.keyId} AND evidence_kind = 'report'`;
    expect(evidence?.count).toBe(10);
    const [situations] = await sql<{ count: number }[]>`SELECT count(*)::int AS count
      FROM conditions.situation WHERE record->'provenance'->'reporter'->>'keyId' = ${key.keyId}`;
    expect(situations?.count).toBe(10);
  }, 120_000);

  it("accepts 10 reports spread across cells inside 60s and 429s the 11th", async () => {
    currentNow = "2026-07-12T08:00:00.000Z";
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const codes: number[] = [];
    let reason: unknown;
    for (let i = 0; i < 11; i++) {
      // ~1.4km+ of longitude spacing → every report in a different ~1km cell.
      const res = await report(
        key,
        grant,
        `spread-${String(i).padStart(12, "0")}`,
        4.9 + i * 0.02,
        52.37,
      );
      codes.push(res.statusCode);
      if (res.statusCode === 429) reason = res.body["reason"];
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
    expect(reason).toBe("per-key");
  }, 120_000);
});

describe("report rate limiting — per key per coarse cell", () => {
  it("enforces concurrent cell quotas independently for different reporters", async () => {
    currentNow = "2026-07-12T07:30:00.000Z";
    const keys = await Promise.all([generateReporterKey(), generateReporterKey()]);
    const grants = await Promise.all(keys.map(enroll));
    const perKey = await Promise.all(
      keys.map((key, index) =>
        Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            report(key, grants[index]!, `parallel-cell-${String(i).padStart(8, "0")}`, 4.9, 52.37),
          ),
        ),
      ),
    );
    for (const responses of perKey) {
      expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(4);
      expect(
        responses.filter((r) => r.statusCode === 429 && r.body["reason"] === "per-key-cell"),
      ).toHaveLength(4);
    }
  }, 120_000);

  it("429s the 5th report in ONE cell even though the per-key total is under the cap", async () => {
    currentNow = "2026-07-12T09:00:00.000Z";
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const codes: number[] = [];
    let reason: unknown;
    for (let i = 0; i < 5; i++) {
      const res = await report(key, grant, `onecell-${String(i).padStart(11, "0")}`, 4.9, 52.37);
      codes.push(res.statusCode);
      if (res.statusCode === 429) reason = res.body["reason"];
    }
    expect(codes.slice(0, 4).every((c) => c === 200)).toBe(true);
    expect(codes[4]).toBe(429);
    expect(reason).toBe("per-key-cell");
  }, 120_000);

  it("accepts reports spread across cells when no single cell exceeds its limit", async () => {
    currentNow = "2026-07-12T10:00:00.000Z";
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const cells: Array<[number, number]> = [
      [4.9, 52.37],
      [5.1, 52.37],
    ];
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const [lon, lat] = cells[i % 2]!;
      const res = await report(key, grant, `twocell-${String(i).padStart(11, "0")}`, lon, lat);
      codes.push(res.statusCode);
    }
    expect(codes.every((c) => c === 200)).toBe(true);
  }, 120_000);

  it("counts per (key, cell): another key in the same cell is unaffected", async () => {
    currentNow = "2026-07-12T11:00:00.000Z";
    const keyA = await generateReporterKey();
    const keyB = await generateReporterKey();
    const grantA = await enroll(keyA);
    const grantB = await enroll(keyB);
    for (let i = 0; i < 4; i++) {
      const res = await report(keyA, grantA, `filler-${String(i).padStart(12, "0")}`, 6.6, 53.2);
      expect(res.statusCode).toBe(200);
    }
    const other = await report(keyB, grantB, "other-key-0000000001", 6.6, 53.2);
    expect(other.statusCode).toBe(200);
  }, 120_000);
});

describe("checkReportRate — reusable limiter contract", () => {
  it("returns ok for a key with no recent reports and honors a custom rule", async () => {
    const idle = await checkReportRate(sql, "no-such-key", 4.9, 52.37, "2026-07-12T12:00:00.000Z");
    expect(idle).toEqual({ ok: true });

    const zeroRule: RateRule = { windowSec: 60, maxPerKey: 0, maxPerKeyCell: 0 };
    const blocked = await checkReportRate(
      sql,
      "no-such-key",
      4.9,
      52.37,
      "2026-07-12T12:00:00.000Z",
      zeroRule,
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("per-key");
  }, 30_000);

  it("counts by the server's arrival time, so a backdated claim dodges nothing", async () => {
    currentNow = "2026-07-12T12:30:00.000Z";
    const key = await generateReporterKey();
    const grant = await enroll(key);
    const signed = await reportAs(
      key,
      situationClaim({
        geometry: { type: "Point", coordinates: [7.7, 48.6] },
        reportedAt: "2026-07-12T12:20:00.000Z",
        nonce: "backdated-00000000001",
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/contrib/reports",
      payload: { report: signed, reportingGrant: grant },
    });
    expect(res.statusCode).toBe(200);
    const rule: RateRule = { windowSec: 60, maxPerKey: 1, maxPerKeyCell: 1 };
    expect(await checkReportRate(sql, key.keyId, 7.7, 48.6, currentNow, rule)).toEqual({
      ok: false,
      reason: "per-key",
    });
  }, 60_000);
});

describe("kinematic plausibility — post-hoc flag, never a block", () => {
  it("lands an implausible teleport with 200 AND sets flagged_at on the new situation", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);

    currentNow = "2026-07-12T13:00:00.000Z";
    const first = await report(key, grant, "teleport-a-00000001", 4.9, 52.37);
    expect(first.statusCode).toBe(200);

    // Amsterdam → Berlin (~577 km) in 60s ≈ 34,600 km/h: a teleport.
    currentNow = "2026-07-12T13:01:00.000Z";
    const second = await report(key, grant, "teleport-b-00000001", 13.405, 52.52);
    expect(second.statusCode).toBe(200);

    const firstId = crowdId(key, "teleport-a-00000001");
    const secondId = crowdId(key, "teleport-b-00000001");
    expect((await evidenceOf(sql, firstId)).flagged_at).toBeNull();
    const flagged = (await evidenceOf(sql, secondId)).flagged_at;
    expect(flagged).not.toBeNull();
    expect(flagged!.toISOString()).toBe("2026-07-12T13:01:00.000Z");

    // The flag is anomaly metadata, not evidence: the report still landed
    // self_reported and the ledger holds only its own report row.
    const evidence = await sql<{ kinds: string[] }[]>`
      SELECT array_agg(evidence_kind) AS kinds FROM conditions.report_evidence
      WHERE record_class = 'situation' AND record_id = ${secondId}`;
    expect(evidence[0]!.kinds).toEqual(["report"]);
    expect(second.body["evidenceState"]).toBe("self_reported");
  }, 120_000);

  it("does not flag a plausible sequence", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);

    currentNow = "2026-07-12T14:00:00.000Z";
    const first = await report(key, grant, "drive-a-00000000001", 6.0, 52.0);
    expect(first.statusCode).toBe(200);

    // ~1 km in 10 minutes ≈ 6 km/h.
    currentNow = "2026-07-12T14:10:00.000Z";
    const second = await report(key, grant, "drive-b-00000000001", 6.0, 52.009);
    expect(second.statusCode).toBe(200);

    expect((await evidenceOf(sql, crowdId(key, "drive-a-00000000001"))).flagged_at).toBeNull();
    expect((await evidenceOf(sql, crowdId(key, "drive-b-00000000001"))).flagged_at).toBeNull();
  }, 120_000);
});

describe("co-reporting monitoring view", () => {
  async function insertEvidence(
    recordId: string,
    keyId: string,
    kind: "report" | "confirm" | "negate",
    occurredAt: string,
  ): Promise<void> {
    await sql`
      INSERT INTO conditions.report_evidence
        (record_class, record_id, evidence_kind, actor_key_id, occurred_at, details)
      VALUES ('situation', ${recordId}, ${kind}, ${keyId}, ${occurredAt}, '{}'::jsonb)`;
  }

  it("surfaces a key pair sharing report and confirm rows on the same records, keys ordered", async () => {
    const at = "2026-07-12T15:00:00.000Z";
    for (const n of [1, 2, 3]) {
      const record = `oc:situation:${INSTANCE}:collude-${n}`;
      await insertEvidence(record, "colluder-x", "report", at);
      await insertEvidence(record, "colluder-y", "confirm", at);
    }
    // A key standing on only one of those records stays below the threshold.
    await insertEvidence(`oc:situation:${INSTANCE}:collude-1`, "bystander-z", "confirm", at);

    const clusters = await coReportingClusters(sql, "2026-07-12T14:59:00.000Z");
    const pair = clusters.find((c) => c.keyA === "colluder-x" && c.keyB === "colluder-y");
    expect(pair).toBeDefined();
    expect(pair!.sharedCount).toBe(3);
    expect(clusters.some((c) => c.keyA === "bystander-z" || c.keyB === "bystander-z")).toBe(false);
    for (const cluster of clusters) {
      expect(cluster.keyA < cluster.keyB).toBe(true);
    }
  }, 30_000);

  it("does not count negations as co-reporting", async () => {
    const at = "2026-07-12T16:00:00.000Z";
    for (const n of [1, 2, 3]) {
      const record = `oc:situation:${INSTANCE}:disputed-${n}`;
      await insertEvidence(record, "disputed-x", "report", at);
      await insertEvidence(record, "disputed-y", "negate", at);
    }
    const clusters = await coReportingClusters(sql, "2026-07-12T15:59:00.000Z");
    expect(clusters.some((c) => c.keyA === "disputed-x" || c.keyB === "disputed-x")).toBe(false);
  }, 30_000);

  it("ignores rows older than sinceIso", async () => {
    for (const n of [1, 2, 3]) {
      const record = `oc:situation:${INSTANCE}:old-cluster-${n}`;
      await insertEvidence(record, "old-cluster-x", "report", "2026-07-12T15:00:00.000Z");
      await insertEvidence(record, "old-cluster-y", "report", "2026-07-12T15:00:00.000Z");
    }
    const before = await coReportingClusters(sql, "2026-07-12T14:59:00.000Z");
    expect(before.some((c) => c.keyA === "old-cluster-x" && c.keyB === "old-cluster-y")).toBe(true);
    const clusters = await coReportingClusters(sql, "2026-07-12T15:01:00.000Z");
    expect(clusters.some((c) => c.keyA === "old-cluster-x")).toBe(false);
  }, 30_000);

  it("is observability only: no accept/reject path imports it", () => {
    const gatedPaths = [
      "../server.ts",
      "../landing/land.ts",
      "../subclaim/vote.ts",
      "../reputation/resolve.ts",
      "../reviewer/decide.ts",
    ];
    for (const path of gatedPaths) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(source.includes("coreporting"), `${path} must not import coreporting`).toBe(false);
      expect(source.includes("coReportingClusters")).toBe(false);
    }
  });
});
