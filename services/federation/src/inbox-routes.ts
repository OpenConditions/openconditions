/**
 * POST /peer/inbox — the signed webhook delivery target and the federation
 * TRUST BOUNDARY's HTTP face. Every request is RFC-9421-signed by the caller's
 * actor (verifyMessage) and the `peerId` is derived from the pinned `keyid`
 * (the peers registry); an unsigned/bad-signature/unpinned request is a 401 on
 * the WHOLE page. Individual events inside an authenticated page are
 * skip-and-report: one malformed or unauthorized event (e.g. a third
 * instance's instanceId) is skipped with a named reason and never blocks the
 * rest — the peer advances its push-ack on the returned `maxCursor`.
 *
 * The body is an OrderedCollectionPage of outbox entries (the exact shape the
 * webhook push and the pull outbox serve); each record lands through the ONE
 * federation inbox (`@openconditions/contributions-api/federation/inbox`), so
 * webhook push and consumer pull share the same trust boundary. Admission
 * reads the schema versions the peer advertised when its actor document was
 * last verified; until it has been, the page is answered 503 so the peer
 * retries once the instance knows what it runs.
 *
 * Abuse controls here are TRANSPORT ONLY (ADR §8 — peer health ≠ event truth):
 * a blocked peer is refused (403); a per-peer, tier-aware rate limiter refuses
 * overrun (429 + Retry-After) and records the violation against the peer's
 * HEALTH; signature/replay/schema failures are counted against health too.
 * NONE of this re-judges an already-accepted event or feeds evidence/routing.
 */

import {
  FederatedPageError,
  ingestFederatedPage,
} from "@openconditions/contributions-api/federation/inbox";
import {
  FEDERATION_REASON_HEADER,
  type FederationFailureReason,
  loadPeerVersions,
  type MtlsContext,
  type NonceStore,
  type PeerHealthFailure,
  type PeerRecord,
  type RateLimiter,
  recordPeerFailure,
} from "@openconditions/federation";
import type { Registry } from "@openconditions/model";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { requirePeer, respondIfBlocked } from "./peer-request.js";

const INBOX_PATH = "/peer/inbox";

/** How long a peer whose capabilities are not yet known waits before retrying. */
const CAPABILITIES_RETRY_SEC = 60;

export interface InboxRouteContext {
  sql: postgres.Sql;
  /** The running registry peer records are admitted against. */
  registry: Registry;
  /** The pinned peers registry (settings.peers). */
  peers: PeerRecord[];
  /** The instance's configured base URL — the authority the signed target-uri uses. */
  baseUrl: string;
  /** This instance's own id (threaded into the ingest's local-row ownership rules). */
  localInstanceId: string;
  /** Per-peer replay cache shared across the authenticated routes. */
  nonceStore: NonceStore;
  /** Shared per-peer transport rate limiter (inbox + backfill). */
  rateLimiter: RateLimiter;
  /** Resolves the request's TLS client-cert context for the optional mTLS gate. */
  mtlsContextFor?: (req: FastifyRequest) => MtlsContext | undefined;
  /** Injectable clock (ISO 8601). */
  now: () => string;
}

/**
 * Maps a verify-path failure to the peer-HEALTH failure class it counts as, or
 * null when it is not attributable to a peer's integrity (an unpinned key, a
 * plain expiry). TRANSPORT signal only — never event truth.
 */
export function healthFailureForReason(reason: FederationFailureReason): PeerHealthFailure | null {
  switch (reason) {
    case "replayed":
      return "replay";
    case "bad-signature":
    case "bad-digest":
    case "ambiguous-signature":
    case "insufficient-coverage":
    case "tag-mismatch":
      return "signature";
    default:
      return null;
  }
}

function tierForPeer(peers: PeerRecord[], peerId: string): 0 | 1 | 2 {
  return peers.find((p) => p.instanceId === peerId)?.trustTier ?? 0;
}

export function registerInboxRoutes(app: FastifyInstance, ctx: InboxRouteContext): void {
  app.post(INBOX_PATH, async (req, reply) => {
    const body = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
    const peerId = await requirePeer(
      {
        peers: ctx.peers,
        baseUrl: ctx.baseUrl,
        nonceStore: ctx.nonceStore,
        onAuthFailure: async (reason, failedPeerId) => {
          const kind = healthFailureForReason(reason);
          if (kind !== null && failedPeerId !== null) {
            await recordPeerFailure(ctx.sql, failedPeerId, kind, ctx.now());
          }
        },
        ...(ctx.mtlsContextFor !== undefined ? { mtlsContextFor: ctx.mtlsContextFor } : {}),
      },
      req,
      reply,
      body,
    );
    if (peerId === null) return reply;

    if (await respondIfBlocked(ctx.sql, peerId, reply)) return reply;

    let page: unknown;
    try {
      page = body.byteLength === 0 ? {} : JSON.parse(body.toString("utf8"));
    } catch {
      return reply.status(400).send({ error: "request body is not valid JSON" });
    }
    const items = (page as { orderedItems?: unknown })?.orderedItems;
    if (!Array.isArray(items)) {
      return reply
        .status(400)
        .send({ error: "body must be an OrderedCollectionPage with orderedItems" });
    }

    const rate = ctx.rateLimiter.check(
      peerId,
      "inbox",
      tierForPeer(ctx.peers, peerId),
      items.length,
      Date.parse(ctx.now()),
    );
    if (!rate.ok) {
      await recordPeerFailure(ctx.sql, peerId, "rate", ctx.now());
      return reply
        .status(429)
        .header("Retry-After", String(rate.retryAfterSec ?? 60))
        .header(FEDERATION_REASON_HEADER, "rate-limited")
        .send({ error: "inbox rate limit exceeded", retryAfterSec: rate.retryAfterSec });
    }

    const peerVersions = await loadPeerVersions(ctx.sql, peerId);
    if (peerVersions === undefined) {
      return reply
        .status(503)
        .header("Retry-After", String(CAPABILITIES_RETRY_SEC))
        .header(FEDERATION_REASON_HEADER, "capabilities-unknown")
        .send({ error: "this instance has not yet verified what the peer runs; retry later" });
    }

    try {
      const result = await ingestFederatedPage(ctx.sql, page, {
        registry: ctx.registry,
        localInstanceId: ctx.localInstanceId,
        peerInstanceId: peerId,
        peerVersions,
        now: ctx.now(),
      });
      // A skipped entry is a malformed/unauthorized item inside an authenticated
      // page — a SCHEMA-class health signal, never a truth judgement about the
      // records that DID land.
      if (result.skipped.length > 0) {
        await recordPeerFailure(ctx.sql, peerId, "schema", ctx.now(), result.skipped.length);
      }
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof FederatedPageError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }
  });
}
