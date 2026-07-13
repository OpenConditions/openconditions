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
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type postgres from "postgres";
import {
  ACTIVITY_JSON,
  ACTOR_WELL_KNOWN_PATH,
  PEERS_WELL_KNOWN_PATH,
  OUTBOX_DEFAULT_LIMIT,
  OUTBOX_MAX_LIMIT,
  InMemoryNonceStore,
  buildActorDocument,
  ensureInstanceKey,
  loadActiveKeys,
  outboxEtag,
  readOutbox,
  signMessage,
  type InstanceKey,
} from "@openconditions/federation";
import { resolveFederationSettings } from "./config.js";
import { INBOX_DEFAULT_MAX_EVENTS_PER_MINUTE, registerInboxRoutes } from "./inbox-routes.js";
import { OutboxQueryError, parseOutboxQuery } from "./outbox-query.js";
import { registerSubscriptionRoutes } from "./subscription-routes.js";

/** The pull-side peer exchange path the Actor document advertises as `outbox`. */
const OUTBOX_PATH = "/peer/outbox";

/** The authenticated subscription CRUD surface. */
const SUBSCRIPTIONS_PATH = "/peer/subscriptions";

/** The authenticated SSE live channel. */
const STREAM_PATH = "/peer/stream";

/** The signed webhook delivery target (the federation trust boundary). */
const INBOX_PATH = "/peer/inbox";

/** Reads a positive-integer env override, tolerating the Compose `${VAR:-}`
 *  empty-string injection (empty/garbage falls back to the default). */
function positiveIntEnv(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface BuildOptions {
  sql: postgres.Sql;
  env?: Record<string, string | undefined>;
  logger?: FastifyServerOptions["logger"];
  /** Injectable clock (ISO 8601); defaults to the real clock. */
  now?: () => string;
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

  app.get(OUTBOX_PATH, async (req, reply) => {
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
    // frontier (highWaterMark) — one consistent snapshot, so the ETag height
    // can never lag the body it labels. `limit` is folded into the ETag: a
    // different page size is a different representation, not a false 304.
    const page = await readOutbox(sql, {
      after: parsed.after,
      limit,
      ...(parsed.filter !== undefined ? { filter: parsed.filter } : {}),
      ...(parsed.nextParams !== undefined ? { nextParams: parsed.nextParams } : {}),
      partOf,
      now: now(),
    });
    const etag = outboxEtag(page.highWaterMark, parsed.after, limit, parsed.filter);

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

  // One NonceStore guards replay across every signed peer request
  // (subscriptions, SSE stream, inbox).
  const nonceStore = new InMemoryNonceStore();

  registerSubscriptionRoutes(app, {
    sql,
    peers: settings.peers,
    baseUrl: actorConfig.baseUrl,
    nonceStore,
    now,
  });

  registerInboxRoutes(app, {
    sql,
    peers: settings.peers,
    baseUrl: actorConfig.baseUrl,
    localInstanceId: actorConfig.instanceId,
    nonceStore,
    now,
    maxEventsPerMinute: positiveIntEnv(
      env["OPENCONDITIONS_FEDERATION_INBOX_MAX_EVENTS_PER_MINUTE"],
      INBOX_DEFAULT_MAX_EVENTS_PER_MINUTE
    ),
  });

  return app;
}
