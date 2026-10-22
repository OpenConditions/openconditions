/**
 * The keys of a pinned peer this instance trusts beyond its configured pins.
 * A peer rotates its key by having the old key endorse the new one
 * ({@link verifyEndorsement}); its actor document serves every key valid now
 * with its endorsement. A served key is trusted when it is pinned, was learned
 * before, or is endorsed by a key trusted so — the chain followed as far as
 * the document goes. What the verified document served of those is kept as
 * the peer's learned keys (`conditions.federation_peer_key`), replacing the
 * last set, so the peer's next key chains to this one after the old has gone
 * from the document, and a key the peer retired is trusted no longer.
 */
import type postgres from "postgres";
import type { ActorDocument } from "./actor.js";
import { verifyEndorsement } from "./keys.js";
import type { PeerRecord } from "./peers.js";

type Sql = postgres.Sql;

/**
 * The served keys of `actor` that chain to `trusted`: trusted themselves, or
 * endorsed by a key that does. An endorsement whose signature fails trusts
 * nothing.
 */
export async function chainedActorKeys(
  actor: Pick<ActorDocument, "publicKey">,
  trusted: ReadonlySet<string>,
): Promise<string[]> {
  const served = Array.isArray(actor.publicKey) ? actor.publicKey : [];
  const chained = new Set<string>();
  const known = (keyId: string) => trusted.has(keyId) || chained.has(keyId);
  for (let grew = true; grew; ) {
    grew = false;
    for (const key of served) {
      const keyId = key.publicKeyMultibase;
      if (typeof keyId !== "string" || known(keyId)) continue;
      const endorsement = key.endorsement;
      if (
        endorsement === undefined ||
        typeof endorsement.by !== "string" ||
        typeof endorsement.signature !== "string" ||
        !known(endorsement.by)
      ) {
        continue;
      }
      if (await verifyEndorsement(keyId, endorsement)) {
        chained.add(keyId);
        grew = true;
      }
    }
  }
  return served
    .map((key) => key.publicKeyMultibase)
    .filter((keyId) => typeof keyId === "string" && known(keyId));
}

/** Every peer's learned keys. */
export async function loadLearnedKeys(sql: Sql): Promise<Map<string, string[]>> {
  const rows = await sql<{ peer_instance_id: string; key_id: string }[]>`
    SELECT peer_instance_id, key_id FROM conditions.federation_peer_key
    ORDER BY peer_instance_id, key_id`;
  const learned = new Map<string, string[]>();
  for (const row of rows) {
    learned.set(row.peer_instance_id, [...(learned.get(row.peer_instance_id) ?? []), row.key_id]);
  }
  return learned;
}

/** Replaces a peer's learned keys with `keyIds`. */
export async function storeLearnedKeys(
  sql: Sql,
  peerInstanceId: string,
  keyIds: readonly string[],
  now: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM conditions.federation_peer_key
      WHERE peer_instance_id = ${peerInstanceId} AND key_id <> ALL(${keyIds as string[]})`;
    if (keyIds.length > 0) {
      await tx`
        INSERT INTO conditions.federation_peer_key (peer_instance_id, key_id, learned_at)
        SELECT ${peerInstanceId}, k, ${now} FROM unnest(${keyIds as string[]}::text[]) AS k
        ON CONFLICT DO NOTHING`;
    }
  });
}

/** `peer` with its learned keys trusted beside its pins. */
export function withLearnedKeys(peer: PeerRecord, learned: readonly string[] = []): PeerRecord {
  const extra = learned.filter((key) => !peer.pinnedKeys.includes(key));
  return extra.length === 0 ? peer : { ...peer, pinnedKeys: [...peer.pinnedKeys, ...extra] };
}
