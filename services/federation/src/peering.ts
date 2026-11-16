/**
 * The periodic upkeep of each pinned peer: what its actor document
 * advertises, verified against its pin and negotiated (its records are
 * admitted against it), and the subscriptions this instance keeps there: a
 * webhook pushing to this inbox for a peer it subscribes to, a pull
 * subscription for a peer it pulls (a peer journals only what some
 * subscription wants). A peer is not asked for a delivery mode its actor
 * document does not offer; when the document could not be read this round,
 * it is asked all the same, and answers for itself.
 */
import {
  actorCapabilities,
  type EnsureSubscriptionOutcome,
  ensurePeerSubscription,
  loadSigningKey,
  type PeerVersions,
  refreshPeerCapabilities,
} from "@openconditions/federation";
import { schemaVersions } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import type postgres from "postgres";
import type { FederationSettings } from "./config.js";
import type { PeerBook } from "./peer-book.js";

export interface PeerUpkeep {
  peer: string;
  capabilities: PeerVersions;
  /** The webhook subscription, for a peer this instance subscribes to. */
  subscription?: EnsureSubscriptionOutcome;
  /** The pull subscription, for a peer this instance pulls. */
  pullSubscription?: EnsureSubscriptionOutcome;
}

/**
 * Refreshes every pinned peer once; one peer's failure never stops the
 * others. The keys a peer was seen to rotate to are trusted from then on.
 */
export async function refreshPeers(
  sql: postgres.Sql,
  settings: FederationSettings,
  peers: PeerBook,
  opts: { fetchImpl: typeof fetch; now: string },
): Promise<PeerUpkeep[]> {
  const actor = settings.actor!;
  const local = actorCapabilities(actor.capabilities, schemaVersions(productionRegistry()));
  const inboxUrl = `${actor.baseUrl.replace(/\/$/, "")}/peer/inbox`;
  const results: PeerUpkeep[] = [];
  for (const peer of peers.pinned()) {
    const capabilities = await refreshPeerCapabilities(sql, peer, {
      local,
      fetchImpl: opts.fetchImpl,
      now: opts.now,
      learned: peers.learned(peer.instanceId),
    }).catch((err: unknown) => ({ ok: false as const, reason: String(err) }));
    const result: PeerUpkeep = { peer: peer.instanceId, capabilities };
    if (peer.subscribe !== undefined || peer.pull !== undefined) {
      const signingKey = await loadSigningKey(sql, opts.now);
      const keep = async (
        want: Parameters<typeof ensurePeerSubscription>[1],
      ): Promise<EnsureSubscriptionOutcome> => {
        if (capabilities.ok && !capabilities.deliveryModes.includes(want.deliveryMode)) {
          return { ok: false, reason: `the peer does not offer ${want.deliveryMode} delivery` };
        }
        if (signingKey === undefined) {
          return { ok: false, reason: "this instance has no active signing key" };
        }
        return ensurePeerSubscription(peer, want, {
          signingKey,
          fetchImpl: opts.fetchImpl,
          now: opts.now,
        });
      };
      if (peer.subscribe !== undefined) {
        result.subscription = await keep({
          deliveryMode: "webhook",
          filter: peer.subscribe.filter,
          priorityOnly: peer.subscribe.priorityOnly ?? false,
          inboxUrl,
        });
      }
      if (peer.pull !== undefined) {
        result.pullSubscription = await keep({
          deliveryMode: "pull",
          filter: peer.pull.filter,
          priorityOnly: false,
          inboxUrl: null,
        });
      }
    }
    results.push(result);
  }
  await peers.reload(sql);
  return results;
}
