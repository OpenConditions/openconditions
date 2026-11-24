/**
 * Fastify app for the federation service — the HTTP face of the instance's
 * federated identity: the discovery surface (Actor document + declared peers
 * under /.well-known/openconditions/), the pull side of the peer exchange
 * (GET /peer/outbox — the RFC-9421-signed, monotonic-cursor read over the
 * append-only federation outbox journal), the subscription surface, the
 * INBOX (POST /peer/inbox — the signed webhook target where verified peer
 * events cross the federation trust boundary), and the record state a
 * subscriber compares its copies with (GET /peer/state, POST /peer/records).
 * Exported as build() so tests can fastify.inject; only main.ts listens.
 */

import { verifySecretsKeyCheck } from "@openconditions/core/server";
import {
  ACTOR_WELL_KNOWN_PATH,
  anonymousRateKey,
  assertInstanceKeysOpen,
  buildActorDocument,
  createInMemoryRateLimiter,
  FEDERATION_JSON,
  FEDERATION_REASON_HEADER,
  InMemoryNonceStore,
  type InstanceKey,
  loadActiveKeys,
  loadActivePublicKeys,
  type MtlsContext,
  maintainInstanceKey,
  OUTBOX_DEFAULT_LIMIT,
  OUTBOX_MAX_LIMIT,
  outboxEtag,
  PEERS_WELL_KNOWN_PATH,
  type PublicInstanceKey,
  type RateLimiter,
  readJournalLag,
  recordPeerFailure,
  signingKeyOf,
  signMessage,
  wirePage,
} from "@openconditions/federation";
import { parseAllowedHosts } from "@openconditions/ingest-framework";
import { schemaVersions } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import type postgres from "postgres";
import { loadArchive } from "./archive.js";
import { readBackfill } from "./backfill.js";
import { registerBackfillRoutes } from "./backfill-routes.js";
import { resolveFederationSettings } from "./config.js";
import { registerInboxRoutes } from "./inbox-routes.js";
import { OutboxQueryError, parseOutboxQuery } from "./outbox-query.js";
import { PeerBook } from "./peer-book.js";
import {
  headerStrings,
  isTrustedProxy,
  optionalPeer,
  proxyMtlsContext,
  respondIfBlocked,
} from "./peer-request.js";
import { RECORDS_PATH, registerStateRoutes, STATE_PATH } from "./state-routes.js";
import { registerSubscriptionRoutes } from "./subscription-routes.js";
import { warnWithheld } from "./withheld.js";

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

/** The journal's epoch and fence lag. */
const JOURNAL_STATUS_PATH = "/status/journal";

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
  /** Called once a peer created or changed a subscription (main seeds the journal). */
  onSubscribed?: () => void;
  /** The peers as main's upkeep keeps them; defaults to the configured ones and their learned keys. */
  peers?: PeerBook;
}

export async function build(options: BuildOptions): Promise<FastifyInstance> {
  const { sql } = options;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date().toISOString());

  // Throws (failing the boot closed) when enabled with a bad config.
  const settings = resolveFederationSettings(env);
  // Who verified a peer's client certificate: the injected resolver, a
  // TLS-terminating proxy's header, or else this process's own socket.
  const mtlsContextFor =
    options.mtlsContextFor ??
    (settings.clientCertHeader !== undefined
      ? proxyMtlsContext(settings.clientCertHeader, settings.trustedProxies)
      : undefined);

  // `req.ip` believes X-Forwarded-For only from the configured proxies. It
  // says nothing but where an anonymous outbox read is metered: the mutual-TLS
  // check reads the connection's own address, and signed target URIs come
  // from the configured base URL.
  const proxies = settings.trustedProxies;
  const app = Fastify({
    logger: options.logger ?? true,
    ...(proxies !== undefined
      ? { trustProxy: (address: string) => isTrustedProxy(proxies, address) }
      : {}),
  });

  app.get("/status", async (_req, reply) => {
    return reply.send({
      status: "ok",
      service: "openconditions-federation-api",
      federation: settings.enabled,
    });
  });

  if (!settings.enabled) {
    for (const path of [
      JOURNAL_STATUS_PATH,
      ACTOR_WELL_KNOWN_PATH,
      PEERS_WELL_KNOWN_PATH,
      OUTBOX_PATH,
      BACKFILL_PATH,
      SUBSCRIPTIONS_PATH,
      STREAM_PATH,
      STATE_PATH,
    ]) {
      app.get(path, async (_req, reply) => {
        return reply.status(404).send({ error: "federation is disabled on this instance" });
      });
    }
    for (const path of [INBOX_PATH, RECORDS_PATH]) {
      app.post(path, async (_req, reply) => {
        return reply.status(404).send({ error: "federation is disabled on this instance" });
      });
    }
    return app;
  }

  const actorConfig = settings.actor;
  const secretsKey = settings.secretsKey;
  // The running registry, not the operator, says which schemas this instance accepts.
  const registry = productionRegistry();
  const advertisedSchemaVersions = schemaVersions(registry);
  const peers = options.peers ?? (await PeerBook.load(sql, settings.peers));
  // A key other than the one the ingest service sealed the check row with
  // stops the boot (main.ts waits for that row first), and so does one that
  // cannot open the stored instance keys, naming the key.
  await verifySecretsKeyCheck(sql, secretsKey);
  await assertInstanceKeysOpen(sql, secretsKey);
  await maintainInstanceKey(sql, secretsKey, now(), actorConfig.instanceId);

  /** The keys valid now, rotating first when none is (a process that
   *  outlived its keys): keys are read per request, so a rotation shows up
   *  without a restart. */
  async function activeKeys(): Promise<InstanceKey[]> {
    const keys = await loadActiveKeys(sql, secretsKey, now());
    if (keys.length > 0) return keys;
    await maintainInstanceKey(sql, secretsKey, now(), actorConfig.instanceId);
    return loadActiveKeys(sql, secretsKey, now());
  }

  /** The public half of the keys valid now, for the actor document: no
   *  private key is opened for a public read. Rotates first when none is. */
  async function activePublicKeys(): Promise<PublicInstanceKey[]> {
    const keys = await loadActivePublicKeys(sql, now());
    if (keys.length > 0) return keys;
    await maintainInstanceKey(sql, secretsKey, now(), actorConfig.instanceId);
    return loadActivePublicKeys(sql, now());
  }

  /** The key this instance signs with now. */
  async function signingKey(): Promise<InstanceKey> {
    return signingKeyOf(await activeKeys(), now())!;
  }

  // How far the journal's fence lags: the epoch, and since when committed
  // entries wait behind an open transaction. Which session holds them is not
  // said here: that would publish other applications' names.
  app.get(JOURNAL_STATUS_PATH, async (_req, reply) => {
    return reply.send(await readJournalLag(sql, now()));
  });

  app.get(ACTOR_WELL_KNOWN_PATH, async (_req, reply) => {
    const doc = buildActorDocument(actorConfig, await activePublicKeys(), advertisedSchemaVersions);
    return reply.type(FEDERATION_JSON).send(JSON.stringify(doc));
  });

  // What this instance subscribes to or pulls at a peer is its own business.
  app.get(PEERS_WELL_KNOWN_PATH, async (_req, reply) => {
    const listed = peers.all().map(({ subscribe: _subscribe, pull: _pull, ...peer }) => peer);
    return reply.send({ peers: listed });
  });

  // One NonceStore guards replay across every signed peer request (the
  // optionally-authenticated outbox, subscriptions, SSE stream, inbox, backfill).
  const nonceStore = new InMemoryNonceStore();

  // One rate limiter shared by inbox, backfill and outbox so a peer's
  // sustained-overrun tier downgrade is consistent across the transport
  // surfaces. In-memory = single-instance; a multi-replica deployment would
  // back it with Redis.
  const rateLimiter = options.rateLimiter ?? createInMemoryRateLimiter();

  let warnedUntrustedProxy = false;
  app.get(OUTBOX_PATH, async (req, reply) => {
    // The public outbox is OPTIONALLY authenticated: an unsigned request is the
    // public Tier-0 snapshot (last 24h); a signed pinned peer gets its own tier's
    // window. The tier is the PINNED record's, never a client field — an unsigned
    // caller cannot widen its window, so paging the outbox from 0.0 cannot
    // exfiltrate history past the floor (that is /peer/backfill + the archive).
    const auth = await optionalPeer(
      {
        peers,
        baseUrl: actorConfig.baseUrl,
        nonceStore,
        ...(mtlsContextFor !== undefined ? { mtlsContextFor } : {}),
      },
      req,
      reply,
    );
    if (auth.rejected) return reply;
    // A blocked authenticated peer is refused the outbox too (transport control).
    if (auth.peerId !== null && (await respondIfBlocked(sql, auth.peerId, reply))) {
      return reply;
    }
    const tier: 0 | 1 | 2 = auth.peerId !== null ? (peers.find(auth.peerId)?.trustTier ?? 0) : 0;

    // Behind a reverse proxy that is not named as trusted, every anonymous
    // reader arrives from the proxy's address and shares one budget, which a
    // single reader can use up. Said once, since the operator has to fix it.
    if (
      auth.peerId === null &&
      proxies === undefined &&
      !warnedUntrustedProxy &&
      req.headers["x-forwarded-for"] !== undefined
    ) {
      warnedUntrustedProxy = true;
      req.log.warn(
        "anonymous outbox reads arrive through a proxy that " +
          "OPENCONDITIONS_FEDERATION_TRUSTED_PROXIES does not name: they are metered as one " +
          "client address and share one rate budget",
      );
    }

    // Metered before any journal read, the 304 included. A peer's outbox and
    // backfill reads are the two halves of one journal read and draw on one
    // budget; an anonymous reader gets the tier-0 budget per client address.
    const rate = rateLimiter.check(
      auth.peerId ?? anonymousRateKey(req.ip),
      "backfill",
      tier,
      1,
      Date.parse(now()),
    );
    if (!rate.ok) {
      if (auth.peerId !== null) await recordPeerFailure(sql, auth.peerId, "rate", now());
      return reply
        .status(429)
        .header("Retry-After", String(rate.retryAfterSec ?? 60))
        .header(FEDERATION_REASON_HEADER, "rate-limited")
        .send({ error: "outbox rate limit exceeded", retryAfterSec: rate.retryAfterSec });
    }

    let parsed: ReturnType<typeof parseOutboxQuery>;
    try {
      parsed = parseOutboxQuery(req.query as Record<string, unknown>);
    } catch (err) {
      if (err instanceof OutboxQueryError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }

    const partOf = `${actorConfig.baseUrl}${OUTBOX_PATH}`;
    // The signed response is bound to the request it answers, under the same
    // target URI request verification reconstructs (base URL + path and query).
    const answered = {
      method: req.method,
      url: `${actorConfig.baseUrl}${req.url}`,
      headers: headerStrings(req.headers),
    };
    const key = await signingKey();
    const limit = Math.min(Math.max(parsed.limit ?? OUTBOX_DEFAULT_LIMIT, 1), OUTBOX_MAX_LIMIT);

    // Build the fenced page first, then derive the ETag from THIS page's own
    // frontier (highWaterMark) — one consistent snapshot, so the ETag height can
    // never lag the body it labels. `limit` and the requester's tier are folded
    // into the ETag: a different page size or window is a different
    // representation, not a false 304. The page is the tier-bounded live tail —
    // the SAME composite-cursor primitive as /peer/backfill (shared tier floor);
    // an after-cursor before the floor redirects to the static archive.
    const archive = await loadArchive(sql, settings.archiveUrl!);
    const read = await readBackfill(sql, {
      after: parsed.after,
      tier,
      limit,
      ...(parsed.filter !== undefined ? { filter: parsed.filter } : {}),
      ...(parsed.nextParams !== undefined ? { nextParams: parsed.nextParams } : {}),
      partOf,
      ...(archive !== undefined ? { archive } : {}),
      now: now(),
    });
    warnWithheld(read.withheld);
    const page = wirePage(read);
    const etag = outboxEtag(
      page.highWaterMark,
      page.epoch,
      parsed.after,
      limit,
      parsed.filter,
      tier,
      archive?.builtAt,
    );

    if (req.headers["if-none-match"] === etag) {
      // A 304 has no body (no content-digest), so the ETag is the only thing to
      // authenticate — cover it explicitly so a MITM cannot tamper it.
      const signed = await signMessage({
        ...answered,
        headers: { etag },
        coverHeaders: ["etag"],
        keyId: key.keyId,
        privateKey: key.privateKey,
        isResponse: true,
        status: 304,
        request: answered,
      });
      return reply.status(304).headers(signed.headers).send();
    }

    // The whole body — highWaterMark included — is covered by the signed
    // Content-Digest, which is what makes the high-water mark itself signed.
    const body = Buffer.from(JSON.stringify(page));
    const signed = await signMessage({
      ...answered,
      headers: { "content-type": FEDERATION_JSON, etag },
      body,
      keyId: key.keyId,
      privateKey: key.privateKey,
      isResponse: true,
      status: 200,
      request: answered,
    });
    return reply.status(200).headers(signed.headers).send(body);
  });

  // The signature must verify against the RECEIVED bytes, so every
  // authenticated POST/PATCH body is kept raw (the handlers parse the JSON
  // themselves after authenticating). Registered once for all peer routes.
  app.addContentTypeParser(FEDERATION_JSON, { parseAs: "buffer" }, (_req, body, done) =>
    done(null, body),
  );

  const allowedHosts = parseAllowedHosts(env["OPENCONDITIONS_EGRESS_ALLOWED_HOSTS"]);
  registerSubscriptionRoutes(app, {
    sql,
    peers,
    baseUrl: actorConfig.baseUrl,
    nonceStore,
    ...(mtlsContextFor !== undefined ? { mtlsContextFor } : {}),
    ...(options.onSubscribed !== undefined ? { onSubscribed: options.onSubscribed } : {}),
    ...(allowedHosts !== undefined ? { allowedHosts } : {}),
    now,
  });

  registerInboxRoutes(app, {
    sql,
    registry,
    peers,
    baseUrl: actorConfig.baseUrl,
    localInstanceId: actorConfig.instanceId,
    nonceStore,
    rateLimiter,
    ...(mtlsContextFor !== undefined ? { mtlsContextFor } : {}),
    now,
  });

  registerBackfillRoutes(app, {
    sql,
    peers,
    baseUrl: actorConfig.baseUrl,
    nonceStore,
    rateLimiter,
    archiveUrl: settings.archiveUrl!,
    signingKey,
    ...(mtlsContextFor !== undefined ? { mtlsContextFor } : {}),
    now,
  });

  registerStateRoutes(app, {
    sql,
    peers,
    baseUrl: actorConfig.baseUrl,
    nonceStore,
    rateLimiter,
    signingKey,
    ...(mtlsContextFor !== undefined ? { mtlsContextFor } : {}),
    now,
  });

  return app;
}
