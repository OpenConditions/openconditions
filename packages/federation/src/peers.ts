/**
 * The peers registry and the bilateral-pin trust anchor.
 *
 * Bootstrap trust between instances is a bilateral, out-of-band exchange of
 * key fingerprints: each operator pins the other's publicKeyMultibase values
 * in its peers config. Until a TUF-style delegation layer exists, THE PIN IS
 * THE ONLY TRUST ANCHOR — a fetched Actor document is trusted iff it serves
 * at least one pinned key at the pinned actorUrl. A runtime-substituted key,
 * a rolled-back document serving only retired unpinned keys, or a document
 * served from a different actor URL is rejected.
 */
import type { ActorCoverage, ActorDocument } from "./actor.js";
import { rawEd25519FromMultibase } from "./multibase.js";

export interface PeerRecord {
  instanceId: string;
  actorUrl: string;
  coverage?: ActorCoverage;
  trustTier: 0 | 1 | 2;
  /** Out-of-band pinned publicKeyMultibase fingerprints — the trust anchor. */
  pinnedKeys: string[];
}

export interface PinVerification {
  ok: boolean;
  /** Set when ok is false; names what the actor failed. */
  reason?: string;
  /** The pinned multibase keys the actor actually serves. */
  matchedKeys: string[];
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function fail(index: number, message: string): never {
  throw new TypeError(`invalid peer record at index ${index}: ${message}`);
}

/**
 * Parses the operator's peers config (JSON text from a peers.json file / env
 * var, or an already-parsed value) into validated peer records. Every pinned
 * key must decode as an Ed25519 multikey — a peer record whose pins are
 * unusable is a misconfiguration to fail closed on, not a peer that would
 * silently never verify.
 */
export function loadPeers(source: string | unknown): PeerRecord[] {
  let value: unknown = source;
  if (typeof source === "string") {
    try {
      value = JSON.parse(source);
    } catch (err) {
      throw new TypeError(`invalid peers config: not valid JSON (${(err as Error).message})`);
    }
  }
  if (!Array.isArray(value)) {
    throw new TypeError("invalid peers config: must be a JSON array of peer records");
  }

  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      fail(index, "must be an object");
    }
    const record = entry as Record<string, unknown>;

    const instanceId = record["instanceId"];
    if (typeof instanceId !== "string" || instanceId.length === 0) {
      fail(index, "instanceId must be a non-empty string");
    }
    if (seen.has(instanceId)) fail(index, `duplicate instanceId "${instanceId}"`);
    seen.add(instanceId);

    if (!isHttpUrl(record["actorUrl"])) fail(index, "actorUrl must be an http(s) URL");

    const trustTier = record["trustTier"];
    if (trustTier !== 0 && trustTier !== 1 && trustTier !== 2) {
      fail(index, "trustTier must be 0, 1, or 2");
    }

    const pinnedKeys = record["pinnedKeys"];
    if (!Array.isArray(pinnedKeys) || pinnedKeys.length === 0) {
      fail(index, "pinnedKeys must be a non-empty array (the bilateral pin is the trust anchor)");
    }
    for (const pin of pinnedKeys) {
      if (typeof pin !== "string") fail(index, "pinnedKeys entries must be strings");
      try {
        rawEd25519FromMultibase(pin);
      } catch (err) {
        fail(
          index,
          `pinned key ${JSON.stringify(pin)} is not an Ed25519 multikey: ${(err as Error).message}`
        );
      }
    }

    const result: PeerRecord = {
      instanceId,
      actorUrl: record["actorUrl"] as string,
      trustTier,
      pinnedKeys: pinnedKeys as string[],
    };
    if (record["coverage"] !== undefined) {
      const coverage = record["coverage"];
      if (coverage === null || typeof coverage !== "object" || Array.isArray(coverage)) {
        fail(index, "coverage must be an object");
      }
      result.coverage = coverage as ActorCoverage;
    }
    return result;
  });
}

/**
 * Verifies a fetched Actor document against a peer's bilateral pin. The
 * document must be served under the pinned actorUrl (its `id` must match) and
 * its publicKey[] must include at least one pinned multibase key. Anything
 * else — no keys, only unpinned/substituted keys, a rollback to a retired
 * unpinned key — is rejected with a named reason.
 *
 * Trust contract (binding for callers): when `ok` is true, downstream
 * signature verification MUST trust ONLY the returned `matchedKeys`. An actor
 * document may legitimately carry additional UNPINNED keys alongside a pinned
 * one (e.g. mid-rotation, or attacker-appended); those extra keys are NOT
 * trusted and a signature under them must NOT verify.
 *
 * Two residuals the pin alone does NOT close:
 *  (i) the pin proves key LISTING, not POSSESSION — that the peer actually
 *      holds the matched key's private half is proven only by an RFC 9421
 *      message-signature verification, never here;
 *  (ii) a COMPROMISED old key stays accepted until the operator edits it out
 *      of `pinnedKeys` — revocation is a signed `_meta.key_revocation` event
 *      (and, later, TUF registry delegation), not this bilateral pin.
 */
export function verifyActorAgainstPin(actor: ActorDocument, peer: PeerRecord): PinVerification {
  if (peer.pinnedKeys.length === 0) {
    return {
      ok: false,
      reason: `peer record for "${peer.instanceId}" pins no keys; nothing can anchor trust`,
      matchedKeys: [],
    };
  }
  if (actor.id !== peer.actorUrl) {
    return {
      ok: false,
      reason: `actor id "${actor.id}" does not match the pinned actorUrl "${peer.actorUrl}"`,
      matchedKeys: [],
    };
  }
  const served = Array.isArray(actor.publicKey) ? actor.publicKey : [];
  if (served.length === 0) {
    return {
      ok: false,
      reason: `actor document for "${peer.instanceId}" serves no public keys`,
      matchedKeys: [],
    };
  }
  const pins = new Set(peer.pinnedKeys);
  const matchedKeys = served
    .map((key) => key.publicKeyMultibase)
    .filter((multibase) => pins.has(multibase));
  if (matchedKeys.length === 0) {
    return {
      ok: false,
      reason:
        `actor for "${peer.instanceId}" serves only unpinned keys ` +
        `(possible key substitution or rollback); pinned: ${peer.pinnedKeys.join(", ")}`,
      matchedKeys: [],
    };
  }
  return { ok: true, matchedKeys };
}
