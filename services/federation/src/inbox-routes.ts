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
 * webhook push and the pull outbox serve); each event lands through the ONE
 * federated ingest path (`@openconditions/contributions-api/federation/
 * ingest`), so webhook push and consumer pull share the same trust boundary.
 *
 * Rate limiting here is a basic per-peer events-per-minute cap (fixed window);
 * the full peer-budget policy is a later task's surface.
 */
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import type { NonceStore, PeerRecord } from "@openconditions/federation";
import {
  FederatedPageError,
  ingestFederatedPage,
} from "@openconditions/contributions-api/federation/ingest";
import { requirePeer } from "./peer-request.js";

const INBOX_PATH = "/peer/inbox";

/** Default per-peer inbox budget: events accepted per fixed one-minute window. */
export const INBOX_DEFAULT_MAX_EVENTS_PER_MINUTE = 600;

export interface InboxRouteContext {
  sql: postgres.Sql;
  /** The pinned peers registry (settings.peers). */
  peers: PeerRecord[];
  /** The instance's configured base URL — the authority the signed target-uri uses. */
  baseUrl: string;
  /** This instance's own id (threaded into the ingest's local-row ownership rules). */
  localInstanceId: string;
  /** Per-peer replay cache shared across the authenticated routes. */
  nonceStore: NonceStore;
  /** Injectable clock (ISO 8601). */
  now: () => string;
  /** Per-peer events-per-minute cap; default {@link INBOX_DEFAULT_MAX_EVENTS_PER_MINUTE}. */
  maxEventsPerMinute?: number;
}

interface RateWindow {
  windowStartMs: number;
  count: number;
}

const WINDOW_MS = 60_000;

/** Per-peer fixed-window event budget. Returns false when the page would
 *  exceed the cap (the page is refused whole — the peer retries after the
 *  window; nothing was ingested, so its cursor does not advance). */
function admit(
  windows: Map<string, RateWindow>,
  peerId: string,
  events: number,
  cap: number,
  nowMs: number
): boolean {
  const current = windows.get(peerId);
  if (current === undefined || nowMs - current.windowStartMs >= WINDOW_MS) {
    if (events > cap) return false;
    windows.set(peerId, { windowStartMs: nowMs, count: events });
    return true;
  }
  if (current.count + events > cap) return false;
  current.count += events;
  return true;
}

export function registerInboxRoutes(app: FastifyInstance, ctx: InboxRouteContext): void {
  const cap = ctx.maxEventsPerMinute ?? INBOX_DEFAULT_MAX_EVENTS_PER_MINUTE;
  const windows = new Map<string, RateWindow>();

  app.post(INBOX_PATH, async (req, reply) => {
    const body = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
    const peerId = await requirePeer(ctx, req, reply, body);
    if (peerId === null) return reply;

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

    if (!admit(windows, peerId, items.length, cap, Date.parse(ctx.now()))) {
      return reply.status(429).send({
        error: `inbox rate limit exceeded (${cap} events/minute per peer)`,
      });
    }

    try {
      const result = await ingestFederatedPage(ctx.sql, page, {
        localInstanceId: ctx.localInstanceId,
        peerInstanceId: peerId,
        now: ctx.now(),
      });
      return reply.status(200).send({
        accepted: result.accepted,
        resupplied: result.resupplied,
        skipped: result.skipped,
        maxCursor: result.maxCursor,
      });
    } catch (err) {
      if (err instanceof FederatedPageError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }
  });
}
