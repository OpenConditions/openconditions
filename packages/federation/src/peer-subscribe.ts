/**
 * The subscribing side of peering: keeping this instance subscribed to a
 * pinned peer whose peers record asks to receive it (`subscribe`). The peer
 * pushes its outbox to this instance's inbox (`/peer/inbox`) by webhook,
 * advancing its cursor only over pages this inbox accepted, so the push is
 * gap-free while the subscription stays active. A subscription the peer
 * turned `push_disabled` after failed deliveries, or one whose filter differs
 * from the configured one, is patched back, which resumes the push where it
 * stalled.
 *
 * Every request is RFC-9421-signed with this instance's key, which the peer
 * verifies against its pin of this instance; the peer sees and changes only
 * this instance's own subscriptions.
 */
import { ACTOR_WELL_KNOWN_PATH } from "./actor.js";
import { signMessage } from "./http-signature.js";
import type { InstanceKey } from "./keys.js";
import type { PeerRecord } from "./peers.js";
import type { RecordFilter } from "./record-filter.js";
import type { FederationSubscription } from "./subscriptions.js";

/** What a peers record asks of the peer's outbox. */
export interface PeerSubscribe {
  /** The subscription's filter; the peer refuses one too broad to push. */
  filter: RecordFilter;
  /** Only the peer's priority entries (closures, incidents); default false. */
  priorityOnly?: boolean;
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

async function signedRequest(
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

async function failure(res: Response, what: string): Promise<{ ok: false; reason: string }> {
  const text = await res.text().catch(() => "");
  return { ok: false, reason: `${what} answered ${res.status}${text ? `: ${text}` : ""}` };
}

/**
 * Makes sure `peer` pushes to `inboxUrl` what its peers record asks for:
 * creates the webhook subscription when the peer holds none to this inbox,
 * patches one whose filter or priority differs or whose push the peer
 * disabled, and leaves a matching one alone. Never throws for the peer's
 * answer: a failure is returned with its reason.
 */
export async function ensurePeerSubscription(
  peer: PeerRecord & { subscribe: PeerSubscribe },
  opts: { inboxUrl: string; signingKey: InstanceKey; fetchImpl: typeof fetch },
): Promise<EnsureSubscriptionOutcome> {
  const url = peerRouteUrl(peer, "/peer/subscriptions");
  const desired = {
    filter: peer.subscribe.filter,
    deliveryMode: "webhook" as const,
    inboxUrl: opts.inboxUrl,
    priorityOnly: peer.subscribe.priorityOnly ?? false,
  };
  try {
    const listed = await signedRequest(opts.fetchImpl, opts.signingKey, "GET", url);
    if (!listed.ok) return failure(listed, "listing the subscriptions");
    const { subscriptions } = (await listed.json()) as { subscriptions?: FederationSubscription[] };
    const held = (subscriptions ?? []).find(
      (s) => s.deliveryMode === "webhook" && s.inboxUrl === opts.inboxUrl,
    );
    if (held === undefined) {
      const created = await signedRequest(opts.fetchImpl, opts.signingKey, "POST", url, desired);
      if (created.status !== 201) return failure(created, "subscribing");
      const { id } = (await created.json()) as { id: string };
      return { ok: true, status: "created", id };
    }
    const same =
      held.status === "active" &&
      held.priorityOnly === desired.priorityOnly &&
      JSON.stringify(canonical(held.filter)) === JSON.stringify(canonical(desired.filter));
    if (same) return { ok: true, status: "unchanged", id: held.id };
    const patched = await signedRequest(
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
