/**
 * Fastify app for the contributions service — the HTTP face of the attester
 * (enrollment) and the Privacy Pass issuer. Exported as build() so tests can
 * fastify.inject; only main.ts listens.
 *
 * Log separation (binding): the attester, issuer, and origin flows each get
 * their OWN child logger with a fixed `component` binding created once at
 * build time — never from req.log. The issuer and origin loggers therefore
 * never carry the reporter keyId, proof fields, or any request id; the
 * enrolled key and a token issuance/redemption stay unlinkable in the logs.
 */
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type postgres from "postgres";
import { enrollReporter } from "./attester/enroll.js";
import { resolveGrantSecret, verifyReportingGrant } from "./attester/grant.js";
import { ATTESTER_POLICY, type DeviceProof } from "./attester/policy.js";
import { reportEpoch, type PublicContext } from "./issuer/context.js";
import { issueToken } from "./issuer/issue.js";
import { DEFAULT_ISSUER_NAME, ensureIssuerKeys, loadActiveIssuerKeys } from "./issuer/keys.js";
import { TokenVerifier } from "./issuer/verify.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Origin-side verifier sharing this app's log stream (component=origin). */
    tokenVerifier: TokenVerifier;
  }
}

export interface BuildOptions {
  sql: postgres.Sql;
  env?: Record<string, string | undefined>;
  logger?: FastifyServerOptions["logger"];
  /** Injectable clock (ISO 8601); defaults to the real clock. */
  now?: () => string;
}

interface EnrollBody {
  pubJwk?: JsonWebKey;
  proof?: DeviceProof;
}

interface TokensBody {
  reportingGrant?: string;
  blindedRequest?: string;
  /** Only "report" is served here; any other value is rejected. */
  purpose?: string;
  /** Accepted on the wire but IGNORED — the context is server-authoritative. */
  taskId?: string;
  epoch?: string;
}

/** Minimal per-IP token bucket for the enrollment endpoint. */
class EnrollLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefill: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {}

  allow(ip: string, nowMs: number): boolean {
    if (this.buckets.size > 10_000) {
      for (const [key, stale] of this.buckets) {
        if (nowMs - stale.lastRefill > this.windowMs * 2) this.buckets.delete(key);
      }
    }
    let bucket = this.buckets.get(ip);
    if (bucket === undefined) {
      bucket = { tokens: this.max, lastRefill: nowMs };
      this.buckets.set(ip, bucket);
    }
    const elapsed = nowMs - bucket.lastRefill;
    bucket.tokens = Math.min(this.max, bucket.tokens + (elapsed / this.windowMs) * this.max);
    bucket.lastRefill = nowMs;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

export async function build(options: BuildOptions): Promise<FastifyInstance> {
  const { sql } = options;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date().toISOString());
  const issuerName = env["OPENCONDITIONS_ISSUER_NAME"] || DEFAULT_ISSUER_NAME;

  const app = Fastify({ logger: options.logger ?? true });

  const attesterLog = app.log.child({ component: "attester" });
  const issuerLog = app.log.child({ component: "issuer" });
  const originLog = app.log.child({ component: "origin" });

  // Fail closed: in production a missing grant secret must abort the boot.
  const grantSecret = resolveGrantSecret(env, (msg) => attesterLog.warn(msg));

  await ensureIssuerKeys(sql, now(), issuerName);

  const verifier = new TokenVerifier({ issuerName, log: originLog });
  app.decorate("tokenVerifier", verifier);

  const enrollLimiter = new EnrollLimiter(ATTESTER_POLICY.enrollRateLimitPerMinute, 60_000);

  app.get("/status", async (_req, reply) => {
    return reply.send({ status: "ok", service: "openconditions-contributions-api" });
  });

  app.post<{ Body: EnrollBody }>("/contrib/enroll", async (req, reply) => {
    if (!enrollLimiter.allow(req.ip, Date.now())) {
      return reply.status(429).send({ error: "Too many enrollment attempts" });
    }
    const { pubJwk, proof } = req.body ?? {};
    if (
      pubJwk === null ||
      typeof pubJwk !== "object" ||
      proof === null ||
      typeof proof !== "object" ||
      typeof proof?.keyId !== "string"
    ) {
      return reply.status(400).send({ error: "pubJwk and proof.keyId are required" });
    }
    let entitlement;
    try {
      entitlement = await enrollReporter(sql, pubJwk, proof, now(), {
        grantSecret,
        log: attesterLog,
      });
    } catch (err) {
      if (err instanceof TypeError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }
    if (entitlement.grantTokens === 0) {
      return reply.status(403).send({ error: entitlement.reason });
    }
    return reply.send(entitlement);
  });

  app.post<{ Body: TokensBody }>("/contrib/tokens", async (req, reply) => {
    const body = req.body ?? {};
    if (typeof body.reportingGrant !== "string" || typeof body.blindedRequest !== "string") {
      return reply.status(400).send({ error: "reportingGrant and blindedRequest are required" });
    }
    const nowIso = now();
    const grant = await verifyReportingGrant(body.reportingGrant, grantSecret, nowIso);
    if (!grant.valid || grant.keyId === undefined) {
      return reply.status(401).send({ error: `invalid reporting grant (${grant.reason})` });
    }
    // The reporter key comes FROM THE GRANT, never from a client field.
    const keyId = grant.keyId;

    // The redemption context is SERVER-AUTHORITATIVE. The per-key Sybil ceiling
    // is only real if the quota epoch is not client-chosen: honoring a client
    // epoch would let one grant mint `cap` tokens per DISTINCT epoch string, i.e.
    // unbounded by enumeration. v1 serves only the "report" purpose, whose
    // context is derived entirely here — epoch = server UTC day, taskId fixed to
    // "-". Any client purpose/taskId/epoch is IGNORED. Other purposes (probe/…)
    // get their own authorized routes in the probe plan, which MUST likewise pin
    // their epoch/context server-side at redeem time, or the ceiling is defeated.
    if (body.purpose !== undefined && body.purpose !== "report") {
      return reply.status(400).send({ error: "unsupported purpose; only 'report' is served here" });
    }
    const purpose = "report";
    const epoch = reportEpoch(nowIso);
    const publicContext: PublicContext = { purpose, epoch };

    let blindedRequestBytes: Uint8Array;
    try {
      blindedRequestBytes = new Uint8Array(Buffer.from(body.blindedRequest, "base64url"));
    } catch {
      return reply.status(400).send({ error: "blindedRequest must be base64url" });
    }

    const result = await issueToken(sql, keyId, epoch, blindedRequestBytes, publicContext, {
      log: issuerLog,
      issuerName,
      now: nowIso,
    });
    if (!result.issued) {
      if (result.reason === "over-quota") {
        return reply.status(429).send({ error: "token quota exhausted for this epoch" });
      }
      if (result.reason === "bad-request") {
        return reply.status(400).send({ error: "invalid blinded token request" });
      }
      return reply.status(403).send({ error: "token issuance refused" });
    }
    return reply.send({ token: Buffer.from(result.tokenResponse).toString("base64url") });
  });

  app.get("/contrib/issuer-keys", async (_req, reply) => {
    const keys = await loadActiveIssuerKeys(sql, now(), issuerName);
    return reply.send({
      issuer: issuerName,
      keys: keys.map((k) => ({
        keyId: k.keyId,
        publicKey: Buffer.from(k.publicKeyBytes).toString("base64url"),
        notBefore: k.notBefore.toISOString(),
        notAfter: k.notAfter.toISOString(),
      })),
    });
  });

  return app;
}
