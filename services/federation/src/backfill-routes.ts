/**
 * GET /peer/backfill — the authenticated, tier-bounded history read. It is the
 * pull outbox with a LOWER TIME FLOOR: same RFC-9421-signed page, same composite
 * `(txid, seq)` cursor, but bounded to the caller's trust-tier window. Beyond the
 * window the page carries `beyondWindow: true` + the static `archiveUrl` (no
 * protocol — the peer fetches the GeoParquet archive directly over HTTP Range).
 *
 * The tier is authoritative from the PINNED peer record (T1), derived from the
 * signature's key — never a client-supplied field. An unsigned, bad-signature,
 * or unpinned request is a 401 on the whole page.
 */
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import {
  ACTIVITY_JSON,
  FEDERATION_REASON_HEADER,
  recordPeerFailure,
  signMessage,
  type InstanceKey,
  type NonceStore,
  type PeerRecord,
  type RateLimiter,
} from "@openconditions/federation";
import { readBackfill } from "./backfill.js";
import { OutboxQueryError, parseOutboxQuery } from "./outbox-query.js";
import { requirePeer, respondIfBlocked } from "./peer-request.js";

const BACKFILL_PATH = "/peer/backfill";

export interface BackfillRouteContext {
  sql: postgres.Sql;
  /** The pinned peers registry (settings.peers) — the tier authority. */
  peers: PeerRecord[];
  /** The instance's configured base URL — the authority the signed target-uri uses. */
  baseUrl: string;
  /** Per-peer replay cache shared across the authenticated routes. */
  nonceStore: NonceStore;
  /** The static archive URL served for beyond-window ranges. */
  archiveUrl: string;
  /** Loads the newest active signing key (self-healing a rotation). */
  signingKey: () => Promise<InstanceKey>;
  /** Shared per-peer transport rate limiter (inbox + backfill). */
  rateLimiter: RateLimiter;
  /** Injectable clock (ISO 8601). */
  now: () => string;
  /** Tier-2 window override in seconds. */
  governanceWindowSec?: number;
}

export function registerBackfillRoutes(app: FastifyInstance, ctx: BackfillRouteContext): void {
  app.get(BACKFILL_PATH, async (req, reply) => {
    const peerId = await requirePeer(ctx, req, reply);
    if (peerId === null) return reply;

    if (await respondIfBlocked(ctx.sql, peerId, reply)) return reply;

    // The tier is read from the PINNED peer record the auth resolved, never the
    // request — a peer cannot claim a wider window by asserting a higher tier.
    const peer = ctx.peers.find((p) => p.instanceId === peerId);
    if (peer === undefined) {
      return reply.status(401).send({ error: "authenticated peer is not in the registry" });
    }

    const rate = ctx.rateLimiter.check(
      peerId,
      "backfill",
      peer.trustTier,
      1,
      Date.parse(ctx.now())
    );
    if (!rate.ok) {
      await recordPeerFailure(ctx.sql, peerId, "rate", ctx.now());
      return reply
        .status(429)
        .header("Retry-After", String(rate.retryAfterSec ?? 60))
        .header(FEDERATION_REASON_HEADER, "rate-limited")
        .send({ error: "backfill rate limit exceeded", retryAfterSec: rate.retryAfterSec });
    }

    let parsed;
    try {
      parsed = parseOutboxQuery(req.query as Record<string, unknown>);
    } catch (err) {
      if (err instanceof OutboxQueryError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }

    const partOf = `${ctx.baseUrl}${BACKFILL_PATH}`;
    const page = await readBackfill(ctx.sql, {
      after: parsed.after,
      tier: peer.trustTier,
      partOf,
      archiveUrl: ctx.archiveUrl,
      now: ctx.now(),
      ...(parsed.filter !== undefined ? { filter: parsed.filter } : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      ...(parsed.nextParams !== undefined ? { nextParams: parsed.nextParams } : {}),
      ...(ctx.governanceWindowSec !== undefined
        ? { governanceWindowSec: ctx.governanceWindowSec }
        : {}),
    });

    // The whole body — beyondWindow/archiveUrl and highWaterMark included — is
    // covered by the signed Content-Digest, so the redirect and cursor are signed.
    const key = await ctx.signingKey();
    const body = Buffer.from(JSON.stringify(page));
    const signed = await signMessage({
      method: "GET",
      url: partOf,
      headers: { "content-type": ACTIVITY_JSON },
      body,
      keyId: key.keyId,
      privateKey: key.privateKey,
      isResponse: true,
      status: 200,
    });
    return reply.status(200).headers(signed.headers).send(body);
  });
}
