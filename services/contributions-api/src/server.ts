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
import { centroid, reliabilityLowerBound } from "@openconditions/core";
import {
  checkGeometryPlausibility,
  checkPlausibility,
  verifyReport,
  verifySubClaim,
  type LandingContext,
  type SignedReport,
  type SignedSubClaim,
} from "@openconditions/contrib-core";
import { resolveInstanceId } from "@openconditions/normalize";
import { checkReportRate } from "./abuse/rate.js";
import { enrollReporter } from "./attester/enroll.js";
import { resolveGrantSecret, verifyReportingGrant } from "./attester/grant.js";
import { ATTESTER_POLICY, type DeviceProof } from "./attester/policy.js";
import { isPoliceCategory, isPoliceCategoryEnabled } from "./policy/police.js";
import { reportEpoch, type PublicContext } from "./issuer/context.js";
import { issueToken } from "./issuer/issue.js";
import { DEFAULT_ISSUER_NAME, ensureIssuerKeys, loadActiveIssuerKeys } from "./issuer/keys.js";
import { TokenVerifier } from "./issuer/verify.js";
import { autoCorroborateOnLanding } from "./evidence/autoCorroborate.js";
import { crossValidateAgainstFeeds } from "./evidence/crossValidate.js";
import { GeometryInvalidError, landReport } from "./landing/insert.js";
import { makeRequireReviewer, resolveReviewerToken } from "./reviewer/auth.js";
import { blockKey, listBlocked, unblockKey } from "./reviewer/blocklist.js";
import { acceptObservation, rejectObservation } from "./reviewer/decide.js";
import { listFlagged } from "./reviewer/queue.js";
import { flagOntoOpenFlagged } from "./reviewer/streetcomplete.js";
import { castSubClaimVote } from "./subclaim/vote.js";

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
  /**
   * Override the post-hoc StreetComplete flag check (a landing seam). Defaults to
   * the real {@link flagOntoOpenFlagged}; injected in tests to prove that a
   * failure in this best-effort hook can never fail an already-committed landing.
   */
  streetCompleteCheck?: (sql: postgres.Sql, observationId: string, now: string) => Promise<boolean>;
  /**
   * Override the post-hoc auto-corroboration hook (a landing seam). Defaults to
   * the real {@link autoCorroborateOnLanding}; injected in tests to prove that a
   * matcher failure in this best-effort hook can never fail an already-committed
   * landing.
   */
  autoCorroborate?: (sql: postgres.Sql, observationId: string, now: string) => Promise<string[]>;
  /**
   * Override the post-hoc official-feed cross-validation hook (a landing seam).
   * Defaults to the real {@link crossValidateAgainstFeeds}; injected in tests to
   * prove that a failure in this best-effort routing hook can never fail an
   * already-committed landing.
   */
  crossValidateAgainstFeeds?: (
    sql: postgres.Sql,
    observationId: string,
    now: string
  ) => Promise<string | null>;
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

interface ReportsBody {
  report?: SignedReport;
  reportingGrant?: string;
}

interface SubClaimBody {
  subClaim?: SignedSubClaim;
  reportingGrant?: string;
}

const SUB_CLAIM_ACTIONS = new Set(["confirm", "negate", "flag"]);

/** Fixed credible level for the advisory own-reputation lower bound. */
const ADVISORY_CREDIBLE_LEVEL = 0.9;

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
  const streetCompleteCheck = options.streetCompleteCheck ?? flagOntoOpenFlagged;
  const autoCorroborate = options.autoCorroborate ?? autoCorroborateOnLanding;
  const crossValidate = options.crossValidateAgainstFeeds ?? crossValidateAgainstFeeds;
  const issuerName = env["OPENCONDITIONS_ISSUER_NAME"] || DEFAULT_ISSUER_NAME;

  const app = Fastify({ logger: options.logger ?? true });

  const attesterLog = app.log.child({ component: "attester" });
  const issuerLog = app.log.child({ component: "issuer" });
  const originLog = app.log.child({ component: "origin" });

  // Fail closed: in production a missing grant secret must abort the boot.
  const grantSecret = resolveGrantSecret(env, (msg) => attesterLog.warn(msg));

  // The reviewer surface is operator-authenticated; its token fails closed in
  // production exactly like the grant secret.
  const reviewerToken = resolveReviewerToken(env, (msg) => attesterLog.warn(msg));
  const requireReviewer = makeRequireReviewer(reviewerToken);

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

    // A blocked (or vanished) reporter must not mint tokens, even if it still
    // holds an unexpired grant issued before the block. The report/vote paths
    // re-check reporter status too; this closes the token path for symmetry.
    const tokenReporterRows = await sql<{ status: string }[]>`
      SELECT status FROM conditions.reporter WHERE key_id = ${keyId}
    `;
    if (tokenReporterRows[0] === undefined || tokenReporterRows[0].status !== "active") {
      return reply.status(403).send({ error: "reporter is not enrolled or is blocked" });
    }

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

  const crowdSourceUri =
    env["OPENCONDITIONS_CROWD_SOURCE_URI"] || `urn:openconditions:crowd:${resolveInstanceId(env)}`;
  const crowdSourceLicense = env["OPENCONDITIONS_CROWD_LICENSE"] || "ODbL-1.0";

  // Per-instance police-category toggle, resolved once at boot (DEFAULT OFF).
  const policeCategoryEnabled = isPoliceCategoryEnabled(env);

  app.post<{ Body: ReportsBody }>("/contrib/reports", async (req, reply) => {
    const body = req.body ?? {};
    const { report, reportingGrant } = body;
    if (report === null || typeof report !== "object" || typeof reportingGrant !== "string") {
      return reply.status(400).send({ error: "report and reportingGrant are required" });
    }
    if (typeof report.keyId !== "string" || report.keyId.length === 0) {
      return reply.status(400).send({ error: "report.keyId is required" });
    }
    const nowIso = now();

    // 1. The grant binds the key. It must be valid, unexpired, and issued FOR
    // this exact key — the report is separately key-signed, so both must agree.
    const grant = await verifyReportingGrant(reportingGrant, grantSecret, nowIso, report.keyId);
    if (!grant.valid || grant.keyId !== report.keyId) {
      return reply.status(401).send({ error: `invalid reporting grant (${grant.reason})` });
    }

    // The reporter row (fetched now so verification can use the cached JWK, but
    // the enrollment verdict is withheld until AFTER the signature check so an
    // unauthenticated caller can never probe whether a key is enrolled).
    const reporterRows = await sql<{ status: string; pub_jwk: JsonWebKey }[]>`
      SELECT status, pub_jwk FROM conditions.reporter WHERE key_id = ${report.keyId}
    `;
    const reporter = reporterRows[0];

    // 2. The signature must verify and the envelope keyId must equal its RFC
    // 7638 thumbprint (contrib-core enforces). The cached JWK is preferred when
    // the key is known; otherwise the embedded pubJwk (bound by the thumbprint)
    // is used.
    const verified = await verifyReport(report, reporter?.pub_jwk);
    if (!verified.ok || verified.keyId !== report.keyId) {
      return reply
        .status(400)
        .send({ error: `report verification failed (${verified.error ?? "keyId mismatch"})` });
    }

    // 3. The reporter row MUST already exist and be active — enrollment is the
    // only gate that creates a reporter; a report from an unknown/blocked key is
    // refused and NEVER auto-creates a reporter row.
    if (reporter === undefined || reporter.status !== "active") {
      return reply.status(403).send({ error: "reporter is not enrolled or is blocked" });
    }

    // 4. Deterministic plausibility: coordinates finite + in WGS84 range, a
    // sane reportedAt window, a well-formed nonce.
    const plausibility = checkPlausibility(report.claim, nowIso);
    if (!plausibility.ok) {
      return reply.status(422).send({ error: "implausible report", reasons: plausibility.reasons });
    }

    // 4b. Per-instance police-category gate (DEFAULT OFF). Only a NEW report
    // landing in the sensitive police-presence category is gated; a vote on an
    // existing observation is never re-gated (it already passed the gate when it
    // landed). "authority"/"security"/"speed_restriction" are legitimate
    // categories and are NOT gated — see policy/police.ts.
    if (isPoliceCategory(report.claim.type) && !policeCategoryEnabled) {
      return reply.status(422).send({
        error: "police category is disabled on this instance",
        reason: "police_category_disabled",
      });
    }

    // Per-key + per-(key, ~1km cell) insert-rate guard. The geometry passed
    // plausibility above, so its centroid is well-defined.
    const [lon, lat] = centroid(report.claim.geometry);
    const rate = await checkReportRate(sql, report.keyId, lon, lat, nowIso);
    if (!rate.ok) {
      return reply.status(429).send({ error: "too many reports; slow down", reason: rate.reason });
    }

    // 5. Map → central normalize seam → crowd insert + initial evidence +
    // recompute, all in one transaction.
    const landingCtx: LandingContext = {
      instanceId: resolveInstanceId(env),
      now: nowIso,
      sourceUri: crowdSourceUri,
      sourceLicense: crowdSourceLicense,
    };
    let result;
    try {
      result = await landReport(sql, report, landingCtx);
    } catch (err) {
      if (err instanceof GeometryInvalidError) {
        return reply
          .status(422)
          .send({ error: "implausible report", reasons: ["geometry_invalid"] });
      }
      throw err;
    }
    if (result.kinematicFlagged) {
      // Post-hoc anomaly signal only: the report landed anyway (a truthful
      // fast mover must not be censored) and the flag is not evidence.
      req.log.warn(
        { observationId: result.observationId },
        "kinematically implausible reporter transition; new observation flagged"
      );
    }
    // StreetComplete rule: a fresh landing onto an already-disputed element is
    // flagged for review. Post-hoc — the report has already landed and its row
    // is committed. This best-effort hook must NEVER fail the landing: any error
    // is logged and swallowed so the client still gets its 200.
    if (result.inserted) {
      try {
        const pileOn = await streetCompleteCheck(sql, result.observationId, nowIso);
        if (pileOn) {
          req.log.warn(
            { observationId: result.observationId },
            "new report landed onto an open-flagged phenomenon; new observation flagged"
          );
        }
      } catch (err) {
        req.log.warn(
          { err, observationId: result.observationId },
          "StreetComplete flag check failed; landing is unaffected"
        );
      }

      // Evidence-ladder step 2: auto-corroborate the fresh landing against any
      // INDEPENDENT report of the same phenomenon already nearby. Post-hoc and
      // best-effort like the StreetComplete hook — the report has landed 200 and
      // a matcher error must NEVER fail it. Corroboration merges the later report
      // onto the earlier survivor; it never routes and never trains reputation.
      try {
        const corroborated = await autoCorroborate(sql, result.observationId, nowIso);
        if (corroborated.length > 0) {
          req.log.info(
            { observationId: result.observationId, corroborated },
            "landing auto-corroborated an independent report of the same phenomenon"
          );
        }
      } catch (err) {
        req.log.warn(
          { err, observationId: result.observationId },
          "auto-corroboration failed; landing is unaffected"
        );
      }

      // ADR §4 official cross-validation: if the fresh crowd landing phenomenon-
      // matches an authoritative FEED observation of the same event, route it via
      // external resolution (which flips routing_eligible AND trains the
      // reporter). Post-hoc and best-effort like the hooks above — the report has
      // landed 200 and a matcher error must NEVER fail it. Crowd↔crowd agreement
      // is handled by autoCorroborate above and never routes; only a FEED match
      // routes here.
      try {
        const matchedFeedId = await crossValidate(sql, result.observationId, nowIso);
        if (matchedFeedId !== null) {
          req.log.info(
            { observationId: result.observationId, matchedFeedId },
            "landing cross-validated against an official feed; routed via external resolution"
          );
        }
      } catch (err) {
        req.log.warn(
          { err, observationId: result.observationId },
          "official-feed cross-validation failed; landing is unaffected"
        );
      }
    }
    return reply.status(200).send({
      observationId: result.observationId,
      evidenceState: result.evidenceState,
      routingEligible: result.routingEligible,
    });
  });

  // A signed vote (confirm/negate/flag) ON an existing observation. It appends
  // evidence and recomputes state, honoring the binding trust rules: two
  // distinct keys corroborate but NEVER route; a self-vote never corroborates;
  // the same key never double-counts. The corroboration/negation/retraction
  // math lives in core's evaluateEvidence — this route only appends the right
  // report_evidence row and recomputes (or, for a flag, sets flagged_at).
  app.post<{ Params: { id: string; action: string }; Body: SubClaimBody }>(
    "/contrib/reports/:id/:action",
    async (req, reply) => {
      const { id, action } = req.params;
      // 1. The action must name a real vote kind, else the route does not exist.
      if (!SUB_CLAIM_ACTIONS.has(action)) {
        return reply.status(404).send({ error: "unknown sub-claim action" });
      }

      const body = req.body ?? {};
      const { subClaim, reportingGrant } = body;
      if (subClaim === null || typeof subClaim !== "object" || typeof reportingGrant !== "string") {
        return reply.status(400).send({ error: "subClaim and reportingGrant are required" });
      }
      if (typeof subClaim.keyId !== "string" || subClaim.keyId.length === 0) {
        return reply.status(400).send({ error: "subClaim.keyId is required" });
      }
      const nowIso = now();

      // 2. The grant binds the key: valid, unexpired, issued FOR this exact key.
      const grant = await verifyReportingGrant(reportingGrant, grantSecret, nowIso, subClaim.keyId);
      if (!grant.valid || grant.keyId !== subClaim.keyId) {
        return reply.status(401).send({ error: `invalid reporting grant (${grant.reason})` });
      }

      // The reporter row is fetched now for its cached JWK, but the enrollment
      // verdict is withheld until AFTER the signature check so an unauthenticated
      // caller can never probe whether a key is enrolled.
      const reporterRows = await sql<{ status: string; pub_jwk: JsonWebKey }[]>`
        SELECT status, pub_jwk FROM conditions.reporter WHERE key_id = ${subClaim.keyId}
      `;
      const reporter = reporterRows[0];

      // 3. The signature must verify and the envelope keyId must equal its RFC
      // 7638 thumbprint (contrib-core enforces).
      const verified = await verifySubClaim(subClaim, reporter?.pub_jwk);
      if (!verified.ok || verified.keyId !== subClaim.keyId) {
        return reply
          .status(400)
          .send({ error: `sub-claim verification failed (${verified.error ?? "keyId mismatch"})` });
      }

      // 4. The SIGNED claimType and the route action must agree — a confirm-signed
      // claim must never be replayable on the negate route.
      if (subClaim.claimType !== action) {
        return reply.status(400).send({
          error: `claimType "${subClaim.claimType}" does not match route action "${action}"`,
        });
      }

      // 5. The subject must resolve to the target observation id. v1 accepts the
      // observation id ONLY. A maresi-uri subject cannot be resolved without a
      // report-signature→observation index, which this task deliberately does
      // not build, so any subject that is not the id is refused.
      if (subClaim.subject !== id) {
        return reply
          .status(400)
          .send({ error: "subClaim.subject must be the target observation id in v1" });
      }

      // 6. The reporter row MUST exist and be active — enrollment is the only gate
      // that creates a reporter; an unknown/blocked key can never vote.
      if (reporter === undefined || reporter.status !== "active") {
        return reply.status(403).send({ error: "reporter is not enrolled or is blocked" });
      }

      // 6b. A sub-claim geometry is OPTIONAL ("where the vote was made"), but when
      // present it must be a plausibility-valid Point — the SAME deterministic
      // geometry screen the report path uses (per-type arity, exactly-two finite
      // in-WGS84-range coordinates). A non-Point is rejected rather than silently
      // dropped; a malformed/3D/out-of-range Point is caught here, before any DB
      // round-trip, so no sub_claim or evidence row is written and PostGIS never
      // sees a shape it would 500 on.
      if (subClaim.geometry !== undefined) {
        const geometryReasons = checkGeometryPlausibility(subClaim.geometry, {
          requireType: "Point",
        });
        if (geometryReasons.length > 0) {
          return reply
            .status(422)
            .send({ error: "implausible sub-claim geometry", reasons: geometryReasons });
        }
      }

      // 7-9. Lock the observation, store the sub-claim, append evidence, recompute.
      let outcome;
      try {
        outcome = await castSubClaimVote(sql, id, subClaim, nowIso);
      } catch (err) {
        if (err instanceof GeometryInvalidError) {
          return reply
            .status(422)
            .send({ error: "implausible sub-claim geometry", reasons: ["geometry_invalid"] });
        }
        throw err;
      }
      if (outcome.code === 404) {
        return reply.status(404).send({ error: outcome.error });
      }
      if (outcome.code === 409) {
        return reply.status(409).send({ error: outcome.error });
      }
      if (outcome.action === "flag") {
        return reply.status(200).send({ flagged: true });
      }
      return reply.status(200).send({
        observationId: outcome.observationId,
        evidenceState: outcome.evidenceState,
        routingEligible: outcome.routingEligible,
        action: outcome.action,
      });
    }
  );

  // Advisory own-reputation read. Authenticated by a valid reporting grant in
  // the `Authorization: Bearer <grant>` header ONLY — never a query param, so a
  // bearer credential can't leak into proxy/access logs. The key is taken FROM
  // THE GRANT, never a client field. Returns the caller's OWN advisory
  // reliability lower bound — explicitly NOT a probability of truth and NOT a
  // Sybil-resistance guarantee. A blocked reporter still gets its reputation
  // (with status), so it can see it is blocked. Single read, no mutation.
  app.get("/contrib/reporter/me", async (req, reply) => {
    const auth = req.headers["authorization"];
    const grant =
      typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (grant === undefined || grant.length === 0) {
      return reply.status(401).send({ error: "reporting grant required" });
    }
    const verified = await verifyReportingGrant(grant, grantSecret, now());
    if (!verified.valid || verified.keyId === undefined) {
      return reply.status(401).send({ error: `invalid reporting grant (${verified.reason})` });
    }
    const keyId = verified.keyId;
    const rows = await sql<{ reputation_alpha: number; reputation_beta: number; status: string }[]>`
        SELECT reputation_alpha, reputation_beta, status
        FROM conditions.reporter WHERE key_id = ${keyId}
      `;
    const reporter = rows[0];
    if (reporter === undefined) {
      return reply.status(404).send({ error: "reporter is not enrolled" });
    }
    const lowerBound = reliabilityLowerBound(
      { alpha: reporter.reputation_alpha, beta: reporter.reputation_beta },
      ADVISORY_CREDIBLE_LEVEL
    );
    return reply.status(200).send({
      keyId,
      reliabilityLowerBound: lowerBound,
      status: reporter.status,
      note: "advisory — not a probability of truth or a Sybil-resistance guarantee",
    });
  });

  // Reviewer / moderation surface — POST-HOC only, nothing gates before publish.
  // Every route is operator-authenticated with the bearer token (never a device
  // key/grant) via the requireReviewer preHandler.

  app.get<{ Querystring: { limit?: string; before?: string; beforeId?: string } }>(
    "/contrib/reviewer/flagged",
    { preHandler: requireReviewer },
    async (req, reply) => {
      const rawLimit = req.query.limit;
      const limit = rawLimit === undefined ? undefined : Number.parseInt(rawLimit, 10);
      const before = req.query.before;
      const beforeId = req.query.beforeId;
      // The composite keyset cursor is a pair: both halves or neither.
      if ((before === undefined) !== (beforeId === undefined)) {
        return reply.status(400).send({ error: "before and beforeId must be supplied together" });
      }
      if (before !== undefined && Number.isNaN(new Date(before).getTime())) {
        return reply.status(400).send({ error: "before must be an ISO 8601 timestamp" });
      }
      const page = await listFlagged(sql, { limit, before, beforeId });
      return reply.send(page);
    }
  );

  app.post<{ Params: { id: string } }>(
    "/contrib/reviewer/observations/:id/accept",
    { preHandler: requireReviewer },
    async (req, reply) => {
      const outcome = await acceptObservation(sql, req.params.id, now());
      if (outcome.code !== 200) {
        return reply.status(outcome.code).send({ error: outcome.error });
      }
      return reply.status(200).send({
        observationId: outcome.observationId,
        evidenceState: outcome.evidenceState,
        routingEligible: outcome.routingEligible,
      });
    }
  );

  app.post<{ Params: { id: string } }>(
    "/contrib/reviewer/observations/:id/reject",
    { preHandler: requireReviewer },
    async (req, reply) => {
      const outcome = await rejectObservation(sql, req.params.id, now());
      if (outcome.code !== 200) {
        return reply.status(outcome.code).send({ error: outcome.error });
      }
      return reply.status(200).send({
        observationId: outcome.observationId,
        evidenceState: outcome.evidenceState,
        tombstoned: outcome.tombstoned === true,
      });
    }
  );

  app.get("/contrib/reviewer/blocklist", { preHandler: requireReviewer }, async (_req, reply) => {
    const items = await listBlocked(sql);
    return reply.send({ items });
  });

  app.post<{ Body: { keyId?: string; reason?: string } }>(
    "/contrib/reviewer/blocklist",
    { preHandler: requireReviewer },
    async (req, reply) => {
      const body = req.body ?? {};
      if (typeof body.keyId !== "string" || body.keyId.length === 0) {
        return reply.status(400).send({ error: "keyId is required" });
      }
      const reason = typeof body.reason === "string" ? body.reason : null;
      await blockKey(sql, body.keyId, reason, now());
      return reply.status(200).send({ keyId: body.keyId, blocked: true });
    }
  );

  app.delete<{ Params: { keyId: string } }>(
    "/contrib/reviewer/blocklist/:keyId",
    { preHandler: requireReviewer },
    async (req, reply) => {
      await unblockKey(sql, req.params.keyId);
      return reply.status(200).send({ keyId: req.params.keyId, blocked: false });
    }
  );

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
