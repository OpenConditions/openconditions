/**
 * Shared request-authentication helper for the authenticated peer surface
 * (subscriptions, SSE stream, inbox): RFC-9421 verification via the pinned
 * peers registry, with the signed `@target-uri` reconstructed from the
 * instance's CONFIGURED baseUrl (not the request Host), so a peer signs the
 * logical actor URL and the check is independent of proxies/loopback sockets.
 */
import type { TLSSocket } from "node:tls";
import type { FastifyReply, FastifyRequest } from "fastify";
import type postgres from "postgres";
import {
  authenticatePeerRequest,
  checkMtls,
  federationFailureHeaders,
  isPeerBlocked,
  FEDERATION_REASON_HEADER,
  type FederationFailureReason,
  type MtlsContext,
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
  /**
   * Called when authentication fails, BEFORE the 401 is sent. `peerId` is set
   * only when the signature named a pinned peer's key (a replay or a
   * bad-signature under a pinned keyid) so the caller can attribute the failure
   * to that peer's HEALTH — never its event truth. A thrown/rejected hook is
   * swallowed: health accounting must never turn a 401 into a 500.
   */
  onAuthFailure?: (reason: FederationFailureReason, peerId: string | null) => void | Promise<void>;
  /**
   * Resolves the request's TLS client-certificate context for the optional
   * per-peer mTLS gate. Defaults to reading the verified client cert off the
   * request socket ({@link socketMtlsContext}); tests inject a resolver to
   * simulate a socket cert context under `app.inject`.
   */
  mtlsContextFor?: (req: FastifyRequest) => MtlsContext | undefined;
}

/**
 * Reads the TLS layer's client-certificate verdict off the request socket for
 * the mTLS gate. Returns undefined for a plain (non-TLS) socket — a request to
 * a `mtlsRequired` peer over such a socket then fails the gate. When TLS
 * terminates at a fronting proxy rather than this process, an operator supplies
 * a resolver ({@link PeerRequestContext.mtlsContextFor}) that reads the proxy's
 * verified-client-cert headers instead.
 */
export function socketMtlsContext(req: FastifyRequest): MtlsContext | undefined {
  const socket = req.socket as Partial<TLSSocket>;
  if (typeof socket.getPeerCertificate !== "function") return undefined;
  const cert = socket.getPeerCertificate();
  const fingerprint = cert?.fingerprint256 || cert?.fingerprint || undefined;
  return {
    authorized: socket.authorized === true,
    ...(fingerprint ? { fingerprint } : {}),
  };
}

/**
 * Enforces the operator federation block list. When `peerId` is blocked, sends a
 * 403 and returns true (the route returns immediately). A block is a TRANSPORT
 * control — it stops future requests and never re-judges the peer's already-
 * received events. Never called for an anonymous (null) caller.
 */
export async function respondIfBlocked(
  sql: postgres.Sql,
  peerId: string,
  reply: FastifyReply
): Promise<boolean> {
  if (await isPeerBlocked(sql, peerId)) {
    await reply.status(403).send({ error: "peer is blocked", reason: "blocked" });
    return true;
  }
  return false;
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
    if (ctx.onAuthFailure !== undefined) {
      try {
        await ctx.onAuthFailure(auth.reason, auth.peerId ?? null);
      } catch {
        // Health accounting is best-effort; never let it fail the request.
      }
    }
    await reply.status(401).headers(federationFailureHeaders(auth.reason)).send({
      error: "federation request authentication failed",
      reason: auth.reason,
    });
    return null;
  }

  // Optional per-peer mTLS gate, ADDITIVE under the (now-verified) signature: a
  // `mtlsRequired` peer must ALSO present a TLS-verified client cert. A
  // non-mTLS peer is unaffected. The gate runs only after the signature check
  // passes, so mTLS never substitutes for signing.
  const peer = ctx.peers.find((p) => p.instanceId === auth.peerId);
  if (peer !== undefined) {
    const cert =
      ctx.mtlsContextFor !== undefined ? ctx.mtlsContextFor(req) : socketMtlsContext(req);
    const mtls = checkMtls(peer, cert);
    if (!mtls.ok) {
      await reply
        .status(403)
        .headers({ [FEDERATION_REASON_HEADER]: mtls.reason! })
        .send({ error: "mutual TLS required for this peer", reason: mtls.reason });
      return null;
    }
  }
  return auth.peerId;
}

/**
 * Optionally authenticates a request. An UNSIGNED request yields
 * `{ peerId: null }` (anonymous — the caller applies the public/Tier-0 policy);
 * a validly-signed pinned peer yields its `peerId`; a present-but-INVALID
 * signature is a hard 401 (returns `{ rejected: true }` after sending, so a
 * peer that clearly intended to authenticate is never silently downgraded).
 */
export async function optionalPeer(
  ctx: PeerRequestContext,
  req: FastifyRequest,
  reply: FastifyReply,
  body?: Uint8Array
): Promise<{ peerId: string | null; rejected: boolean }> {
  const signed =
    req.headers["signature"] !== undefined || req.headers["signature-input"] !== undefined;
  if (!signed) return { peerId: null, rejected: false };
  const peerId = await requirePeer(ctx, req, reply, body);
  if (peerId === null) return { peerId: null, rejected: true };
  return { peerId, rejected: false };
}
