/**
 * Receiving a peer's model record. The peer's registry may differ from ours:
 * what we do not run is skipped, a newer minor's extra fields are dropped,
 * and anything else that fails validation is rejected. What the peer must
 * never send — another instance's record, an on-demand answer, a fused row —
 * is rejected outright, and a reporter's key never survives receipt.
 */
import {
  type Admission,
  admitRecord,
  federationEligible,
  RECORD_CLASSES,
  type RecordClass,
  type Registry,
  TOMBSTONE_REASONS,
} from "@openconditions/model";

/** What one entry of a peer's outbox page says, once its shape is checked. */
export type InboundEntry = {
  seq: number;
  txid: string;
  recordClass: RecordClass;
  recordId: string;
  canonicalId: string | null;
} & (
  | { operation: "create" | "update"; record: unknown }
  | { operation: "delete"; reason: (typeof TOMBSTONE_REASONS)[number] }
);

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Reads one entry of a peer's outbox page: a change carries the record, a
 * retraction carries a reason and never a record — a delete that also
 * carries one says two things at once and is refused. A retraction's reason
 * outside the model's vocabulary reads as `withdrawn`. The record itself is
 * checked on admission ({@link admitFederatedRecord}).
 */
export function readInboundEntry(
  wire: unknown,
): { ok: true; entry: InboundEntry } | { ok: false; reason: string; recordId?: string } {
  if (wire === null || typeof wire !== "object" || Array.isArray(wire)) {
    return { ok: false, reason: "malformed entry" };
  }
  const e = wire as Record<string, unknown>;
  const recordId = isString(e["recordId"]) ? e["recordId"] : undefined;
  if (
    recordId === undefined ||
    !(RECORD_CLASSES as readonly unknown[]).includes(e["recordClass"]) ||
    !isString(e["txid"]) ||
    typeof e["seq"] !== "number"
  ) {
    return {
      ok: false,
      reason: "malformed entry",
      ...(recordId === undefined ? {} : { recordId }),
    };
  }
  const head = {
    seq: e["seq"],
    txid: e["txid"],
    recordClass: e["recordClass"] as RecordClass,
    recordId,
    canonicalId: isString(e["canonicalId"]) ? e["canonicalId"] : null,
  };
  const operation = e["operation"];
  if (operation === "delete") {
    if (e["record"] !== undefined) {
      return { ok: false, recordId, reason: "a delete carries no record" };
    }
    const reason = (TOMBSTONE_REASONS as readonly unknown[]).includes(e["reason"])
      ? (e["reason"] as (typeof TOMBSTONE_REASONS)[number])
      : "withdrawn";
    return { ok: true, entry: { ...head, operation, reason } };
  }
  if (operation === "create" || operation === "update") {
    if (e["record"] === undefined) {
      return { ok: false, recordId, reason: `a ${operation} carries its record` };
    }
    return { ok: true, entry: { ...head, operation, record: e["record"] } };
  }
  return { ok: false, recordId, reason: "malformed entry" };
}

export interface PeerReceipt {
  /** The peer the record came from; it must be the record's own instance. */
  peerInstanceId: string;
  /** The schema versions the peer advertises. */
  peerVersions: readonly string[];
  /** The local clock at receipt. */
  receivedAt: string;
}

interface Hop {
  instanceId: string;
  viaPeer?: string;
  receivedAt: string;
}

const isHop = (value: unknown): value is Hop =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Hop).instanceId === "string" &&
  typeof (value as Hop).receivedAt === "string";

/** The record's origin chain plus this receipt, each (instance, peer) hop once. */
function withReceipt(chain: unknown, receipt: Hop): Hop[] {
  const hops = [...(Array.isArray(chain) ? chain.filter(isHop) : []), receipt];
  const seen = new Set<string>();
  return hops.filter((hop) => {
    const key = `${hop.instanceId}\u0000${hop.viaPeer ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Admits one record a peer sent. The record keeps its id, canonical id,
 * instance and evidence as the peer stated them; its origin chain gains this
 * receipt. Storage assigns the local revision.
 */
export function admitFederatedRecord(
  registry: Registry,
  peer: PeerReceipt,
  wire: unknown,
): Admission {
  if (wire === null || typeof wire !== "object" || Array.isArray(wire)) {
    return {
      admitted: false,
      issues: [{ path: [], code: "invalid_type", message: "a record is an object" }],
    };
  }
  const record = wire as Record<string, unknown>;
  const provenance = record["provenance"] as Record<string, unknown> | undefined;
  if (provenance === undefined || typeof provenance !== "object") {
    return {
      admitted: false,
      issues: [{ path: ["provenance"], code: "invalid_type", message: "provenance is missing" }],
    };
  }
  if (provenance["instanceId"] !== peer.peerInstanceId) {
    return {
      admitted: false,
      issues: [
        {
          path: ["provenance", "instanceId"],
          code: "relayed",
          message: `a peer sends its own records only; this one is ${String(provenance["instanceId"])}'s`,
        },
      ],
    };
  }
  if (!federationEligible(record as never)) {
    return {
      admitted: false,
      issues: [
        {
          path: ["provenance"],
          code: "never_federated",
          message: "on-demand answers and fused rows never leave their instance",
        },
      ],
    };
  }
  const { reporter: _reporter, ...kept } = provenance;
  const received = {
    ...record,
    provenance: {
      ...kept,
      originChain: withReceipt(provenance["originChain"], {
        instanceId: peer.peerInstanceId,
        viaPeer: peer.peerInstanceId,
        receivedAt: peer.receivedAt,
      }),
    },
  };
  return admitRecord(registry, peer.peerVersions, received);
}
