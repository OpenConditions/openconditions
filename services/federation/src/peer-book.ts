/**
 * The peers this instance federates with, as every route and job reads them:
 * the configured peers, each trusting beside its pins the keys it was seen to
 * rotate to (`federation_peer_key`) while the pin they lead back to stays
 * configured. A key two peers would claim is trusted for neither. Reloaded
 * after each peer upkeep, so a key a peer rotated to is trusted from then on.
 */
import {
  type KeyAnchors,
  loadLearnedKeys,
  type PeerRecord,
  trustedKeys,
  withLearnedKeys,
} from "@openconditions/federation";
import type postgres from "postgres";

export class PeerBook {
  readonly #configured: readonly PeerRecord[];
  #learned = new Map<string, KeyAnchors>();
  #peers: readonly PeerRecord[];

  constructor(configured: readonly PeerRecord[]) {
    this.#configured = configured;
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
    const stored = await loadLearnedKeys(sql);
    const trusted = new Map(
      this.#configured.map((peer) => [
        peer.instanceId,
        trustedKeys(peer, stored.get(peer.instanceId)),
      ]),
    );
    const claims = new Map<string, number>();
    for (const keys of trusted.values()) {
      for (const keyId of keys.keys()) claims.set(keyId, (claims.get(keyId) ?? 0) + 1);
    }
    this.#learned = new Map(
      this.#configured.map((peer) => {
        const learned = [...trusted.get(peer.instanceId)!].filter(
          ([keyId]) => !peer.pinnedKeys.includes(keyId) && claims.get(keyId) === 1,
        );
        return [peer.instanceId, new Map(learned)];
      }),
    );
    this.#peers = this.#configured.map((peer) =>
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

  /** Every peer as configured: its pins alone. */
  configured(): readonly PeerRecord[] {
    return this.#configured;
  }

  /** The keys learned of a peer that are trusted, with their anchors. */
  learned(instanceId: string): KeyAnchors {
    return this.#learned.get(instanceId) ?? new Map();
  }
}
