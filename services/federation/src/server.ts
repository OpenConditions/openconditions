/**
 * Fastify app for the federation service — the HTTP face of the instance's
 * federated identity: the discovery surface (Actor document + declared peers
 * under /.well-known/openconditions/), the pull side of the peer exchange
 * (GET /peer/outbox — the RFC-9421-signed, monotonic-cursor read over the
 * append-only federation outbox journal), the subscription surface, and the
 * INBOX (POST /peer/inbox — the signed webhook target where verified peer
 * events cross the federation trust boundary).
 * Exported as build() so tests can fastify.inject; only main.ts listens.
 */
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import type postgres from "postgres";
import {
  ACTIVITY_JSON,
  ACTOR_WELL_KNOWN_PATH,
  PEERS_WELL_KNOWN_PATH,
  OUTBOX_DEFAULT_LIMIT,
  OUTBOX_MAX_LIMIT,
  InMemoryNonceStore,
  buildActorDocument,
  createInMemoryRateLimiter,
  ensureInstanceKey,
  loadActiveKeys,
  outboxEtag,
  signMessage,
  type InstanceKey,
  type MtlsContext,
  type RateLimiter,
} from "@openconditions/federation";
import { readBackfill } from "./backfill.js";
import { registerBackfillRoutes } from "./backfill-routes.js";
import { resolveFederationSettings } from "./config.js";
import { registerInboxRoutes } from "./inbox-routes.js";
import { OutboxQueryError, parseOutboxQuery } from "./outbox-query.js";
import { optionalPeer, respondIfBlocked } from "./peer-request.js";
import { registerSubscriptionRoutes } from "./subscription-routes.js";

/** The pull-side peer exchange path the Actor document advertises as `outbox`. */
const OUTBOX_PATH = "/peer/outbox";

/** The authenticated subscription CRUD surface. */
const SUBSCRIPTIONS_PATH = "/peer/subscriptions";

/** The authenticated SSE live channel. */
const STREAM_PATH = "/peer/stream";

/** The signed webhook delivery target (the federation trust boundary). */
const INBOX_PATH = "/peer/inbox";

/** The authenticated, tier-bounded history read (pull outbox with a time floor). */
const BACKFILL_PATH = "/peer/backfill";

export interface BuildOptions {
  sql: postgres.Sql;
  env?: Record<string, string | undefined>;
  logger?: FastifyServerOptions["logger"];
  /** Injectable clock (ISO 8601); defaults to the real clock. */
  now?: () => string;
  /** Injectable transport rate limiter (tests tighten the caps); defaults to
   *  the standard tier-aware in-memory limiter. */
  rateLimiter?: RateLimiter;
  /**
   * Resolves the request's TLS client-cert context for the optional per-peer
   * mTLS gate; defaults to reading the socket's verified client cert. Tests
   * inject a resolver to simulate a client cert under `app.inject`; operators
   * fronting TLS at a proxy inject one that reads the proxy's cert headers.
   */
  mtlsContextFor?: (req: FastifyRequest) => MtlsContext | undefined;
}

export async function build(options: BuildOptions): Promise<FastifyInstance> {
  const { sql } = options;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date().toISOString());

  // Throws (failing the boot closed) when enabled with a bad config.
  const settings = resolveFederationSettings(env);

  const app = Fastify({ logger: options.logger ?? true });

  app.get("/status", async (_req, reply) => {
    return reply.send({
      status: "ok",
      service: "openconditions-federation-api",
      federation: settings.enabled,
    });
  });

  if (!settings.enabled) {
    for (const path of [
      ACTOR_WELL_KNOWN_PATH,
      PEERS_WELL_KNOWN_PATH,
      OUTBOX_PATH,
      BACKFILL_PATH,
      SUBSCRIPTIONS_PATH,
      STREAM_PATH,
    ]) {
      app.get(path, async (_req, reply) => {
        return reply.status(404).send({ error: "federation is disabled on this instance" });
      });
    }
    app.post(INBOX_PATH, async (_req, reply) => {
      return reply.status(404).send({ error: "federation is disabled on this instance" });
    });
    return app;
  }

  const actorConfig = settings.actor!;
  await ensureInstanceKey(sql, now());

  /** The newest active signing key, self-healing an all-expired table (same
   *  rationale as the actor route: keys are read per request so a rotation
   *  shows up without a restart). */
  async function signingKey(): Promise<InstanceKey> {
    let keys = await loadActiveKeys(sql, now());
    if (keys.length === 0) {
      await ensureInstanceKey(sql, now());
      keys = await loadActiveKeys(sql, now());
    }
    return keys[0]!;
  }

  app.get(ACTOR_WELL_KNOWN_PATH, async (_req, reply) => {
    // Keys are read per request so a rotation shows up without a restart.
    // Self-heal an all-expired table (e.g. a very long-lived process that
    // never rotated) instead of serving an actor document with no keys.
    let keys = await loadActiveKeys(sql, now());
    if (keys.length === 0) {
      await ensureInstanceKey(sql, now());
      keys = await loadActiveKeys(sql, now());
    }
    const doc = buildActorDocument(actorConfig, keys);
    return reply.type(ACTIVITY_JSON).send(JSON.stringify(doc));
  });

  app.get(PEERS_WELL_KNOWN_PATH, async (_req, reply) => {
    return reply.send({ peers: settings.peers });
  });

  // One NonceStore guards replay across every signed peer request (the
  // optionally-authenticated outbox, subscriptions, SSE stream, inbox, backfill).
  const nonceStore = new InMemoryNonceStore();

  // One rate limiter shared by inbox + backfill so a peer's sustained-overrun
  // tier downgrade is consistent across both transport surfaces. In-memory =
  // single-instance; a multi-replica deployment would back it with Redis.
  const rateLimiter = options.rateLimiter ?? createInMemoryRateLimiter();

  app.get(OUTBOX_PATH, async (req, reply) => {
    // The public outbox is OPTIONALLY authenticated: an unsigned request is the
    // public Tier-0 snapshot (last 24h); a signed pinned peer gets its own tier's
    // window. The tier is the PINNED record's, never a client field — an unsigned
    // caller cannot widen its window, so paging the outbox from 0.0 cannot
    // exfiltrate history past the floor (that is /peer/backfill + the archive).
    const auth = await optionalPeer(
      {
        peers: settings.peers,
        baseUrl: actorConfig.baseUrl,
        nonceStore,
        ...(options.mtlsContextFor !== undefined ? { mtlsContextFor: options.mtlsContextFor } : {}),
      },
      req,
      reply
    );
    if (auth.rejected) return reply;
    // A blocked authenticated peer is refused the outbox too (transport control).
    if (auth.peerId !== null && (await respondIfBlocked(sql, auth.peerId, reply))) {
      return reply;
    }
    const tier: 0 | 1 | 2 =
      auth.peerId !== null
        ? (settings.peers.find((p) => p.instanceId === auth.peerId)?.trustTier ?? 0)
        : 0;

    let parsed;
    try {
      parsed = parseOutboxQuery(req.query as Record<string, unknown>);
    } catch (err) {
      if (err instanceof OutboxQueryError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }

    const partOf = `${actorConfig.baseUrl}${OUTBOX_PATH}`;
    const key = await signingKey();
    const limit = Math.min(Math.max(parsed.limit ?? OUTBOX_DEFAULT_LIMIT, 1), OUTBOX_MAX_LIMIT);

    // Build the fenced page first, then derive the ETag from THIS page's own
    // frontier (highWaterMark) — one consistent snapshot, so the ETag height can
    // never lag the body it labels. `limit` and the requester's tier are folded
    // into the ETag: a different page size or window is a different
    // representation, not a false 304. The page is the tier-bounded live tail —
    // the SAME composite-cursor primitive as /peer/backfill (shared tier floor);
    // an after-cursor before the floor redirects to the static archive.
    const page = await readBackfill(sql, {
      after: parsed.after,
      tier,
      limit,
      ...(parsed.filter !== undefined ? { filter: parsed.filter } : {}),
      ...(parsed.nextParams !== undefined ? { nextParams: parsed.nextParams } : {}),
      partOf,
      archiveUrl: settings.archiveUrl!,
      now: now(),
    });
    const etag = outboxEtag(page.highWaterMark, parsed.after, limit, parsed.filter, tier);

    if (req.headers["if-none-match"] === etag) {
      // A 304 has no body (no content-digest), so the ETag is the only thing to
      // authenticate — cover it explicitly so a MITM cannot tamper it.
      const signed = await signMessage({
        method: "GET",
        url: partOf,
        headers: { etag },
        coverHeaders: ["etag"],
        keyId: key.keyId,
        privateKey: key.privateKey,
        isResponse: true,
        status: 304,
      });
      return reply.status(304).headers(signed.headers).send();
    }

    // The whole body — highWaterMark included — is covered by the signed
    // Content-Digest, which is what makes the high-water mark itself signed.
    const body = Buffer.from(JSON.stringify(page));
    const signed = await signMessage({
      method: "GET",
      url: partOf,
      headers: { "content-type": ACTIVITY_JSON, etag },
      body,
      keyId: key.keyId,
      privateKey: key.privateKey,
      isResponse: true,
      status: 200,
    });
    return reply.status(200).headers(signed.headers).send(body);
  });

  // The signature must verify against the RECEIVED bytes, so every
  // authenticated POST/PATCH body is kept raw (the handlers parse the JSON
  // themselves after authenticating). Registered once for all peer routes.
  app.addContentTypeParser(
    ["application/json", "application/activity+json"],
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body)
  );

  registerSubscriptionRoutes(app, {
    sql,
    peers: settings.peers,
    baseUrl: actorConfig.baseUrl,
    nonceStore,
    ...(options.mtlsContextFor !== undefined ? { mtlsContextFor: options.mtlsContextFor } : {}),
    now,
  });

  registerInboxRoutes(app, {
    sql,
    peers: settings.peers,
    baseUrl: actorConfig.baseUrl,
    localInstanceId: actorConfig.instanceId,
    nonceStore,
    rateLimiter,
    ...(options.mtlsContextFor !== undefined ? { mtlsContextFor: options.mtlsContextFor } : {}),
    now,
  });

  registerBackfillRoutes(app, {
    sql,
    peers: settings.peers,
    baseUrl: actorConfig.baseUrl,
    nonceStore,
    rateLimiter,
    archiveUrl: settings.archiveUrl!,
    signingKey,
    ...(options.mtlsContextFor !== undefined ? { mtlsContextFor: options.mtlsContextFor } : {}),
    now,
  });

  return app;
}
