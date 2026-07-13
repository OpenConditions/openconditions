/**
 * The authenticated peer-subscription surface: CRUD over
 * `/peer/subscriptions` plus the SSE live channel `/peer/stream`. Every request
 * is RFC-9421-signed by the caller's actor (T2), the `peerId` is derived from
 * the pinned `keyid` (T1 peers registry), and a peer may only see/modify its
 * OWN subscriptions.
 *
 * Push (webhook/sse) is a LATENCY optimization over the pull contract — the SSE
 * stream, like a webhook push, carries the outbox's composite `(txid, seq)`
 * cursor on every event, so a disconnected peer resumes from the last cursor it
 * saw (reconnect OR pull `/peer/outbox?after=<cursor>`) with no gap.
 *
 * The signed `@target-uri` is reconstructed from the instance's CONFIGURED
 * baseUrl (not the request Host), so a peer signs the logical actor URL and the
 * check is independent of proxies/loopback test sockets.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type postgres from "postgres";
import {
  authenticatePeerRequest,
  createSubscription,
  deleteSubscription,
  encodeOutboxCursor,
  federationFailureHeaders,
  getSubscription,
  listSubscriptions,
  readOutbox,
  updateSubscription,
  PRIORITY_EVENT_TYPES,
  SubscriptionValidationError,
  type CreateSubscriptionInput,
  type FederationSubscription,
  type NonceStore,
  type PeerRecord,
  type UpdateSubscriptionInput,
} from "@openconditions/federation";

const SUBSCRIPTIONS_PATH = "/peer/subscriptions";
const STREAM_PATH = "/peer/stream";

/** How often the SSE channel re-polls the outbox for new entries + heartbeats. */
const STREAM_POLL_MS = 3_000;

export interface SubscriptionRouteContext {
  sql: postgres.Sql;
  /** The pinned peers registry (settings.peers). */
  peers: PeerRecord[];
  /** The instance's configured base URL — the authority the signed target-uri uses. */
  baseUrl: string;
  /** Per-peer replay cache shared across the authenticated routes. */
  nonceStore: NonceStore;
  /** Injectable clock (ISO 8601). */
  now: () => string;
}

function headerStrings(headers: NodeJS.Dict<string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/** Authenticates the request; on failure sends the 401 and returns null. The
 *  caller returns immediately when this yields null. */
async function requirePeer(
  ctx: SubscriptionRouteContext,
  req: FastifyRequest,
  reply: FastifyReply,
  body?: Uint8Array
): Promise<string | null> {
  const auth = await authenticatePeerRequest(
    { peers: ctx.peers, nonceStore: ctx.nonceStore },
    {
      method: req.method,
      url: `${ctx.baseUrl}${req.url}`,
      headers: headerStrings(req.headers),
      ...(body !== undefined && body.byteLength > 0 ? { body } : {}),
    }
  );
  if (!auth.ok) {
    await reply.status(401).headers(federationFailureHeaders(auth.reason)).send({
      error: "federation request authentication failed",
      reason: auth.reason,
    });
    return null;
  }
  return auth.peerId;
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

export function registerSubscriptionRoutes(
  app: FastifyInstance,
  ctx: SubscriptionRouteContext
): void {
  // The signature must verify against the RECEIVED bytes, so keep the raw body
  // (the handlers parse the JSON themselves after authenticating).
  app.addContentTypeParser(
    ["application/json", "application/activity+json"],
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body)
  );

  app.post(SUBSCRIPTIONS_PATH, async (req, reply) => {
    const body = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
    const peerId = await requirePeer(ctx, req, reply, body);
    if (peerId === null) return reply;

    const parsed = parseJsonBody(reply, body);
    if (parsed === undefined) return reply;

    try {
      const subscription = await createSubscription(
        ctx.sql,
        peerId,
        parsed as CreateSubscriptionInput,
        ctx.now()
      );
      return reply.status(201).send(subscription);
    } catch (err) {
      if (err instanceof SubscriptionValidationError) {
        return reply.status(422).send({
          error: err.message,
          code: err.code,
          ...(err.recommended !== undefined ? { recommended: err.recommended } : {}),
        });
      }
      throw err;
    }
  });

  app.get(SUBSCRIPTIONS_PATH, async (req, reply) => {
    const peerId = await requirePeer(ctx, req, reply);
    if (peerId === null) return reply;
    const subscriptions = await listSubscriptions(ctx.sql, peerId);
    return reply.send({ subscriptions });
  });

  app.get<{ Params: { id: string } }>(`${SUBSCRIPTIONS_PATH}/:id`, async (req, reply) => {
    const peerId = await requirePeer(ctx, req, reply);
    if (peerId === null) return reply;
    const owned = await loadOwned(ctx, req.params.id, peerId, reply);
    if (owned === null) return reply;
    return reply.send(owned);
  });

  app.patch<{ Params: { id: string } }>(`${SUBSCRIPTIONS_PATH}/:id`, async (req, reply) => {
    const body = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
    const peerId = await requirePeer(ctx, req, reply, body);
    if (peerId === null) return reply;
    const parsed = parseJsonBody(reply, body);
    if (parsed === undefined) return reply;
    const owned = await loadOwned(ctx, req.params.id, peerId, reply);
    if (owned === null) return reply;

    try {
      const updated = await updateSubscription(
        ctx.sql,
        owned,
        parsed as UpdateSubscriptionInput,
        ctx.now()
      );
      return reply.send(updated);
    } catch (err) {
      if (err instanceof SubscriptionValidationError) {
        return reply.status(422).send({
          error: err.message,
          code: err.code,
          ...(err.recommended !== undefined ? { recommended: err.recommended } : {}),
        });
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>(`${SUBSCRIPTIONS_PATH}/:id`, async (req, reply) => {
    const peerId = await requirePeer(ctx, req, reply);
    if (peerId === null) return reply;
    const owned = await loadOwned(ctx, req.params.id, peerId, reply);
    if (owned === null) return reply;
    await deleteSubscription(ctx.sql, owned.id);
    return reply.status(204).send();
  });

  app.get<{ Querystring: { subscriptionId?: string } }>(STREAM_PATH, async (req, reply) => {
    const peerId = await requirePeer(ctx, req, reply);
    if (peerId === null) return reply;

    // SSE goes THROUGH the subscription model, never the raw query — so it
    // inherits the same fail-closed validation (an over-broad filter was already
    // refused at subscribe time) plus the subscription's priorityOnly gate. No
    // firehose over a push channel.
    const subscriptionId = req.query.subscriptionId;
    if (subscriptionId === undefined || subscriptionId.length === 0) {
      return reply.status(400).send({ error: "subscriptionId query parameter is required" });
    }
    const subscription = await loadOwned(ctx, subscriptionId, peerId, reply);
    if (subscription === null) return reply;

    const filter = subscription.filter;
    // The push-channel restriction (priority classes only) when priorityOnly, so
    // the SSE cursor advances over the priority subsequence exactly like webhook.
    const priorityClasses = subscription.priorityOnly ? PRIORITY_EVENT_TYPES : undefined;
    let cursor = subscription.cursor;

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const tick = async () => {
      try {
        const page = await readOutbox(ctx.sql, {
          after: cursor,
          filter,
          ...(priorityClasses !== undefined ? { priorityClasses } : {}),
          partOf: `${ctx.baseUrl}${STREAM_PATH}`,
          now: ctx.now(),
        });
        for (const entry of page.orderedItems) {
          const id = encodeOutboxCursor({ txid: entry.txid, seq: entry.seq });
          reply.raw.write(
            `event: condition\nid: ${id}\ndata: ${JSON.stringify({ cursor: id, entry })}\n\n`
          );
        }
        // Advance over the (push-channel-restricted) scanned frontier: the cursor
        // the peer resumes from stays on the priority subsequence, never past a
        // non-priority matching event (completeness is the peer's own pull).
        cursor = page.highWaterMark;
      } catch (err) {
        req.log.error(err, "[peer/stream] poll failed");
      }
    };

    await tick(); // initial snapshot from the subscription's cursor
    const poll = setInterval(() => void tick(), STREAM_POLL_MS);
    const heartbeat = setInterval(() => reply.raw.write(`: ping ${cursor}\n\n`), STREAM_POLL_MS);
    req.raw.on("close", () => {
      clearInterval(poll);
      clearInterval(heartbeat);
    });
    return reply;
  });
}

/** Loads a subscription and enforces ownership: 404 if missing, 403 if it
 *  belongs to another peer. Returns null (after sending) on either. */
async function loadOwned(
  ctx: SubscriptionRouteContext,
  id: string,
  peerId: string,
  reply: FastifyReply
): Promise<FederationSubscription | null> {
  const subscription = await getSubscription(ctx.sql, id);
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
