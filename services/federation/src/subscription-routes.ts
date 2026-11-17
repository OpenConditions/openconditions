/**
 * The authenticated peer-subscription surface: CRUD over
 * `/peer/subscriptions` plus the SSE live channel `/peer/stream`. Every request
 * is RFC-9421-signed by the caller's actor (T2), the `peerId` is derived from
 * the pinned `keyid` (T1 peers registry), and a peer may only see/modify its
 * OWN subscriptions.
 *
 * Push (webhook/sse) is a LATENCY optimization over the pull contract. The SSE
 * stream carries the outbox's composite `(txid, seq)` cursor as every event's
 * id, and never stores how far it got: server-sent events have no
 * acknowledgement, so it cannot know what arrived. The client holds the
 * cursor. A reconnect names the last one it saw (`after`, or the
 * `Last-Event-ID` an EventSource sends) and resumes after it; without one
 * the stream starts at the subscription's stored cursor. The first event
 * states the journal's epoch and where the stream starts, so the client keeps
 * the epoch with the cursor as a pull subscriber does.
 *
 * The signed `@target-uri` is reconstructed from the instance's CONFIGURED
 * baseUrl (not the request Host), so a peer signs the logical actor URL and the
 * check is independent of proxies/loopback test sockets.
 */

import {
  type CreateSubscriptionInput,
  createSubscription,
  decodeOutboxCursor,
  deleteSubscription,
  encodeOutboxCursor,
  type FederationSubscription,
  getSubscription,
  type InboxHosts,
  listSubscriptions,
  type MtlsContext,
  type NonceStore,
  OUTBOX_CURSOR_START,
  readCursorStanding,
  readOutbox,
  SubscriptionConflictError,
  SubscriptionValidationError,
  type UpdateSubscriptionInput,
  updateSubscription,
} from "@openconditions/federation";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { backfillFloorIso } from "./backfill.js";
import type { PeerBook } from "./peer-book.js";
import { requirePeer, respondIfBlocked } from "./peer-request.js";
import { SseStreamPump } from "./stream-pump.js";
import { warnWithheld } from "./withheld.js";

const SUBSCRIPTIONS_PATH = "/peer/subscriptions";
const STREAM_PATH = "/peer/stream";

/** The stream's query: the subscription, and optionally the cursor to resume after. */
interface StreamQuery {
  subscriptionId?: string;
  after?: string;
}

/** How often the SSE channel re-polls the outbox for new entries + heartbeats. */
const STREAM_POLL_MS = 3_000;

/** The most entries one SSE tick serialises, so a slow peer never makes a single
 *  poll build an unbounded page (capped at the outbox max page size). */
const STREAM_TICK_LIMIT = 500;

export interface SubscriptionRouteContext {
  sql: postgres.Sql;
  /** The pinned peers, as they are trusted now. */
  peers: PeerBook;
  /** The instance's configured base URL — the authority the signed target-uri uses. */
  baseUrl: string;
  /** Per-peer replay cache shared across the authenticated routes. */
  nonceStore: NonceStore;
  /** Resolves the request's TLS client-cert context for the optional mTLS gate. */
  mtlsContextFor?: (req: FastifyRequest) => MtlsContext | undefined;
  /** Injectable clock (ISO 8601). */
  now: () => string;
  /** Tier-2 window override in seconds (see backfillWindowForTier). */
  governanceWindowSec?: number;
  /** Called once a subscription was created or changed: what it wants may need journalling. */
  onSubscribed?: () => void;
  /** Private hosts this instance may reach (OPENCONDITIONS_EGRESS_ALLOWED_HOSTS): a
   *  peer's webhook inbox may be on its own one. */
  allowedHosts?: ReadonlySet<string>;
}

/** Where `peerId`'s webhook inbox may sit among the private hosts: on its own. */
function inboxHostsOf(ctx: SubscriptionRouteContext, peerId: string): InboxHosts | undefined {
  if (ctx.allowedHosts === undefined) return undefined;
  const actorUrl = ctx.peers.find(peerId)?.actorUrl;
  return { allowedHosts: ctx.allowedHosts, ...(actorUrl !== undefined ? { actorUrl } : {}) };
}

/** Parses the request's buffered body as JSON, or 400s. Returns undefined on failure. */
function parseJsonBody(reply: FastifyReply, body: Buffer): Record<string, unknown> | undefined {
  if (body.byteLength === 0) return {};
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      void reply.status(400).send({ error: "request body must be a JSON object" });
      return undefined;
    }
    return value as Record<string, unknown>;
  } catch {
    void reply.status(400).send({ error: "request body is not valid JSON" });
    return undefined;
  }
}

/**
 * Answers a create or update the subscription rules refuse: 422 for a
 * filter or target that is not allowed, 409 naming the subscription the peer
 * already holds for the target. False for any other error.
 */
function sendRefusal(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof SubscriptionConflictError) {
    void reply.status(409).send({ error: err.message, existingId: err.existingId });
    return true;
  }
  if (err instanceof SubscriptionValidationError) {
    void reply.status(422).send({
      error: err.message,
      code: err.code,
      ...(err.recommended !== undefined ? { recommended: err.recommended } : {}),
    });
    return true;
  }
  return false;
}

export function registerSubscriptionRoutes(
  app: FastifyInstance,
  ctx: SubscriptionRouteContext,
): void {
  app.post(SUBSCRIPTIONS_PATH, async (req, reply) => {
    const body = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
    const peerId = await requirePeer(ctx, req, reply, body);
    if (peerId === null) return reply;
    if (await respondIfBlocked(ctx.sql, peerId, reply)) return reply;

    const parsed = parseJsonBody(reply, body);
    if (parsed === undefined) return reply;

    try {
      const subscription = await createSubscription(
        ctx.sql,
        peerId,
        parsed as CreateSubscriptionInput,
        ctx.now(),
        inboxHostsOf(ctx, peerId),
      );
      ctx.onSubscribed?.();
      return reply.status(201).send(subscription);
    } catch (err) {
      if (sendRefusal(reply, err)) return reply;
      throw err;
    }
  });

  app.get(SUBSCRIPTIONS_PATH, async (req, reply) => {
    const peerId = await requirePeer(ctx, req, reply);
    if (peerId === null) return reply;
    if (await respondIfBlocked(ctx.sql, peerId, reply)) return reply;
    const subscriptions = await listSubscriptions(ctx.sql, peerId, ctx.now());
    return reply.send({ subscriptions });
  });

  app.get<{ Params: { id: string } }>(`${SUBSCRIPTIONS_PATH}/:id`, async (req, reply) => {
    const peerId = await requirePeer(ctx, req, reply);
    if (peerId === null) return reply;
    if (await respondIfBlocked(ctx.sql, peerId, reply)) return reply;
    const owned = await loadOwned(ctx, req.params.id, peerId, reply);
    if (owned === null) return reply;
    return reply.send(owned);
  });

  app.patch<{ Params: { id: string } }>(`${SUBSCRIPTIONS_PATH}/:id`, async (req, reply) => {
    const body = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
    const peerId = await requirePeer(ctx, req, reply, body);
    if (peerId === null) return reply;
    if (await respondIfBlocked(ctx.sql, peerId, reply)) return reply;
    const parsed = parseJsonBody(reply, body);
    if (parsed === undefined) return reply;
    const owned = await loadOwned(ctx, req.params.id, peerId, reply);
    if (owned === null) return reply;

    try {
      const updated = await updateSubscription(
        ctx.sql,
        owned,
        parsed as UpdateSubscriptionInput,
        ctx.now(),
        inboxHostsOf(ctx, peerId),
      );
      ctx.onSubscribed?.();
      return reply.send(updated);
    } catch (err) {
      if (sendRefusal(reply, err)) return reply;
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>(`${SUBSCRIPTIONS_PATH}/:id`, async (req, reply) => {
    const peerId = await requirePeer(ctx, req, reply);
    if (peerId === null) return reply;
    if (await respondIfBlocked(ctx.sql, peerId, reply)) return reply;
    const owned = await loadOwned(ctx, req.params.id, peerId, reply);
    if (owned === null) return reply;
    await deleteSubscription(ctx.sql, owned.id);
    return reply.status(204).send();
  });

  app.get<{ Querystring: StreamQuery }>(STREAM_PATH, async (req, reply) => {
    const peerId = await requirePeer(ctx, req, reply);
    if (peerId === null) return reply;
    if (await respondIfBlocked(ctx.sql, peerId, reply)) return reply;

    // SSE goes THROUGH the subscription model, never the raw query — so it
    // inherits the same fail-closed validation (an over-broad filter was already
    // refused at subscribe time) plus the subscription's priorityOnly gate. No
    // firehose over a push channel.
    const subscriptionId = req.query.subscriptionId;
    if (subscriptionId === undefined || subscriptionId.length === 0) {
      return reply.status(400).send({ error: "subscriptionId query parameter is required" });
    }
    // The cursor the client resumes after: `after` (part of the signed target
    // URI), else the Last-Event-ID an EventSource sends when it reconnects.
    const resumeAfter = req.query.after ?? req.headers["last-event-id"];
    if (
      resumeAfter !== undefined &&
      (typeof resumeAfter !== "string" || decodeOutboxCursor(resumeAfter) === null)
    ) {
      return reply.status(400).send({ error: 'the cursor must be a "<txid>.<seq>" cursor' });
    }
    const subscription = await loadOwned(ctx, subscriptionId, peerId, reply);
    if (subscription === null) return reply;

    const filter = subscription.filter;
    // The push-channel restriction (priority entries only) when priorityOnly, so
    // the SSE cursor advances over the priority subsequence exactly like webhook.
    const priorityOnly = subscription.priorityOnly;
    // The tier CEILING is uniform across all three journal channels: the SSE
    // snapshot + live loop are floored to the requesting peer's tier window
    // (from the PINNED record, never a client field), exactly like /peer/outbox
    // and /peer/backfill. The minCreatedAt floor is the effective start-cursor
    // clamp — even from a stored cursor of 0.0, an entry older than the window is
    // never scanned, so a Tier-0 peer cannot replay pre-24h history over SSE.
    const tier = ctx.peers.find(peerId)?.trustTier ?? 0;

    // A cursor ahead of the journal belongs to a history the database no
    // longer has: the stream starts from the beginning and says so, and the
    // client resets its cursor as a pull subscriber would.
    const requested = resumeAfter ?? subscription.cursor;
    const standing = await readCursorStanding(ctx.sql, requested);
    const start = standing.cursorAhead ? encodeOutboxCursor(OUTBOX_CURSOR_START) : requested;

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const journal = {
      epoch: standing.epoch,
      cursor: start,
      ...(standing.cursorAhead ? { cursorAhead: true } : {}),
    };
    reply.raw.write(`event: journal\ndata: ${JSON.stringify(journal)}\n\n`);

    // The pump owns the cursor + backpressure state. It reads a limit-capped,
    // filter/tier-scoped page each tick and advances the cursor ONLY over frames
    // it actually wrote — a paused (buffer-full) tick re-reads its remainder next
    // time, so no entry is skipped and the (txid,seq) semantics are unchanged.
    const pump = new SseStreamPump(
      {
        readPage: async (after) => {
          const read = await readOutbox(ctx.sql, {
            after,
            filter,
            ...(priorityOnly ? { priorityOnly } : {}),
            minCreatedAt: backfillFloorIso(tier, ctx.now(), ctx.governanceWindowSec),
            partOf: `${ctx.baseUrl}${STREAM_PATH}`,
            limit: STREAM_TICK_LIMIT,
            now: ctx.now(),
          });
          warnWithheld(read.withheld);
          return read;
        },
        writer: {
          write: (frame) => reply.raw.write(frame),
          onceDrain: (listener) => reply.raw.once("drain", listener),
        },
        formatEntry: (entry) => {
          const id = encodeOutboxCursor({ txid: entry.txid, seq: entry.seq });
          const event = entry.operation === "liveness" ? "liveness" : "record";
          return `event: ${event}\nid: ${id}\ndata: ${JSON.stringify({ cursor: id, entry })}\n\n`;
        },
        onError: (err) => req.log.error(err, "[peer/stream] poll failed"),
      },
      start,
    );

    await pump.tick(); // initial snapshot from the start cursor
    const poll = setInterval(() => void pump.tick(), STREAM_POLL_MS);
    // The heartbeat stands down while paused or while the socket already needs a
    // drain, so an idle journal + a stalled peer cannot buffer pings unboundedly
    // (the exact backpressure class the pump guards for data frames).
    const heartbeat = setInterval(() => {
      if (!pump.isPaused && !reply.raw.writableNeedDrain) {
        reply.raw.write(`: ping ${pump.currentCursor}\n\n`);
      }
    }, STREAM_POLL_MS);
    req.raw.on("close", () => {
      pump.stop();
      clearInterval(poll);
      clearInterval(heartbeat);
    });
    return reply;
  });
}

/** Loads a subscription and enforces ownership: 404 if missing or its lease
 *  ran out, 403 if it belongs to another peer. Returns null (after sending)
 *  on either. */
async function loadOwned(
  ctx: SubscriptionRouteContext,
  id: string,
  peerId: string,
  reply: FastifyReply,
): Promise<FederationSubscription | null> {
  const subscription = await getSubscription(ctx.sql, id, ctx.now());
  if (subscription === null) {
    await reply.status(404).send({ error: "subscription not found" });
    return null;
  }
  if (subscription.peerId !== peerId) {
    await reply.status(403).send({ error: "subscription belongs to another peer" });
    return null;
  }
  return subscription;
}
