import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import type { FastifyInstance } from "fastify";
import { publicVerif, type Token } from "@cloudflare/privacypass-ts";
import { generateReporterKey, type ReporterKey } from "@openconditions/contrib-core";
import { runMigrations } from "@openconditions/core/server";
import { enrollReporter } from "../attester/enroll.js";
import { verifyReportingGrant } from "../attester/grant.js";
import type { DeviceProof } from "../attester/policy.js";
import { publicContextString, redemptionContext, type PublicContext } from "../issuer/context.js";
import { issueToken } from "../issuer/issue.js";
import { DEFAULT_ISSUER_NAME, generateIssuerKey, loadActiveIssuerKeys } from "../issuer/keys.js";
import { TokenVerifier } from "../issuer/verify.js";
import { build } from "../server.js";

const { BlindRSAMode, Client, Origin, TokenResponse } = publicVerif;

const NOW = "2026-07-12T08:00:00.000Z";
const GRANT_SECRET_VALUE = "attester-issuer-test-secret";
const GRANT_SECRET = new TextEncoder().encode(GRANT_SECRET_VALUE);

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

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
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

function proofFor(key: ReporterKey, overrides: Partial<DeviceProof> = {}): DeviceProof {
  return { keyId: key.keyId, ...overrides };
}

async function enroll(key: ReporterKey, now = NOW) {
  return enrollReporter(sql, key.publicJwk, proofFor(key), now, {
    grantSecret: GRANT_SECRET,
    log: noopLog,
  });
}

describe("enrollReporter", () => {
  it("inserts a new reporter with the cohort prior and a verifiable grant", async () => {
    const key = await generateReporterKey();
    const entitlement = await enroll(key);

    expect(entitlement.grantTokens).toBe(20);
    expect(entitlement.reportingGrant).not.toBe("");
    const check = await verifyReportingGrant(entitlement.reportingGrant, GRANT_SECRET, NOW);
    expect(check.valid).toBe(true);
    expect(check.keyId).toBe(key.keyId);

    const rows = await sql<
      {
        reputation_alpha: number;
        reputation_beta: number;
        status: string;
        trust_signal: number | null;
        entitlement_expires_at: Date;
      }[]
    >`SELECT reputation_alpha, reputation_beta, status, trust_signal, entitlement_expires_at
      FROM conditions.reporter WHERE key_id = ${key.keyId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reputation_alpha).toBe(2);
    expect(rows[0]!.reputation_beta).toBe(2);
    expect(rows[0]!.status).toBe("active");
    expect(rows[0]!.trust_signal).toBeCloseTo(0.3, 10);
    expect(rows[0]!.entitlement_expires_at.toISOString()).toBe("2026-07-13T08:00:00.000Z");
  }, 30_000);

  it("re-enrollment refreshes activity but NEVER resets reputation", async () => {
    const key = await generateReporterKey();
    await enroll(key);
    await sql`UPDATE conditions.reporter
      SET reputation_alpha = 5.5, reputation_beta = 3.5, corroborated_count = 4
      WHERE key_id = ${key.keyId}`;

    const later = "2026-07-12T12:00:00.000Z";
    const entitlement = await enrollReporter(
      sql,
      key.publicJwk,
      proofFor(key, { accountAgeDays: 30 }),
      later,
      { grantSecret: GRANT_SECRET, log: noopLog }
    );

    const rows = await sql<
      {
        reputation_alpha: number;
        reputation_beta: number;
        created_at: Date;
        last_active_at: Date;
        entitlement_expires_at: Date;
        trust_signal: number | null;
      }[]
    >`SELECT reputation_alpha, reputation_beta, created_at, last_active_at,
             entitlement_expires_at, trust_signal
      FROM conditions.reporter WHERE key_id = ${key.keyId}`;
    expect(rows[0]!.reputation_alpha).toBe(5.5);
    expect(rows[0]!.reputation_beta).toBe(3.5);
    expect(rows[0]!.created_at.toISOString()).toBe(NOW);
    expect(rows[0]!.last_active_at.toISOString()).toBe(later);
    expect(rows[0]!.entitlement_expires_at.toISOString()).toBe("2026-07-13T12:00:00.000Z");
    // age 30 (0.4) + corroborated history (0.1) on top of base 0.3
    expect(rows[0]!.trust_signal).toBeCloseTo(0.8, 10);
    expect(entitlement.grantTokens).toBe(20);
  }, 30_000);

  it("rejects a proof whose keyId is not the thumbprint of pubJwk", async () => {
    const key = await generateReporterKey();
    await expect(
      enrollReporter(sql, key.publicJwk, { keyId: "not-the-thumbprint" }, NOW, {
        grantSecret: GRANT_SECRET,
        log: noopLog,
      })
    ).rejects.toThrow(/keyId/);
  }, 30_000);

  it("a blocked reporter gets zero tokens and no grant", async () => {
    const key = await generateReporterKey();
    await enroll(key);
    await sql`UPDATE conditions.reporter SET status = 'blocked' WHERE key_id = ${key.keyId}`;
    const entitlement = await enroll(key);
    expect(entitlement.grantTokens).toBe(0);
    expect(entitlement.reportingGrant).toBe("");
    expect(entitlement.reason).toMatch(/blocked/i);
  }, 30_000);
});

interface MintedToken {
  token: Token;
  tokenBytes: Uint8Array;
}

/** Full client-side Privacy Pass flow against the DIRECT issueToken API. */
async function mintDirect(
  keyId: string,
  epoch: string,
  ctx: PublicContext,
  opts: { pickKeyId?: string } = {}
): Promise<MintedToken> {
  const keys = await loadActiveIssuerKeys(sql, NOW, DEFAULT_ISSUER_NAME);
  const issuerKey =
    opts.pickKeyId === undefined ? keys[0]! : keys.find((k) => k.keyId === opts.pickKeyId)!;
  const client = new Client(BlindRSAMode.PSS);
  const origin = new Origin(BlindRSAMode.PSS);
  const challenge = origin.createTokenChallenge(DEFAULT_ISSUER_NAME, await redemptionContext(ctx));
  const request = await client.createTokenRequest(challenge, issuerKey.publicKeyBytes);
  const result = await issueToken(sql, keyId, epoch, request.serialize(), ctx, {
    log: noopLog,
    now: NOW,
  });
  if (!result.issued) throw new Error(`issuance refused: ${result.reason}`);
  const token = await client.finalize(TokenResponse.deserialize(result.tokenResponse));
  return { token, tokenBytes: token.serialize() };
}

describe("issuer keys", () => {
  it("bootstraps a keypair on first use and reloads it as valid", async () => {
    const created = await generateIssuerKey(sql, NOW);
    const keys = await loadActiveIssuerKeys(sql, NOW, DEFAULT_ISSUER_NAME);
    expect(keys.length).toBeGreaterThanOrEqual(1);
    const found = keys.find((k) => k.keyId === created.keyId);
    expect(found).toBeDefined();
    expect(found!.publicKeyBytes.length).toBeGreaterThan(200);
    expect(found!.tokenKeyId.length).toBe(32);
  }, 60_000);

  it("excludes keys outside their validity window", async () => {
    const expired = await generateIssuerKey(sql, NOW, {
      notBefore: "2026-01-01T00:00:00.000Z",
      notAfter: "2026-04-01T00:00:00.000Z",
    });
    const keys = await loadActiveIssuerKeys(sql, NOW, DEFAULT_ISSUER_NAME);
    expect(keys.find((k) => k.keyId === expired.keyId)).toBeUndefined();
  }, 60_000);
});

describe("issuance + redemption round-trip (real privacypass-ts client)", () => {
  it("issues, finalizes, verifies ONCE, and refuses the replay", async () => {
    const key = await generateReporterKey();
    await enroll(key);
    const ctx: PublicContext = { purpose: "report", epoch: "2026-07-12" };
    const { tokenBytes } = await mintDirect(key.keyId, "2026-07-12", ctx);

    const verifier = new TokenVerifier({ issuerName: DEFAULT_ISSUER_NAME, log: noopLog });
    await expect(verifier.verify(sql, tokenBytes, ctx, NOW)).resolves.toBe(true);
    await expect(verifier.verify(sql, tokenBytes, ctx, NOW)).resolves.toBe(false);

    const spent = await sql<{ purpose: string }[]>`
      SELECT purpose FROM conditions.spent_token`;
    expect(spent.map((s) => s.purpose)).toContain(publicContextString(ctx));
  }, 60_000);

  it("rejects a token across contexts (redemptionContext A vs B)", async () => {
    const key = await generateReporterKey();
    await enroll(key);
    const ctxA: PublicContext = { purpose: "report", epoch: "2026-07-12" };
    const ctxB: PublicContext = { purpose: "probe", taskId: "task-abc", epoch: "2026-07-12" };
    const { tokenBytes } = await mintDirect(key.keyId, "2026-07-12", ctxA);

    const verifier = new TokenVerifier({ issuerName: DEFAULT_ISSUER_NAME, log: noopLog });
    await expect(verifier.verify(sql, tokenBytes, ctxB, NOW)).resolves.toBe(false);
  }, 60_000);

  it("rejects garbage token bytes without throwing", async () => {
    const verifier = new TokenVerifier({ issuerName: DEFAULT_ISSUER_NAME, log: noopLog });
    const garbage = globalThis.crypto.getRandomValues(new Uint8Array(64));
    await expect(
      verifier.verify(sql, garbage, { purpose: "report", epoch: "x" }, NOW)
    ).resolves.toBe(false);
  }, 30_000);

  it("refuses issuance for a reporter blocked after the grant was minted", async () => {
    const key = await generateReporterKey();
    await enroll(key);
    await sql`UPDATE conditions.reporter SET status = 'blocked' WHERE key_id = ${key.keyId}`;
    await expect(
      mintDirect(key.keyId, "2026-07-12", { purpose: "report", epoch: "2026-07-12" })
    ).rejects.toThrow(/refused/);
  }, 60_000);
});

describe("quota under concurrency", () => {
  it("25 parallel issuances against a cap of 20 yield exactly 20 tokens", async () => {
    const key = await generateReporterKey();
    await enroll(key);
    const epoch = "conc-2026-07-12";
    const ctx: PublicContext = { purpose: "report", epoch };
    const keys = await loadActiveIssuerKeys(sql, NOW, DEFAULT_ISSUER_NAME);
    const issuerKey = keys[0]!;
    const origin = new Origin(BlindRSAMode.PSS);
    const challenge = origin.createTokenChallenge(
      DEFAULT_ISSUER_NAME,
      await redemptionContext(ctx)
    );

    const requests = await Promise.all(
      Array.from({ length: 25 }, async () => {
        const client = new Client(BlindRSAMode.PSS);
        const request = await client.createTokenRequest(challenge, issuerKey.publicKeyBytes);
        return request.serialize();
      })
    );

    const results = await Promise.all(
      requests.map((bytes) =>
        issueToken(sql, key.keyId, epoch, bytes, ctx, { log: noopLog, now: NOW })
      )
    );
    const succeeded = results.filter((r) => r.issued);
    const refused = results.filter((r) => !r.issued);
    expect(succeeded).toHaveLength(20);
    expect(refused).toHaveLength(5);
    for (const r of refused) {
      expect(r.issued).toBe(false);
      expect((r as { reason: string }).reason).toBe("over-quota");
    }

    const quota = await sql<{ issued: number }[]>`
      SELECT issued FROM conditions.token_quota WHERE key_id = ${key.keyId} AND epoch = ${epoch}`;
    expect(quota[0]!.issued).toBe(20);
  }, 120_000);
});

describe("issuer key rotation", () => {
  it("a token blinded against an old-but-still-valid key verifies within the overlap", async () => {
    const old = await generateIssuerKey(sql, NOW, {
      notBefore: "2026-05-01T00:00:00.000Z",
      notAfter: "2026-08-01T00:00:00.000Z",
    });
    await generateIssuerKey(sql, NOW);

    const key = await generateReporterKey();
    await enroll(key);
    const ctx: PublicContext = { purpose: "report", taskId: "rotation", epoch: "2026-07-12" };
    const { tokenBytes } = await mintDirect(key.keyId, "2026-07-12", ctx, {
      pickKeyId: old.keyId,
    });

    const verifier = new TokenVerifier({ issuerName: DEFAULT_ISSUER_NAME, log: noopLog });
    await expect(verifier.verify(sql, tokenBytes, ctx, NOW)).resolves.toBe(true);
  }, 120_000);
});

describe("build() fail-closed", () => {
  it("throws in production when OPENCONDITIONS_GRANT_SECRET is unset", async () => {
    await expect(build({ sql, env: { NODE_ENV: "production" } })).rejects.toThrow(
      /OPENCONDITIONS_GRANT_SECRET/
    );
  }, 30_000);
});

interface CapturedLine {
  raw: string;
  parsed: Record<string, unknown>;
}

function captureLogger() {
  const lines: CapturedLine[] = [];
  return {
    lines,
    logger: {
      level: "info",
      stream: {
        write(raw: string) {
          try {
            lines.push({ raw, parsed: JSON.parse(raw) as Record<string, unknown> });
          } catch {
            lines.push({ raw, parsed: {} });
          }
        },
      },
    },
  };
}

describe("HTTP surface + end-to-end flow with log separation", () => {
  let app: FastifyInstance;
  let capture: ReturnType<typeof captureLogger>;

  beforeAll(async () => {
    capture = captureLogger();
    app = await build({
      sql,
      env: { OPENCONDITIONS_GRANT_SECRET: GRANT_SECRET_VALUE },
      logger: capture.logger,
      // Pin the clock so the SERVER-derived report epoch is a fixed UTC day.
      now: () => NOW,
    });
  }, 120_000);

  // The redemption context this route derives, server-side, for purpose "report".
  const SERVER_REPORT_CTX: PublicContext = { purpose: "report", epoch: "2026-07-12" };

  afterAll(async () => {
    await app?.close();
  });

  it("GET /contrib/issuer-keys is public and returns the active keys", async () => {
    const res = await app.inject({ method: "GET", url: "/contrib/issuer-keys" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      issuer: string;
      keys: { keyId: string; publicKey: string; notBefore: string; notAfter: string }[];
    };
    expect(body.issuer).toBe(DEFAULT_ISSUER_NAME);
    expect(body.keys.length).toBeGreaterThanOrEqual(1);
    expect(body.keys[0]!.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
  }, 30_000);

  it("POST /contrib/enroll returns 400 for a malformed body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/contrib/enroll",
      payload: { proof: { keyId: "k" } },
      remoteAddress: "203.0.113.50",
    });
    expect(res.statusCode).toBe(400);
  }, 30_000);

  it("POST /contrib/tokens with a bad grant is 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/contrib/tokens",
      payload: {
        reportingGrant: "bogus.grant",
        blindedRequest: "AAAA",
        purpose: "report",
        epoch: "2026-07-12",
      },
    });
    expect(res.statusCode).toBe(401);
  }, 30_000);

  it("rate-limits enrollment per IP at 10/min", async () => {
    const key = await generateReporterKey();
    const payload = { pubJwk: key.publicJwk, proof: proofFor(key) };
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/contrib/enroll",
        payload,
        remoteAddress: "203.0.113.9",
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  }, 60_000);

  it("enroll returns 403 for a blocked reporter", async () => {
    const key = await generateReporterKey();
    await enroll(key);
    await sql`UPDATE conditions.reporter SET status = 'blocked' WHERE key_id = ${key.keyId}`;
    const res = await app.inject({
      method: "POST",
      url: "/contrib/enroll",
      payload: { pubJwk: key.publicJwk, proof: proofFor(key) },
      remoteAddress: "203.0.113.51",
    });
    expect(res.statusCode).toBe(403);
  }, 30_000);

  it("enroll -> tokens -> verify(spend): the full flow, with issuer/origin logs clean", async () => {
    const key = await generateReporterKey();

    const enrollRes = await app.inject({
      method: "POST",
      url: "/contrib/enroll",
      payload: {
        pubJwk: key.publicJwk,
        proof: proofFor(key, { accountAgeDays: 30 }),
      },
    });
    expect(enrollRes.statusCode).toBe(200);
    const entitlement = enrollRes.json() as { reportingGrant: string; grantTokens: number };
    expect(entitlement.grantTokens).toBe(20);

    const keysRes = await app.inject({ method: "GET", url: "/contrib/issuer-keys" });
    const { keys } = keysRes.json() as { keys: { keyId: string; publicKey: string }[] };
    const publicKeyBytes = new Uint8Array(Buffer.from(keys[0]!.publicKey, "base64url"));

    const ctx = SERVER_REPORT_CTX;
    const client = new Client(BlindRSAMode.PSS);
    const origin = new Origin(BlindRSAMode.PSS);
    const challenge = origin.createTokenChallenge(
      DEFAULT_ISSUER_NAME,
      await redemptionContext(ctx)
    );
    const request = await client.createTokenRequest(challenge, publicKeyBytes);

    const tokensRes = await app.inject({
      method: "POST",
      url: "/contrib/tokens",
      payload: {
        reportingGrant: entitlement.reportingGrant,
        blindedRequest: Buffer.from(request.serialize()).toString("base64url"),
      },
    });
    expect(tokensRes.statusCode).toBe(200);
    const { token: tokenResponseB64 } = tokensRes.json() as { token: string };
    const token = await client.finalize(
      TokenResponse.deserialize(new Uint8Array(Buffer.from(tokenResponseB64, "base64url")))
    );

    const verified = await app.tokenVerifier.verify(sql, token.serialize(), ctx, NOW);
    expect(verified).toBe(true);
    const replay = await app.tokenVerifier.verify(sql, token.serialize(), ctx, NOW);
    expect(replay).toBe(false);

    // Log separation: the issuer and origin loggers must never see the
    // enrolled keyId, proof fields, or the tokens-route request id.
    const tokensReqIds = capture.lines
      .filter((l) => {
        const req = l.parsed["req"] as { url?: string } | undefined;
        return req?.url === "/contrib/tokens";
      })
      .map((l) => String(l.parsed["reqId"]));
    expect(tokensReqIds.length).toBeGreaterThan(0);

    const issuerOrigin = capture.lines.filter(
      (l) => l.parsed["component"] === "issuer" || l.parsed["component"] === "origin"
    );
    expect(issuerOrigin.some((l) => l.parsed["component"] === "issuer")).toBe(true);
    expect(issuerOrigin.some((l) => l.parsed["component"] === "origin")).toBe(true);
    for (const line of issuerOrigin) {
      expect(line.raw).not.toContain(key.keyId);
      expect(line.raw).not.toContain("accountAgeDays");
      for (const reqId of tokensReqIds) {
        expect(line.raw).not.toContain(`"reqId":"${reqId}"`);
        expect(line.raw).not.toContain(`"reqId":${JSON.stringify(reqId)}`);
      }
    }

    // The origin side logs only purpose + outcome, never the token bytes.
    const originLines = issuerOrigin.filter((l) => l.parsed["component"] === "origin");
    for (const line of originLines) {
      expect(line.raw).not.toContain(Buffer.from(token.serialize()).toString("base64url"));
    }
  }, 120_000);

  async function grantFor(remoteAddress: string): Promise<string> {
    const key = await generateReporterKey();
    const res = await app.inject({
      method: "POST",
      url: "/contrib/enroll",
      payload: { pubJwk: key.publicJwk, proof: proofFor(key) },
      remoteAddress,
    });
    return (res.json() as { reportingGrant: string }).reportingGrant;
  }

  async function tokenRequestBody(): Promise<string> {
    const keysRes = await app.inject({ method: "GET", url: "/contrib/issuer-keys" });
    const { keys } = keysRes.json() as { keys: { publicKey: string }[] };
    const client = new Client(BlindRSAMode.PSS);
    const origin = new Origin(BlindRSAMode.PSS);
    const challenge = origin.createTokenChallenge(
      DEFAULT_ISSUER_NAME,
      await redemptionContext(SERVER_REPORT_CTX)
    );
    const request = await client.createTokenRequest(
      challenge,
      new Uint8Array(Buffer.from(keys[0]!.publicKey, "base64url"))
    );
    return Buffer.from(request.serialize()).toString("base64url");
  }

  it("over-quota issuance is 429 (quota keyed on the server-derived epoch)", async () => {
    const key = await generateReporterKey();
    const enrollRes = await app.inject({
      method: "POST",
      url: "/contrib/enroll",
      payload: { pubJwk: key.publicJwk, proof: proofFor(key) },
      remoteAddress: "203.0.113.20",
    });
    const { reportingGrant } = enrollRes.json() as { reportingGrant: string };

    // Seed the SERVER day epoch at cap — a client-chosen epoch cannot dodge it.
    await sql`INSERT INTO conditions.token_quota (key_id, epoch, issued)
      VALUES (${key.keyId}, '2026-07-12', 20)`;

    const res = await app.inject({
      method: "POST",
      url: "/contrib/tokens",
      payload: {
        reportingGrant,
        blindedRequest: await tokenRequestBody(),
        epoch: "2099-01-01",
      },
    });
    expect(res.statusCode).toBe(429);
  }, 60_000);

  it("two token requests from one grant in the same UTC day share ONE quota row", async () => {
    const key = await generateReporterKey();
    const enrollRes = await app.inject({
      method: "POST",
      url: "/contrib/enroll",
      payload: { pubJwk: key.publicJwk, proof: proofFor(key) },
      remoteAddress: "203.0.113.21",
    });
    const { reportingGrant } = enrollRes.json() as { reportingGrant: string };

    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/contrib/tokens",
        payload: { reportingGrant, blindedRequest: await tokenRequestBody() },
      });
      expect(res.statusCode).toBe(200);
    }

    const rows = await sql<{ epoch: string; issued: number }[]>`
      SELECT epoch, issued FROM conditions.token_quota WHERE key_id = ${key.keyId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.epoch).toBe("2026-07-12");
    expect(rows[0]!.issued).toBe(2);
  }, 60_000);

  it("ignores a client-supplied epoch and taskId; the token verifies under the server context", async () => {
    const reportingGrant = await grantFor("203.0.113.22");
    const keysRes = await app.inject({ method: "GET", url: "/contrib/issuer-keys" });
    const { keys } = keysRes.json() as { keys: { publicKey: string }[] };
    const client = new Client(BlindRSAMode.PSS);
    const origin = new Origin(BlindRSAMode.PSS);
    // Client blinds against the SERVER context, but the body lies about epoch/taskId.
    const challenge = origin.createTokenChallenge(
      DEFAULT_ISSUER_NAME,
      await redemptionContext(SERVER_REPORT_CTX)
    );
    const request = await client.createTokenRequest(
      challenge,
      new Uint8Array(Buffer.from(keys[0]!.publicKey, "base64url"))
    );

    const res = await app.inject({
      method: "POST",
      url: "/contrib/tokens",
      payload: {
        reportingGrant,
        blindedRequest: Buffer.from(request.serialize()).toString("base64url"),
        epoch: "2099-01-01",
        taskId: "x",
      },
    });
    expect(res.statusCode).toBe(200);
    const token = await client.finalize(
      TokenResponse.deserialize(
        new Uint8Array(Buffer.from((res.json() as { token: string }).token, "base64url"))
      )
    );
    // Quota never landed on the client's 2099 epoch — the server day owns it.
    const rows = await sql<{ epoch: string }[]>`
      SELECT epoch FROM conditions.token_quota WHERE epoch = '2099-01-01'`;
    expect(rows).toHaveLength(0);
    // And the token verifies under the server-derived context.
    await expect(
      app.tokenVerifier.verify(sql, token.serialize(), SERVER_REPORT_CTX, NOW)
    ).resolves.toBe(true);
  }, 60_000);

  it("rejects a non-report purpose with 400 (only 'report' is served here)", async () => {
    const reportingGrant = await grantFor("203.0.113.23");
    const res = await app.inject({
      method: "POST",
      url: "/contrib/tokens",
      payload: {
        reportingGrant,
        blindedRequest: "AAAA",
        purpose: "probe",
      },
    });
    expect(res.statusCode).toBe(400);
  }, 30_000);
});
