/**
 * Authenticates an inbound RFC-9421-signed peer request against the pinned
 * peers registry, deriving the caller's `peerId` from the signature `keyid`.
 *
 * The trust anchor is the bilateral pin (T1 peers.ts): a peer signs with its
 * instance key whose `keyId` IS its publicKeyMultibase, which the local operator
 * has pinned in `pinnedKeys`. So the `keyid` on the signature must match a
 * pinned key; that key is imported to an Ed25519 verify handle and the RFC 9421
 * message signature verified (T2 verifyMessage) — proving key POSSESSION, not
 * just listing. The matched peer's `instanceId` is the authenticated `peerId`.
 *
 * A request whose signature fails, whose `keyid` is not pinned by any peer, or
 * whose key is malformed is rejected with a {@link FederationFailureReason} the
 * route turns into a 401 with the `Federation-Reason` header.
 */
import type { FederationFailureReason, NonceStore } from "./http-signature.js";
import { verifyMessage } from "./http-signature.js";
import { rawEd25519FromMultibase } from "./multibase.js";
import type { PeerRecord } from "./peers.js";

const ED25519 = { name: "Ed25519" } as const;

export interface PeerAuthContext {
  /** The pinned peers registry (settings.peers). */
  peers: PeerRecord[];
  /** Per-peer replay cache, keyed by keyid. */
  nonceStore: NonceStore;
  /** Verification clock in Unix seconds; defaults to now. */
  now?: number;
}

export interface PeerAuthRequest {
  method: string;
  /** The absolute target URI the signature covers (`@target-uri`). */
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export type PeerAuthResult =
  | { ok: true; peerId: string; keyId: string }
  | { ok: false; reason: FederationFailureReason };

/**
 * Verifies the signature and resolves the authenticated peer. Builds a
 * keyid→peer index over every peer's pinned keys, imports the matched key, and
 * captures which peer owned it so a successful verification returns its
 * `peerId`. An unpinned/malformed keyid resolves to no key (`unknown-key`).
 */
export async function authenticatePeerRequest(
  ctx: PeerAuthContext,
  req: PeerAuthRequest
): Promise<PeerAuthResult> {
  const pinToPeer = new Map<string, PeerRecord>();
  for (const peer of ctx.peers) {
    for (const pin of peer.pinnedKeys) {
      if (!pinToPeer.has(pin)) pinToPeer.set(pin, peer);
    }
  }

  let matchedPeer: PeerRecord | undefined;
  const resolvePublicKey = async (keyId: string): Promise<CryptoKey | null> => {
    const peer = pinToPeer.get(keyId);
    if (peer === undefined) return null;
    let raw: Uint8Array;
    try {
      raw = rawEd25519FromMultibase(keyId);
    } catch {
      return null;
    }
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      raw as BufferSource,
      ED25519,
      true,
      ["verify"]
    );
    matchedPeer = peer;
    return key;
  };

  const result = await verifyMessage({
    method: req.method,
    url: req.url,
    headers: req.headers,
    ...(req.body !== undefined ? { body: req.body } : {}),
    resolvePublicKey,
    nonceStore: ctx.nonceStore,
    ...(ctx.now !== undefined ? { now: ctx.now } : {}),
  });

  if (!result.ok) return { ok: false, reason: result.reason ?? "bad-signature" };
  if (matchedPeer === undefined) return { ok: false, reason: "unknown-key" };
  return { ok: true, peerId: matchedPeer.instanceId, keyId: result.keyId! };
}
