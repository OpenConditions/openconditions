/**
 * Daily registry discovery: pull the registry's TUF metadata, verify it
 * (tuf/verify.ts — rollback/freeze/expiry/threshold protection), and
 * reconcile the discovered peer list against what the instance already knew.
 *
 * Cadence: registry discovery syncs DAILY (the DMFR-style catalog cadence) —
 * deliberately distinct from the 30–60 s live-outbox polling loop. The
 * scheduling itself (cron/interval) belongs to the federation service; this
 * module is the sync-and-verify function it calls.
 *
 * Trust composition: a peer's runtime key is trusted iff it matches the
 * operator's out-of-band bilateral pin OR chains to a TUF-authorized registry
 * key — {@link mergePeerRecords} builds exactly that union, and the existing
 * T1 `verifyActorAgainstPin` then enforces it at runtime. The bilateral pin
 * needs no registry at all (the bootstrap path for the first peers), and the
 * operator's own pin/config always wins over registry-discovered values.
 */
import type { PeerRecord } from "./peers.js";
import { registryToPeerRecords, type RegistryEntry } from "./registry.js";
import {
  verifyRegistryMetadata,
  type RegistryRepoSource,
  type VerifyRegistryOptions,
} from "./tuf/verify.js";

/** Registry discovery cadence — daily, NOT the live-outbox polling interval. */
export const REGISTRY_SYNC_INTERVAL_HOURS = 24;

export interface RegistrySyncOptions extends VerifyRegistryOptions {
  /** The peer records from the previous sync, for reconciliation. */
  previousPeers?: PeerRecord[];
  /** Timestamp recorded as `syncedAt`; defaults to the current time. */
  now?: string;
}

export interface RegistrySyncResult {
  syncedAt: string;
  /** The verified registry entries, sorted by id. */
  entries: RegistryEntry[];
  /** The registry entries mapped to T1 peer records (keys → pinnedKeys). */
  peers: PeerRecord[];
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
}

function peersEqual(a: PeerRecord, b: PeerRecord): boolean {
  return (
    a.actorUrl === b.actorUrl &&
    a.trustTier === b.trustTier &&
    JSON.stringify([...a.pinnedKeys].sort()) === JSON.stringify([...b.pinnedKeys].sort()) &&
    JSON.stringify(a.coverage ?? null) === JSON.stringify(b.coverage ?? null)
  );
}

/**
 * Pulls and TUF-verifies the registry from `source`, then reconciles the
 * discovered peers against `previousPeers`. Throws (instead of returning a
 * degraded result) whenever verification fails — the caller keeps the
 * previous peer set and alerts, it never proceeds on unverified data.
 */
export async function syncRegistry(
  source: string | RegistryRepoSource,
  trustedRoot: Buffer | Uint8Array | string,
  options: RegistrySyncOptions
): Promise<RegistrySyncResult> {
  const entries = await verifyRegistryMetadata(source, trustedRoot, options);
  const peers = registryToPeerRecords(entries);
  const previous = new Map(
    (options.previousPeers ?? []).map((peer) => [peer.instanceId, peer] as const)
  );

  const added: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const peer of peers) {
    const before = previous.get(peer.instanceId);
    if (!before) added.push(peer.instanceId);
    else if (peersEqual(before, peer)) unchanged.push(peer.instanceId);
    else changed.push(peer.instanceId);
  }
  const current = new Set(peers.map((peer) => peer.instanceId));
  const removed = [...previous.keys()].filter((instanceId) => !current.has(instanceId));

  return {
    syncedAt: options.now ?? new Date().toISOString(),
    entries,
    peers,
    added,
    removed,
    changed,
    unchanged,
  };
}

/**
 * Merges operator-configured bilateral peers with registry-discovered ones.
 * For a peer present in both, the bilateral record's actorUrl, trust tier,
 * and coverage win (the operator's out-of-band knowledge outranks the
 * registry) and the pinned-key set becomes the UNION of the bilateral pins
 * and the TUF-authorized registry keys — a runtime key is then trusted if it
 * matches either anchor. Registry-only peers are appended after the
 * bilateral ones.
 */
export function mergePeerRecords(bilateral: PeerRecord[], discovered: PeerRecord[]): PeerRecord[] {
  const discoveredById = new Map(discovered.map((peer) => [peer.instanceId, peer] as const));
  const merged: PeerRecord[] = bilateral.map((peer) => {
    const fromRegistry = discoveredById.get(peer.instanceId);
    if (!fromRegistry) return { ...peer, pinnedKeys: [...peer.pinnedKeys] };
    const union = [...peer.pinnedKeys];
    for (const key of fromRegistry.pinnedKeys) {
      if (!union.includes(key)) union.push(key);
    }
    return { ...peer, pinnedKeys: union };
  });
  const bilateralIds = new Set(bilateral.map((peer) => peer.instanceId));
  for (const peer of discovered) {
    if (!bilateralIds.has(peer.instanceId)) {
      merged.push({ ...peer, pinnedKeys: [...peer.pinnedKeys] });
    }
  }
  return merged;
}
