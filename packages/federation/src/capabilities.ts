/**
 * Capability negotiation between two federated instances. At peering, each side
 * fetches the other's Actor document (T1 buildActorDocument) and the two
 * capability sets are INTERSECTED into the terms both can honour:
 *  - protocolVersion — the highest version present in BOTH sides' supported set
 *    (the plan's "agree the highest mutually-supported"); no common version means
 *    the peers cannot federate at all.
 *  - schemaVersions / wireFormats / deliveryModes — the plain set intersection
 *    (empty is legal: two peers may share a protocol but no wire format yet).
 *  - convergenceBound — the MAX of the two: the looser bound BOTH can meet (a
 *    peer promising ≤300s convergence and one promising ≤600s jointly meet 600s).
 *
 * A major protocol transition is expected to run a long dual-support window so
 * peers overlap on a common version across the upgrade; that windowing is an
 * operational policy, not enforced by this pure function.
 */
/**
 * The negotiation input — the subset of `ActorCapabilities` the intersection
 * reads (an `ActorCapabilities` value is assignable to it). Each side carries a
 * single `protocolVersion`; an instance MAY additionally advertise the full set
 * it still supports in `protocolVersions` (e.g. during a dual-support window) so
 * a meaningful "highest mutually-supported" exists. When absent, the single
 * `protocolVersion` is treated as a supported-set of one.
 */
export interface NegotiableCapabilities {
  protocolVersion: string;
  protocolVersions?: string[];
  schemaVersions: string[];
  wireFormats: string[];
  deliveryModes: string[];
  convergenceBound: number;
}

export interface NegotiatedCapabilities {
  /** The MAX version present in BOTH sides' supported set (semver-ish compare). */
  protocolVersion: string;
  /** Intersection of the two schema-version sets (order follows `local`). */
  schemaVersions: string[];
  /** Intersection of the two wire-format sets (order follows `local`). */
  wireFormats: string[];
  /** Intersection of the two delivery-mode sets (order follows `local`). */
  deliveryModes: string[];
  /** The MAX of the two convergence bounds — the looser bound both can meet. */
  convergenceBound: number;
}

/** Thrown when two instances share no protocol version and cannot federate. */
export class CapabilityNegotiationError extends Error {}

/** The set of protocol versions a side supports: its single `protocolVersion`
 *  plus any it explicitly still lists, de-duplicated. */
function protocolSet(caps: NegotiableCapabilities): string[] {
  const set = new Set<string>([caps.protocolVersion, ...(caps.protocolVersions ?? [])]);
  return [...set];
}

/** Semver-ish ordering: compare dot-separated segments numerically where both
 *  are numbers (so `1.10` > `1.9`), else lexically. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const rawA = pa[i] ?? "0";
    const rawB = pb[i] ?? "0";
    const numA = Number(rawA);
    const numB = Number(rawB);
    if (Number.isFinite(numA) && Number.isFinite(numB)) {
      if (numA !== numB) return numA < numB ? -1 : 1;
    } else if (rawA !== rawB) {
      return rawA < rawB ? -1 : 1;
    }
  }
  return 0;
}

/** The ordered (following `local`) de-duplicated intersection of two sets. */
function intersect(local: string[], peer: string[]): string[] {
  const peerSet = new Set(peer);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of local) {
    if (peerSet.has(value) && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/**
 * Intersects two instances' capabilities into the terms both can honour. The
 * negotiated result is what a peer/subscription record stores as the agreed
 * contract for the pair (storage is the caller's; this function is the pure
 * negotiation). Throws {@link CapabilityNegotiationError} when the two share no
 * protocol version — an incompatible pair that must not federate.
 */
export function negotiateCapabilities(
  local: NegotiableCapabilities,
  peer: NegotiableCapabilities
): NegotiatedCapabilities {
  const common = intersect(protocolSet(local), protocolSet(peer));
  if (common.length === 0) {
    throw new CapabilityNegotiationError(
      `no mutually-supported protocol version (local: ${protocolSet(local).join(", ")}; ` +
        `peer: ${protocolSet(peer).join(", ")})`
    );
  }
  const protocolVersion = [...common].sort(compareVersions).at(-1)!;
  return {
    protocolVersion,
    schemaVersions: intersect(local.schemaVersions, peer.schemaVersions),
    wireFormats: intersect(local.wireFormats, peer.wireFormats),
    deliveryModes: intersect(local.deliveryModes, peer.deliveryModes),
    convergenceBound: Math.max(local.convergenceBound, peer.convergenceBound),
  };
}
