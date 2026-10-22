/**
 * The periodic upkeep of each pinned peer: what its actor document
 * advertises, verified against its pin and negotiated (its records are
 * admitted against it), and the subscriptions this instance keeps there: a
 * webhook pushing to this inbox for a peer it subscribes to, a pull
 * subscription for a peer it pulls (a peer journals only what some
 * subscription wants).
 */
import {
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
  const local = { ...actor.capabilities, schemaVersions: schemaVersions(productionRegistry()) };
  const inboxUrl = `${actor.baseUrl.replace(/\/$/, "")}/peer/inbox`;
  const results: PeerUpkeep[] = [];
  for (const peer of peers.all()) {
    const capabilities = await refreshPeerCapabilities(sql, peer, {
      local,
      fetchImpl: opts.fetchImpl,
      now: opts.now,
    }).catch((err: unknown) => ({ ok: false as const, reason: String(err) }));
    const result: PeerUpkeep = { peer: peer.instanceId, capabilities };
    if (peer.subscribe !== undefined || peer.pull !== undefined) {
      const signingKey = await loadSigningKey(sql, opts.now);
      const keep = (want: Parameters<typeof ensurePeerSubscription>[1]) =>
        signingKey === undefined
          ? Promise.resolve({
              ok: false as const,
              reason: "this instance has no active signing key",
            })
          : ensurePeerSubscription(peer, want, { signingKey, fetchImpl: opts.fetchImpl });
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
