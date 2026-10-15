/**
 * The periodic upkeep of each pinned peer: what its actor document
 * advertises, verified against its pin and negotiated (its records are
 * admitted against it), and, for a peer this instance subscribes to, the
 * subscription that has the peer push its outbox to this inbox.
 */
import {
  type EnsureSubscriptionOutcome,
  ensurePeerSubscription,
  loadActiveKeys,
  type PeerVersions,
  refreshPeerCapabilities,
} from "@openconditions/federation";
import { schemaVersions } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import type postgres from "postgres";
import type { FederationSettings } from "./config.js";

export interface PeerUpkeep {
  peer: string;
  capabilities: PeerVersions;
  subscription?: EnsureSubscriptionOutcome;
}

/** Refreshes every pinned peer once; one peer's failure never stops the others. */
export async function refreshPeers(
  sql: postgres.Sql,
  settings: FederationSettings,
  opts: { fetchImpl: typeof fetch; now: string },
): Promise<PeerUpkeep[]> {
  const actor = settings.actor!;
  const local = { ...actor.capabilities, schemaVersions: schemaVersions(productionRegistry()) };
  const inboxUrl = `${actor.baseUrl.replace(/\/$/, "")}/peer/inbox`;
  const results: PeerUpkeep[] = [];
  for (const peer of settings.peers) {
    const capabilities = await refreshPeerCapabilities(sql, peer, {
      local,
      fetchImpl: opts.fetchImpl,
      now: opts.now,
    }).catch((err: unknown) => ({ ok: false as const, reason: String(err) }));
    const result: PeerUpkeep = { peer: peer.instanceId, capabilities };
    if (peer.subscribe !== undefined) {
      const [signingKey] = await loadActiveKeys(sql, opts.now);
      result.subscription =
        signingKey === undefined
          ? { ok: false, reason: "this instance has no active signing key" }
          : await ensurePeerSubscription(
              { ...peer, subscribe: peer.subscribe },
              { inboxUrl, signingKey, fetchImpl: opts.fetchImpl },
            );
    }
    results.push(result);
  }
  return results;
}
