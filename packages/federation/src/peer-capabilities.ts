/**
 * What a pinned peer runs. Its actor document advertises the schema versions
 * of its registry; this instance fetches that document, verifies it against
 * the peer's pin, negotiates (a peer with no common protocol or another
 * kernel major shares nothing), and keeps the advertised versions in
 * `conditions.federation_peer_capabilities`. Admitting the peer's records
 * reads them: a record of a schema the two do not share at one major is
 * skipped, and a newer minor's fields are dropped.
 */

import type postgres from "postgres";
import type { ActorDocument } from "./actor.js";
import { type NegotiableCapabilities, negotiateCapabilities } from "./capabilities.js";
import { chainedActorKeys, storeLearnedKeys } from "./peer-keys.js";
import { type PeerRecord, verifyActorAgainstPin } from "./peers.js";

type Sql = postgres.Sql;

export type PeerVersions =
  | {
      ok: true;
      schemaVersions: string[];
      /** The served keys that chain to the peer's pins ({@link chainedActorKeys}). */
      keys: string[];
    }
  | { ok: false; reason: string };

/**
 * The schema versions a fetched actor document advertises, once it is the
 * pinned peer's own document and the two instances can federate at all. The
 * document must serve a key that chains to one `peer` trusts.
 */
export async function peerVersionsFromActor(
  actor: unknown,
  peer: PeerRecord,
  local: NegotiableCapabilities,
): Promise<PeerVersions> {
  if (actor === null || typeof actor !== "object") {
    return { ok: false, reason: "the actor document is not an object" };
  }
  const document = actor as ActorDocument;
  const keys = await chainedActorKeys(document, new Set(peer.pinnedKeys));
  const pin = verifyActorAgainstPin(document, {
    ...peer,
    pinnedKeys: keys.length > 0 ? keys : peer.pinnedKeys,
  });
  if (!pin.ok) return { ok: false, reason: pin.reason ?? "the actor document fails its pin" };
  const capabilities = document.capabilities as NegotiableCapabilities | undefined;
  if (!Array.isArray(capabilities?.schemaVersions)) {
    return { ok: false, reason: "the actor document advertises no schema versions" };
  }
  try {
    negotiateCapabilities(local, capabilities);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  return { ok: true, schemaVersions: [...capabilities.schemaVersions], keys: pin.matchedKeys };
}

/** Keeps a peer's advertised schema versions. */
export async function storePeerVersions(
  sql: Sql,
  peerInstanceId: string,
  schemaVersions: readonly string[],
  now: string,
): Promise<void> {
  await sql`
    INSERT INTO conditions.federation_peer_capabilities (peer_instance_id, schema_versions, fetched_at)
    VALUES (${peerInstanceId}, ${schemaVersions as string[]}, ${now})
    ON CONFLICT (peer_instance_id) DO UPDATE SET
      schema_versions = EXCLUDED.schema_versions,
      fetched_at = EXCLUDED.fetched_at`;
}

/** The schema versions a peer advertised when last verified; undefined before that. */
export async function loadPeerVersions(
  sql: Sql,
  peerInstanceId: string,
): Promise<string[] | undefined> {
  const [row] = await sql<{ schema_versions: string[] }[]>`
    SELECT schema_versions FROM conditions.federation_peer_capabilities
    WHERE peer_instance_id = ${peerInstanceId}`;
  return row?.schema_versions;
}

/**
 * Fetches a peer's actor document, verifies and negotiates it, and keeps
 * what it advertises and the keys it serves that chain to the peer's pins
 * (`federation_peer_key`). A document that fails leaves both as they were,
 * so a peer's brief outage never stops its records landing.
 */
export async function refreshPeerCapabilities(
  sql: Sql,
  peer: PeerRecord,
  opts: { local: NegotiableCapabilities; fetchImpl: typeof fetch; now: string },
): Promise<PeerVersions> {
  let actor: unknown;
  try {
    const res = await opts.fetchImpl(peer.actorUrl, {
      headers: { accept: "application/activity+json, application/json" },
    });
    if (!res.ok) return { ok: false, reason: `the actor document answered ${res.status}` };
    actor = await res.json();
  } catch (err) {
    return { ok: false, reason: `the actor document could not be fetched: ${String(err)}` };
  }
  const versions = await peerVersionsFromActor(actor, peer, opts.local);
  if (versions.ok) {
    await storePeerVersions(sql, peer.instanceId, versions.schemaVersions, opts.now);
    await storeLearnedKeys(sql, peer.instanceId, versions.keys, opts.now);
  }
  return versions;
}
