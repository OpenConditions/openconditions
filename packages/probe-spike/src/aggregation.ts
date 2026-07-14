/**
 * Two-share aggregation for the spike — Leader + Helper, never a single
 * aggregator. Each report is sharded into two input shares; both aggregators run
 * the VDAF preparation (which validates the FLP one-hot / range proof), and only
 * the combined output shares reconstruct the aggregate. This module exposes the
 * per-aggregator output shares so a test can prove neither share alone reveals
 * the measurement.
 *
 * A tamper hook lets a test forge a malicious client's input shares (multi-hot
 * or out-of-range) and confirm the aggregators reject it — the security property
 * a client-side range check cannot provide.
 */
import type { Prio3 } from "@divviup/prio3";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

/** A single report's structured shares, ready for aggregation. */
export interface ShardedReport<InputShare, PublicShare> {
  nonce: Buffer;
  publicShare: PublicShare;
  inputShares: InputShare[];
}

// The @divviup Prio3 input/public share types are module-internal (not generic
// parameters); recover them from the concrete instance's shard() return type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPrio3 = Prio3<any, any>;
type ShardResult<V extends AnyPrio3> = Awaited<ReturnType<V["shard"]>>;
type InputShareOf<V extends AnyPrio3> = ShardResult<V>["inputShares"][number];
type PublicShareOf<V extends AnyPrio3> = ShardResult<V>["publicShare"];

/** Shards one measurement into Leader + Helper input shares (structured). */
export async function shardStructured<V extends AnyPrio3>(
  vdaf: V,
  measurement: Parameters<V["shard"]>[0],
  nonce: Buffer = Buffer.from(randomBytes(vdaf.nonceSize))
): Promise<ShardedReport<InputShareOf<V>, PublicShareOf<V>>> {
  const rand = Buffer.from(randomBytes(vdaf.randSize));
  const { publicShare, inputShares } = await vdaf.shard(measurement, nonce, rand);
  return { nonce, publicShare, inputShares };
}

export interface PreparedReport {
  /** One output share per aggregator (Leader index 0, Helper index 1). */
  outputShares: bigint[][];
}

/**
 * Runs the VDAF preparation round for both aggregators over a single report and
 * returns the per-aggregator output shares. Throws if the FLP validity proof
 * fails (a tampered multi-hot / out-of-range report). `tamper` may mutate the
 * structured input shares to model a malicious client.
 */
export async function prepareReport<V extends AnyPrio3>(
  vdaf: V,
  verifyKey: Buffer,
  report: ShardedReport<InputShareOf<V>, PublicShareOf<V>>,
  tamper?: (inputShares: InputShareOf<V>[]) => void
): Promise<PreparedReport> {
  const inputShares = report.inputShares.slice();
  if (tamper) tamper(inputShares);

  const prepared = await Promise.all(
    inputShares.map((inputShare, aggregatorId) =>
      vdaf.prepareInit(verifyKey, aggregatorId, null, report.nonce, report.publicShare, inputShare)
    )
  );
  // Combining the preparation shares runs the FLP verifier — a bad proof throws.
  const message = await vdaf.unshardPreparationShares(
    null,
    prepared.map((p) => p.preparationShare)
  );
  const outputShares = prepared.map((p) => {
    const out = vdaf.prepareNext(p.preparationState, message);
    if ("preparationState" in out) {
      throw new Error("expected a finished output share after one round");
    }
    return out.outputShare;
  });
  return { outputShares };
}

/**
 * Aggregates a batch of prepared reports and unshards to the public aggregate.
 * Each aggregator sums only its own output shares; the aggregate never exists in
 * one place until the final unshard.
 */
export function aggregateBatch<V extends AnyPrio3>(
  vdaf: V,
  prepared: PreparedReport[]
): ReturnType<V["unshard"]> {
  if (prepared.length === 0) {
    throw new Error("cannot aggregate an empty batch");
  }
  const numAggregators = prepared[0]!.outputShares.length;
  const aggregatorShares = Array.from({ length: numAggregators }, (_, aggId) =>
    vdaf.aggregate(
      null,
      prepared.map((p) => p.outputShares[aggId]!)
    )
  );
  return vdaf.unshard(null, aggregatorShares, prepared.length) as ReturnType<V["unshard"]>;
}

/** A fresh VDAF verify key of the size the instance requires. */
export function freshVerifyKey(vdaf: AnyPrio3): Buffer {
  return Buffer.from(randomBytes(vdaf.verifyKeySize));
}
