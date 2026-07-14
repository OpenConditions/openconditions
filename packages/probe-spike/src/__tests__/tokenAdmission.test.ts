import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { publicVerif } from "@cloudflare/privacypass-ts";
import { generateReporterKey, type ReporterKey } from "@openconditions/contrib-core";
import { runMigrations } from "@openconditions/core/server";
import {
  DEFAULT_ISSUER_NAME,
  enrollReporter,
  generateIssuerKey,
  issueToken,
  loadActiveIssuerKeys,
  publicContextString,
  redemptionContext,
  TokenVerifier,
  type PublicContext,
} from "@openconditions/contributions-api/contrib";
import {
  acceptProbeReport,
  encodePrivateSegment,
  ensureBatchSchema,
  PROBE_TOKENS_PER_EPOCH,
  type ContributionContext,
  type RegionSpec,
  type TokenRedeemer,
} from "../index.js";

const { BlindRSAMode, Client, Origin, TokenResponse } = publicVerif;

const NOW = "2026-07-14T08:00:00.000Z";
const GRANT_SECRET = new TextEncoder().encode("probe-spike-token-test-secret");
const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

const REGION: RegionSpec = {
  regionId: "region-nl-utrecht-coarse",
  window: "2026-07-14T08:00Z/1h",
  segmentCount: 16,
  speedBucketCount: 8,
};

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;
let verifier: TokenVerifier;
let redeem: TokenRedeemer;

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
  await ensureBatchSchema(sql);
  await generateIssuerKey(sql, NOW);
  verifier = new TokenVerifier({ issuerName: DEFAULT_ISSUER_NAME, log: noopLog });
  redeem = (tokenBytes, context, nowIso) => verifier.verify(sql, tokenBytes, context, nowIso);
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

async function enroll(): Promise<ReporterKey> {
  const key = await generateReporterKey();
  await enrollReporter(sql, key.publicJwk, { keyId: key.keyId }, NOW, {
    grantSecret: GRANT_SECRET,
    log: noopLog,
  });
  return key;
}

/** Full client-side Privacy Pass mint against the real issuer, bound to `ctx`. */
async function mint(keyId: string, ctx: PublicContext, cap: number): Promise<Uint8Array> {
  const keys = await loadActiveIssuerKeys(sql, NOW, DEFAULT_ISSUER_NAME);
  const issuerKey = keys[0]!;
  const client = new Client(BlindRSAMode.PSS);
  const origin = new Origin(BlindRSAMode.PSS);
  const challenge = origin.createTokenChallenge(DEFAULT_ISSUER_NAME, await redemptionContext(ctx));
  const request = await client.createTokenRequest(challenge, issuerKey.publicKeyBytes);
  const result = await issueToken(sql, keyId, ctx.epoch, request.serialize(), ctx, {
    log: noopLog,
    now: NOW,
    cap,
  });
  if (!result.issued) throw new Error(`issuance refused: ${result.reason}`);
  const token = await client.finalize(TokenResponse.deserialize(result.tokenResponse));
  return token.serialize();
}

describe("invariant 2: one admitted key/epoch -> at most one accepted contribution", () => {
  it("per-epoch quota of one admits exactly one token; a second in the same epoch is refused", async () => {
    const key = await enroll();
    const ctx: PublicContext = { purpose: "probe", taskId: "task-q1", epoch: "2026-07-14" };
    await expect(mint(key.keyId, ctx, PROBE_TOKENS_PER_EPOCH)).resolves.toBeInstanceOf(Uint8Array);
    await expect(mint(key.keyId, ctx, PROBE_TOKENS_PER_EPOCH)).rejects.toThrow(/over-quota/);
  }, 60_000);

  it("a redeemed token cannot be redeemed again (single-use spent_token)", async () => {
    const key = await enroll();
    const ctx: PublicContext = { purpose: "probe", taskId: "task-q2", epoch: "2026-07-14" };
    const token = await mint(key.keyId, ctx, PROBE_TOKENS_PER_EPOCH);
    await expect(verifier.verify(sql, token, ctx, NOW)).resolves.toBe(true);
    await expect(verifier.verify(sql, token, ctx, NOW)).resolves.toBe(false);
  }, 60_000);

  it("a token minted for task/epoch X cannot redeem against Y (context binding)", async () => {
    const key = await enroll();
    const ctxX: PublicContext = { purpose: "probe", taskId: "task-X", epoch: "2026-07-14" };
    const ctxY: PublicContext = { purpose: "probe", taskId: "task-Y", epoch: "2026-07-14" };
    const token = await mint(key.keyId, ctxX, PROBE_TOKENS_PER_EPOCH);
    await expect(verifier.verify(sql, token, ctxY, NOW)).resolves.toBe(false);
  }, 60_000);

  it("ties one admitted token to exactly one accepted report; the exhausted quota blocks a second", async () => {
    const key = await enroll();
    const ctx: ContributionContext = { purpose: "probe", taskId: "task-tie", epoch: "2026-07-14" };
    const token = await mint(key.keyId, ctx as PublicContext, PROBE_TOKENS_PER_EPOCH);
    const report = await encodePrivateSegment(REGION, { segmentIndex: 4, clampedSpeed: 80 });

    const accepted = await acceptProbeReport(sql, redeem, {
      tokenBytes: token,
      context: ctx,
      reportId: report.nonce,
      nowIso: NOW,
    });
    expect(accepted.accepted).toBe(true);

    // The key's epoch quota is spent: it cannot mint a second admission token.
    await expect(mint(key.keyId, ctx as PublicContext, PROBE_TOKENS_PER_EPOCH)).rejects.toThrow(
      /over-quota/
    );
  }, 60_000);
});

describe("invariant 3: replay cannot enter two batches", () => {
  it("a replayed token (same token + report) is refused on the second submission", async () => {
    const key = await enroll();
    const ctx: ContributionContext = {
      purpose: "probe",
      taskId: "task-replay-tok",
      epoch: "2026-07-14",
    };
    const token = await mint(key.keyId, ctx as PublicContext, PROBE_TOKENS_PER_EPOCH);
    const report = await encodePrivateSegment(REGION, { segmentIndex: 2, clampedSpeed: 55 });
    const submission = { tokenBytes: token, context: ctx, reportId: report.nonce, nowIso: NOW };

    const first = await acceptProbeReport(sql, redeem, submission);
    expect(first.accepted).toBe(true);
    const replay = await acceptProbeReport(sql, redeem, submission);
    expect(replay).toEqual({ accepted: false, reason: "token-refused" });
  }, 60_000);

  it("a replayed report id under a FRESH token cannot enter the batch twice", async () => {
    const key = await enroll();
    const ctx: ContributionContext = {
      purpose: "probe",
      taskId: "task-replay-rid",
      epoch: "2026-07-14",
    };
    // Deliberately ABOVE PROBE_TOKENS_PER_EPOCH: model an attacker who somehow
    // holds two distinct valid tokens for the same key/epoch (e.g. a misconfigured
    // cap), to prove the report-id dedup blocks a double-batch even then.
    const tokenA = await mint(key.keyId, ctx as PublicContext, 2);
    const tokenB = await mint(key.keyId, ctx as PublicContext, 2);
    expect(Buffer.from(tokenA)).not.toEqual(Buffer.from(tokenB));

    const report = await encodePrivateSegment(REGION, { segmentIndex: 6, clampedSpeed: 120 });

    const first = await acceptProbeReport(sql, redeem, {
      tokenBytes: tokenA,
      context: ctx,
      reportId: report.nonce,
      nowIso: NOW,
    });
    expect(first.accepted).toBe(true);

    // Same report id, different valid token -> refused as a batch replay.
    const second = await acceptProbeReport(sql, redeem, {
      tokenBytes: tokenB,
      context: ctx,
      reportId: report.nonce,
      nowIso: NOW,
    });
    expect(second).toEqual({ accepted: false, reason: "report-replayed" });

    // The report id landed in the batch exactly once.
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM probe_spike.batch_report
      WHERE batch = ${publicContextString(ctx as PublicContext)}
        AND report_id = ${Buffer.from(report.nonce).toString("hex")}`;
    expect(rows[0]!.n).toBe(1);
  }, 60_000);
});
