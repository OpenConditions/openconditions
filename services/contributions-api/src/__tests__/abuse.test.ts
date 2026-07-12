import { readFileSync } from "node:fs";
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
import { coReportingClusters } from "../abuse/coreporting.js";
import { checkReportRate, type RateRule } from "../abuse/rate.js";
import { build } from "../server.js";

const BASE_NOW = "2026-07-12T08:00:00.000Z";
const GRANT_SECRET_VALUE = "abuse-route-test-secret";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;
let app: FastifyInstance;
let currentNow = BASE_NOW;
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
    now: () => currentNow,
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

async function report(
  key: ReporterKey,
  grant: string,
  nonce: string,
  lon: number,
  lat: number
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const claim: ReportClaim = {
    domain: "roads",
    type: "congestion",
    geometry: { type: "Point", coordinates: [lon, lat] },
    fuzziness: "low_res",
    reportedAt: currentNow,
    nonce,
  };
  const signed: SignedReport = await signReport(claim, key);
  const res = await app.inject({
    method: "POST",
    url: "/contrib/reports",
    payload: { report: signed, reportingGrant: grant },
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function readFlaggedAt(observationId: string): Promise<Date | null> {
  const rows = await sql<{ flagged_at: Date | null }[]>`
    SELECT flagged_at FROM conditions.observations WHERE id = ${observationId}`;
  expect(rows[0]).toBeDefined();
  return rows[0]!.flagged_at;
}

describe("report rate limiting — per key across all cells", () => {
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
        52.37
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
      zeroRule
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("per-key");
  }, 30_000);
});

describe("kinematic plausibility — post-hoc flag, never a block", () => {
  it("lands an implausible teleport with 200 AND sets flagged_at on the new observation", async () => {
    const key = await generateReporterKey();
    const grant = await enroll(key);

    currentNow = "2026-07-12T13:00:00.000Z";
    const first = await report(key, grant, "teleport-a-00000001", 4.9, 52.37);
    expect(first.statusCode).toBe(200);

    // Amsterdam → Berlin (~577 km) in 60s ≈ 34,600 km/h: a teleport.
    currentNow = "2026-07-12T13:01:00.000Z";
    const second = await report(key, grant, "teleport-b-00000001", 13.405, 52.52);
    expect(second.statusCode).toBe(200);

    const firstId = `crowd:${key.keyId}:teleport-a-00000001`;
    const secondId = `crowd:${key.keyId}:teleport-b-00000001`;
    expect(await readFlaggedAt(firstId)).toBeNull();
    const flagged = await readFlaggedAt(secondId);
    expect(flagged).not.toBeNull();
    expect(flagged!.toISOString()).toBe("2026-07-12T13:01:00.000Z");

    // The flag is anomaly metadata, not evidence: the report still landed
    // self_reported and the ledger holds only its own report row.
    const evidence = await sql<{ kinds: string[] }[]>`
      SELECT array_agg(evidence_kind) AS kinds FROM conditions.report_evidence
      WHERE observation_id = ${secondId}`;
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

    expect(await readFlaggedAt(`crowd:${key.keyId}:drive-a-00000000001`)).toBeNull();
    expect(await readFlaggedAt(`crowd:${key.keyId}:drive-b-00000000001`)).toBeNull();
  }, 120_000);
});

describe("co-reporting monitoring view", () => {
  async function insertReportWithFingerprint(
    id: string,
    keyId: string,
    fingerprint: string,
    occurredAt: string
  ): Promise<void> {
    await sql`
      INSERT INTO conditions.observations
        (id, source, source_format, domain, kind, type, status, geom, origin,
         data_updated_at, fetched_at, is_stale, phenomenon_fingerprint)
      VALUES
        (${id}, 'crowd', 'native', 'roads', 'event', 'hazard', 'active',
         ST_SetSRID(ST_MakePoint(4, 52), 4326), '{"kind":"crowd"}'::jsonb,
         now(), now(), false, ${fingerprint})`;
    await sql`
      INSERT INTO conditions.report_evidence
        (observation_id, evidence_kind, actor_key_id, occurred_at, details)
      VALUES (${id}, 'report', ${keyId}, ${occurredAt}, '{}'::jsonb)`;
  }

  it("surfaces a synthetic collusion cluster and orders the pair keys", async () => {
    const at = "2026-07-12T15:00:00.000Z";
    for (const fp of ["fp-collude-1", "fp-collude-2", "fp-collude-3"]) {
      await insertReportWithFingerprint(`obs:${fp}:x`, "colluder-x", fp, at);
      await insertReportWithFingerprint(`obs:${fp}:y`, "colluder-y", fp, at);
    }
    // A pair sharing only one fingerprint stays below the threshold.
    await insertReportWithFingerprint("obs:fp-collude-1:z", "bystander-z", "fp-collude-1", at);

    const clusters = await coReportingClusters(sql, "2026-07-12T14:59:00.000Z");
    const pair = clusters.find((c) => c.keyA === "colluder-x" && c.keyB === "colluder-y");
    expect(pair).toBeDefined();
    expect(pair!.sharedCount).toBe(3);
    expect(clusters.some((c) => c.keyA === "bystander-z" || c.keyB === "bystander-z")).toBe(false);
    for (const cluster of clusters) {
      expect(cluster.keyA < cluster.keyB).toBe(true);
    }
  }, 30_000);

  it("ignores reports older than sinceIso", async () => {
    const clusters = await coReportingClusters(sql, "2026-07-12T15:01:00.000Z");
    expect(clusters.some((c) => c.keyA === "colluder-x")).toBe(false);
  }, 30_000);

  it("is observability only: no accept/reject path imports it", () => {
    const gatedPaths = [
      "../server.ts",
      "../landing/insert.ts",
      "../subclaim/vote.ts",
      "../reputation/resolve.ts",
    ];
    for (const path of gatedPaths) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(source.includes("coreporting"), `${path} must not import coreporting`).toBe(false);
      expect(source.includes("coReportingClusters")).toBe(false);
    }
  });
});
