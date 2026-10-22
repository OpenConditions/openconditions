/**
 * The peers this instance federates with, as every route and job reads them:
 * the configured peers, each trusting the keys it was seen to rotate to
 * (`federation_peer_key`) beside its pins. Reloaded after each peer upkeep,
 * so a key a peer rotated to is trusted from then on.
 */
import { loadLearnedKeys, type PeerRecord, withLearnedKeys } from "@openconditions/federation";
import type postgres from "postgres";

export class PeerBook {
  readonly #configured: readonly PeerRecord[];
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
    const learned = await loadLearnedKeys(sql);
    this.#peers = this.#configured.map((peer) =>
      withLearnedKeys(peer, learned.get(peer.instanceId)),
    );
  }

  all(): readonly PeerRecord[] {
    return this.#peers;
  }

  find(instanceId: string): PeerRecord | undefined {
    return this.#peers.find((peer) => peer.instanceId === instanceId);
  }
}
