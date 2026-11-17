/**
 * Peer discovery through the federation registry: its TUF metadata is pulled
 * and verified (rollback, freeze, expiry and signature thresholds), and the
 * instances it lists join the configured peers (`PeerBook.discover`), the
 * operator's own record of a peer winning. A sync that fails verification
 * changes nothing: the peers of the last verified sync stay. The registry is
 * fetched through the egress guard the caller passes, without the client
 * certificate peers are shown: it is not a peer.
 */
import { type RegistrySyncResult, syncRegistry } from "@openconditions/federation";
import type { RegistrySettings } from "./config.js";
import type { PeerBook } from "./peer-book.js";

/** How long a failed sync waits before it tries again. */
export const REGISTRY_RETRY_MS = 60 * 60 * 1000;

/** Syncs `registry` through `fetchImpl` and has `peers` take what it lists, `self` left out. */
export async function syncRegistryPeers(
  peers: PeerBook,
  registry: RegistrySettings,
  self: string,
  now: string,
  fetchImpl: typeof fetch,
): Promise<RegistrySyncResult> {
  const result = await syncRegistry(
    { metadataUrl: registry.metadataUrl, targetsUrl: registry.targetsUrl },
    registry.root,
    { cacheDir: registry.cacheDir, previousPeers: [...peers.discovered()], now, fetchImpl },
  );
  peers.discover(result.peers, self);
  return result;
}
