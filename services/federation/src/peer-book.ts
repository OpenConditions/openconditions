/**
 * The peers this instance federates with, as every route and job reads them:
 * the configured peers and those the registry's last verified sync found
 * (`mergePeerRecords`: the operator's record wins, and a peer in both trusts
 * both pin sets), each trusting beside its pins the keys it was seen to
 * rotate to (`federation_peer_key`) while the pin they lead back to stays.
 * A key two peers would claim is trusted for neither: a discovered peer's
 * key another peer pins is dropped, as is a learned key two peers learned.
 * Reloaded after each peer upkeep, so a key a peer rotated to is trusted
 * from then on.
 */
import {
  type KeyAnchors,
  loadLearnedKeys,
  mergePeerRecords,
  type PeerRecord,
  trustedKeys,
  withLearnedKeys,
} from "@openconditions/federation";
import type postgres from "postgres";

export class PeerBook {
  readonly #configured: readonly PeerRecord[];
  #discovered: readonly PeerRecord[] = [];
  #pinned: readonly PeerRecord[];
  #stored = new Map<string, KeyAnchors>();
  #learned = new Map<string, KeyAnchors>();
  #peers: readonly PeerRecord[];

  constructor(configured: readonly PeerRecord[]) {
    this.#configured = configured;
    this.#pinned = configured;
    this.#peers = configured;
  }

  /** A book of `configured`, with the keys learned so far. */
  static async load(sql: postgres.Sql, configured: readonly PeerRecord[]): Promise<PeerBook> {
    const book = new PeerBook(configured);
    await book.reload(sql);
    return book;
  }

  /** Reads the learned keys again. */
  async reload(sql: postgres.Sql): Promise<void> {
    this.#stored = await loadLearnedKeys(sql);
    this.#compose();
  }

  /**
   * Takes the peers a verified registry sync found, `self` (this instance's
   * own entry) left out. A peer only the registry names is served the public
   * tier, whatever tier its entry states: a wider window is the operator's
   * to grant, by configuring the peer.
   */
  discover(discovered: readonly PeerRecord[], self: string): void {
    const pinnedBy = new Map<string, string>();
    for (const peer of this.#configured) {
      for (const pin of peer.pinnedKeys) pinnedBy.set(pin, peer.instanceId);
    }
    this.#discovered = discovered
      .filter((peer) => peer.instanceId !== self)
      .map((peer) => ({
        ...peer,
        trustTier: 0 as const,
        pinnedKeys: peer.pinnedKeys.filter(
          (key) => (pinnedBy.get(key) ?? peer.instanceId) === peer.instanceId,
        ),
      }))
      .filter((peer) => peer.pinnedKeys.length > 0);
    this.#compose();
  }

  #compose(): void {
    this.#pinned = mergePeerRecords([...this.#configured], [...this.#discovered]);
    const trusted = new Map(
      this.#pinned.map((peer) => [
        peer.instanceId,
        trustedKeys(peer, this.#stored.get(peer.instanceId)),
      ]),
    );
    const claims = new Map<string, number>();
    for (const keys of trusted.values()) {
      for (const keyId of keys.keys()) claims.set(keyId, (claims.get(keyId) ?? 0) + 1);
    }
    this.#learned = new Map(
      this.#pinned.map((peer) => {
        const learned = [...trusted.get(peer.instanceId)!].filter(
          ([keyId]) => !peer.pinnedKeys.includes(keyId) && claims.get(keyId) === 1,
        );
        return [peer.instanceId, new Map(learned)];
      }),
    );
    this.#peers = this.#pinned.map((peer) =>
      withLearnedKeys(peer, this.#learned.get(peer.instanceId)),
    );
  }

  /** Every peer, trusting its pins and learned keys. */
  all(): readonly PeerRecord[] {
    return this.#peers;
  }

  find(instanceId: string): PeerRecord | undefined {
    return this.#peers.find((peer) => peer.instanceId === instanceId);
  }

  /** Every peer as pinned, by the operator or the registry: its pins alone. */
  pinned(): readonly PeerRecord[] {
    return this.#pinned;
  }

  /** The peers the registry's last verified sync found. */
  discovered(): readonly PeerRecord[] {
    return this.#discovered;
  }

  /** The keys learned of a peer that are trusted, with their anchors. */
  learned(instanceId: string): KeyAnchors {
    return this.#learned.get(instanceId) ?? new Map();
  }
}
