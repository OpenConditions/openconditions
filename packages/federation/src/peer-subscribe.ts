/**
 * The subscribing side of peering: keeping this instance subscribed to a
 * pinned peer whose peers record asks to receive it.
 *
 * - `subscribe`: the peer pushes its outbox to this instance's inbox
 *   (`/peer/inbox`) by webhook, advancing its cursor only over pages this
 *   inbox accepted, so the push is gap-free while the subscription stays
 *   active. A subscription the peer turned `push_disabled` after failed
 *   deliveries, or one whose filter differs from the configured one, is
 *   patched back, which resumes the push where it stalled.
 * - `pull`: a `pull` subscription with the pull's filter, so the peer
 *   journals what this instance reads of its outbox (a peer journals only
 *   what some subscription wants).
 *
 * Every request is RFC-9421-signed with this instance's key, which the peer
 * verifies against its pin of this instance; the peer sees and changes only
 * this instance's own subscriptions. A response the peer signs is verified
 * against the pin of the peer ({@link verifyPeerResponse}).
 */
import { ACTOR_WELL_KNOWN_PATH } from "./actor.js";
import { type NonceStore, signMessage, verifyMessage } from "./http-signature.js";
import type { InstanceKey } from "./keys.js";
import { rawEd25519FromMultibase } from "./multibase.js";
import type { PeerRecord } from "./peers.js";
import type { RecordFilter } from "./record-filter.js";
import type { DeliveryMode, FederationSubscription } from "./subscriptions.js";

/** What a peers record asks the peer to push. */
export interface PeerSubscribe {
  /** The subscription's filter; the peer refuses one too broad to push. */
  filter: RecordFilter;
  /** Only the peer's priority entries (closures, incidents); default false. */
  priorityOnly?: boolean;
}

/** What a peers record asks to read of the peer's outbox by pull. */
export interface PeerPull {
  /** The filter of the pull and of the subscription that has the peer journal it. */
  filter: RecordFilter;
}

/** The subscription this instance wants at a peer. */
export interface WantedSubscription {
  deliveryMode: Exclude<DeliveryMode, "sse">;
  filter: RecordFilter;
  priorityOnly: boolean;
  /** The webhook's target; null for a pull subscription. */
  inboxUrl: string | null;
}

export type EnsureSubscriptionOutcome =
  | { ok: true; status: "created" | "updated" | "unchanged"; id: string }
  | { ok: false; reason: string };

/**
 * The URL of one of a peer's federation routes: its actor document is
 * served at `<base>/.well-known/openconditions/actor.json`, and its pin
 * requires the document's id to be that URL.
 */
export function peerRouteUrl(peer: Pick<PeerRecord, "actorUrl">, path: string): string {
  const base = peer.actorUrl.endsWith(ACTOR_WELL_KNOWN_PATH)
    ? peer.actorUrl.slice(0, -ACTOR_WELL_KNOWN_PATH.length)
    : new URL(peer.actorUrl).origin;
  return `${base}${path}`;
}

/** A value with its object keys sorted, so two filters compare by content. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Sends a request to a peer, signed with this instance's key. */
export async function signedPeerRequest(
  fetchImpl: typeof fetch,
  key: InstanceKey,
  method: string,
  url: string,
  body?: unknown,
): Promise<Response> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const signed = await signMessage({
    method,
    url,
    headers: payload === undefined ? {} : { "content-type": "application/json" },
    ...(payload === undefined ? {} : { body: payload }),
    keyId: key.keyId,
    privateKey: key.privateKey,
  });
  return fetchImpl(url, {
    method,
    headers: signed.headers,
    ...(payload === undefined ? {} : { body: payload }),
  });
}

/**
 * Whether a peer's response carries a valid signature under one of the keys
 * pinned for that peer, over the body as received.
 */
export async function verifyPeerResponse(
  peer: Pick<PeerRecord, "pinnedKeys">,
  res: { status: number; headers: Headers; body: Uint8Array; url: string },
  nonceStore: NonceStore,
): Promise<boolean> {
  const pins = new Set(peer.pinnedKeys);
  const headers: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const result = await verifyMessage({
    method: "GET",
    url: res.url,
    status: res.status,
    isResponse: true,
    headers,
    body: res.body,
    nonceStore,
    resolvePublicKey: async (keyId) => {
      if (!pins.has(keyId)) return null;
      try {
        return await globalThis.crypto.subtle.importKey(
          "raw",
          rawEd25519FromMultibase(keyId) as BufferSource,
          { name: "Ed25519" },
          true,
          ["verify"],
        );
      } catch {
        return null;
      }
    },
  });
  return result.ok;
}

async function failure(res: Response, what: string): Promise<{ ok: false; reason: string }> {
  const text = await res.text().catch(() => "");
  return { ok: false, reason: `${what} answered ${res.status}${text ? `: ${text}` : ""}` };
}

/** Whether a peer's subscription is the one wanted, as far as it is this instance's to say. */
const sameTarget = (held: FederationSubscription, want: WantedSubscription) =>
  held.deliveryMode === want.deliveryMode &&
  (want.deliveryMode === "pull" || held.inboxUrl === want.inboxUrl);

/**
 * Makes sure `peer` holds the subscription this instance wants: creates it
 * when the peer holds none of its mode (and, for a webhook, to this inbox),
 * patches one whose filter or priority differs or whose push the peer
 * disabled, and leaves a matching one alone. Never throws for the peer's
 * answer: a failure is returned with its reason.
 */
export async function ensurePeerSubscription(
  peer: PeerRecord,
  want: WantedSubscription,
  opts: { signingKey: InstanceKey; fetchImpl: typeof fetch },
): Promise<EnsureSubscriptionOutcome> {
  const url = peerRouteUrl(peer, "/peer/subscriptions");
  const desired = {
    filter: want.filter,
    deliveryMode: want.deliveryMode,
    ...(want.inboxUrl === null ? {} : { inboxUrl: want.inboxUrl }),
    priorityOnly: want.priorityOnly,
  };
  try {
    const listed = await signedPeerRequest(opts.fetchImpl, opts.signingKey, "GET", url);
    if (!listed.ok) return failure(listed, "listing the subscriptions");
    const { subscriptions } = (await listed.json()) as { subscriptions?: FederationSubscription[] };
    const held = (subscriptions ?? []).find((s) => sameTarget(s, want));
    if (held === undefined) {
      const created = await signedPeerRequest(
        opts.fetchImpl,
        opts.signingKey,
        "POST",
        url,
        desired,
      );
      if (created.status !== 201) return failure(created, "subscribing");
      const { id } = (await created.json()) as { id: string };
      return { ok: true, status: "created", id };
    }
    const same =
      held.status === "active" &&
      held.priorityOnly === want.priorityOnly &&
      JSON.stringify(canonical(held.filter)) === JSON.stringify(canonical(want.filter));
    if (same) return { ok: true, status: "unchanged", id: held.id };
    const patched = await signedPeerRequest(
      opts.fetchImpl,
      opts.signingKey,
      "PATCH",
      `${url}/${encodeURIComponent(held.id)}`,
      desired,
    );
    if (!patched.ok) return failure(patched, "updating the subscription");
    return { ok: true, status: "updated", id: held.id };
  } catch (err) {
    return { ok: false, reason: `the peer could not be reached: ${String(err)}` };
  }
}
