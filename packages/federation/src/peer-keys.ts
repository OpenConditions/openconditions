/**
 * The keys of a pinned peer this instance trusts beyond its configured pins.
 * A peer rotates its key by having the old key endorse the new one, the new
 * key signing the same ({@link verifyEndorsement}); its actor document serves
 * every key valid now with its endorsement. A served key is trusted when it
 * is pinned, was learned before, or is endorsed as the peer's by a key
 * trusted so — the chain followed as far as the document goes. Each trusted
 * key is held with its ANCHOR, the configured pin its endorsements lead back
 * to. What the verified document served of those is kept as the peer's
 * learned keys (`conditions.federation_peer_key`), replacing the last set,
 * so the peer's next key chains to this one after the old has gone from the
 * document, and a key the peer retired is trusted no longer. A learned key is
 * trusted only while its anchor is configured: an operator who removes a pin
 * revokes every key it led to.
 */
import type postgres from "postgres";
import type { ActorDocument } from "./actor.js";
import { verifyEndorsement } from "./keys.js";
import type { PeerRecord } from "./peers.js";

type Sql = postgres.Sql;

/** Trusted keys of one peer, each with the configured pin it leads back to. */
export type KeyAnchors = ReadonlyMap<string, string>;

/**
 * The served keys of `actor` that chain to `trusted`, in served order with
 * their anchors: trusted themselves, or endorsed as `instanceId`'s by a key
 * that is. An endorsement whose signatures fail trusts nothing.
 */
export async function chainedActorKeys(
  actor: Pick<ActorDocument, "publicKey">,
  instanceId: string,
  trusted: KeyAnchors,
): Promise<Map<string, string>> {
  const served = Array.isArray(actor.publicKey) ? actor.publicKey : [];
  const anchors = new Map(trusted);
  for (let grew = true; grew; ) {
    grew = false;
    for (const key of served) {
      const keyId = key.publicKeyMultibase;
      if (typeof keyId !== "string" || anchors.has(keyId)) continue;
      const endorsement = key.endorsement;
      if (
        endorsement === undefined ||
        endorsement === null ||
        typeof endorsement.by !== "string" ||
        typeof endorsement.signature !== "string" ||
        typeof endorsement.proof !== "string"
      ) {
        continue;
      }
      const anchor = anchors.get(endorsement.by);
      if (anchor === undefined) continue;
      if (await verifyEndorsement(instanceId, keyId, endorsement)) {
        anchors.set(keyId, anchor);
        grew = true;
      }
    }
  }
  const chained = new Map<string, string>();
  for (const key of served) {
    const anchor = anchors.get(key.publicKeyMultibase);
    if (anchor !== undefined) chained.set(key.publicKeyMultibase, anchor);
  }
  return chained;
}

/** The keys `peer` is trusted under: its pins, and those of `learned` whose anchor is pinned. */
export function trustedKeys(peer: PeerRecord, learned: KeyAnchors = new Map()): KeyAnchors {
  const keys = new Map(peer.pinnedKeys.map((pin) => [pin, pin] as const));
  for (const [keyId, anchor] of learned) {
    if (keys.has(anchor) && !keys.has(keyId)) keys.set(keyId, anchor);
  }
  return keys;
}

/** `peer` trusting its learned keys beside its pins ({@link trustedKeys}). */
export function withLearnedKeys(peer: PeerRecord, learned?: KeyAnchors): PeerRecord {
  const keys = [...trustedKeys(peer, learned).keys()];
  return keys.length === peer.pinnedKeys.length ? peer : { ...peer, pinnedKeys: keys };
}

/** Every peer's learned keys. */
export async function loadLearnedKeys(sql: Sql): Promise<Map<string, Map<string, string>>> {
  const rows = await sql<{ peer_instance_id: string; key_id: string; anchor: string }[]>`
    SELECT peer_instance_id, key_id, anchor FROM conditions.federation_peer_key
    ORDER BY peer_instance_id, key_id`;
  const learned = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const keys = learned.get(row.peer_instance_id) ?? new Map<string, string>();
    keys.set(row.key_id, row.anchor);
    learned.set(row.peer_instance_id, keys);
  }
  return learned;
}

/** Replaces a peer's learned keys with `keys`. */
export async function storeLearnedKeys(
  sql: Sql,
  peerInstanceId: string,
  keys: KeyAnchors,
  now: string,
): Promise<void> {
  const keyIds = [...keys.keys()];
  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM conditions.federation_peer_key WHERE peer_instance_id = ${peerInstanceId}`;
    if (keyIds.length > 0) {
      await tx`
        INSERT INTO conditions.federation_peer_key (peer_instance_id, key_id, anchor, learned_at)
        SELECT ${peerInstanceId}, k, a, ${now}
          FROM unnest(${keyIds}::text[], ${[...keys.values()]}::text[]) AS t(k, a)`;
    }
  });
}
