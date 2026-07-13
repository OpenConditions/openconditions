/**
 * Shared request-authentication helper for the authenticated peer surface
 * (subscriptions, SSE stream, inbox): RFC-9421 verification via the pinned
 * peers registry, with the signed `@target-uri` reconstructed from the
 * instance's CONFIGURED baseUrl (not the request Host), so a peer signs the
 * logical actor URL and the check is independent of proxies/loopback sockets.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  authenticatePeerRequest,
  federationFailureHeaders,
  type NonceStore,
  type PeerRecord,
} from "@openconditions/federation";

export interface PeerRequestContext {
  /** The pinned peers registry (settings.peers). */
  peers: PeerRecord[];
  /** The instance's configured base URL — the authority the signed target-uri uses. */
  baseUrl: string;
  /** Per-peer replay cache shared across the authenticated routes. */
  nonceStore: NonceStore;
}

export function headerStrings(headers: NodeJS.Dict<string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/** Authenticates the request; on failure sends the 401 and returns null. The
 *  caller returns immediately when this yields null. */
export async function requirePeer(
  ctx: PeerRequestContext,
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
