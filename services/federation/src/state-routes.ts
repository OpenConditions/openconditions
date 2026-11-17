/**
 * GET /peer/state and POST /peer/records — the publisher's present state of
 * its records, for a subscriber to compare its copies with after its journal
 * cannot tell it enough: after the publisher's journal started over (a new
 * epoch, or a cursor ahead of it), and after a page said the subscriber's
 * cursor was beyond its window (deletes and erasures are in no archive).
 *
 * `/peer/state` lists the live records the outbox may carry to the requester,
 * filtered as its journal reads are, as `(id, revision, recordedAt)` in byte
 * order of their ids; `/peer/records` answers for named records with the
 * entry the journal would carry for each now (`readRecordState`,
 * `readRecords`). Both sit behind the gates `/peer/backfill` has: a signed
 * request from a pinned peer not blocked here (and mutual TLS when its pin
 * asks for it), one journal read of its tier's budget per request, and an
 * answer signed and bound to the request. They serve what the outbox serves
 * that peer, older than its journal window included: the window bounds the
 * journal, not what the peer may hold.
 */

import {
  FEDERATION_JSON,
  FEDERATION_REASON_HEADER,
  type InstanceKey,
  type MtlsContext,
  type NonceStore,
  type RateLimiter,
  readRecordState,
  readRecords,
  readRecordsRequest,
  recordPeerFailure,
  signMessage,
} from "@openconditions/federation";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { OutboxQueryError, parseStateQuery } from "./outbox-query.js";
import type { PeerBook } from "./peer-book.js";
import { headerStrings, requirePeer, respondIfBlocked } from "./peer-request.js";
import { warnWithheld } from "./withheld.js";

export const STATE_PATH = "/peer/state";
export const RECORDS_PATH = "/peer/records";

export interface StateRouteContext {
  sql: postgres.Sql;
  /** The pinned peers — the tier authority. */
  peers: PeerBook;
  /** The instance's configured base URL — the authority the signed target-uri uses. */
  baseUrl: string;
  /** Per-peer replay cache shared across the authenticated routes. */
  nonceStore: NonceStore;
  /** Loads the newest active signing key (self-healing a rotation). */
  signingKey: () => Promise<InstanceKey>;
  /** Shared per-peer transport rate limiter (inbox, backfill and outbox). */
  rateLimiter: RateLimiter;
  /** Resolves the request's TLS client-cert context for the optional mTLS gate. */
  mtlsContextFor?: (req: FastifyRequest) => MtlsContext | undefined;
  /** Injectable clock (ISO 8601). */
  now: () => string;
}

export function registerStateRoutes(app: FastifyInstance, ctx: StateRouteContext): void {
  /**
   * The peer a request is from, once it passed the gates and its journal-read
   * budget; null when an answer was sent.
   */
  async function admit(
    req: FastifyRequest,
    reply: FastifyReply,
    body?: Buffer,
  ): Promise<string | null> {
    const peerId = await requirePeer(ctx, req, reply, body);
    if (peerId === null) return null;
    if (await respondIfBlocked(ctx.sql, peerId, reply)) return null;
    const peer = ctx.peers.find(peerId);
    if (peer === undefined) {
      await reply.status(401).send({ error: "authenticated peer is not in the registry" });
      return null;
    }
    const rate = ctx.rateLimiter.check(
      peerId,
      "backfill",
      peer.trustTier,
      1,
      Date.parse(ctx.now()),
    );
    if (!rate.ok) {
      await recordPeerFailure(ctx.sql, peerId, "rate", ctx.now());
      await reply
        .status(429)
        .header("Retry-After", String(rate.retryAfterSec ?? 60))
        .header(FEDERATION_REASON_HEADER, "rate-limited")
        .send({ error: "journal read rate limit exceeded", retryAfterSec: rate.retryAfterSec });
      return null;
    }
    return peerId;
  }

  /** Sends `page` signed and bound to the request it answers. */
  async function sendSigned(req: FastifyRequest, reply: FastifyReply, page: unknown) {
    const key = await ctx.signingKey();
    const body = Buffer.from(JSON.stringify(page));
    const answered = {
      method: req.method,
      url: `${ctx.baseUrl}${req.url}`,
      headers: headerStrings(req.headers),
    };
    const signed = await signMessage({
      ...answered,
      headers: { "content-type": FEDERATION_JSON },
      body,
      keyId: key.keyId,
      privateKey: key.privateKey,
      isResponse: true,
      status: 200,
      request: answered,
    });
    return reply.status(200).headers(signed.headers).send(body);
  }

  app.get(STATE_PATH, async (req, reply) => {
    if ((await admit(req, reply)) === null) return reply;
    let parsed: ReturnType<typeof parseStateQuery>;
    try {
      parsed = parseStateQuery(req.query as Record<string, unknown>);
    } catch (err) {
      if (err instanceof OutboxQueryError) return reply.status(400).send({ error: err.message });
      throw err;
    }
    const page = await readRecordState(ctx.sql, {
      cls: parsed.cls,
      partOf: `${ctx.baseUrl}${STATE_PATH}`,
      now: ctx.now(),
      ...(parsed.after !== undefined ? { after: parsed.after } : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      ...(parsed.filter !== undefined ? { filter: parsed.filter } : {}),
      ...(parsed.nextParams !== undefined ? { nextParams: parsed.nextParams } : {}),
    });
    return sendSigned(req, reply, page);
  });

  app.post(RECORDS_PATH, async (req, reply) => {
    const body = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
    if ((await admit(req, reply, body)) === null) return reply;
    let request: unknown;
    try {
      request = JSON.parse(body.toString("utf8"));
    } catch {
      return reply.status(400).send({ error: "request body is not valid JSON" });
    }
    const asked = readRecordsRequest(request);
    if (!asked.ok) return reply.status(400).send({ error: asked.reason });
    const { page, withheld } = await readRecords(ctx.sql, {
      cls: asked.value.cls,
      ids: asked.value.ids,
      now: ctx.now(),
    });
    warnWithheld(withheld);
    return sendSigned(req, reply, page);
  });
}
