import { createHash } from "node:crypto";
import {
  applyJmaAreaReports,
  assertJmaRights,
  type JmaAreaState,
  type JmaReport,
} from "@openconditions/hazards";
import type postgres from "postgres";
import { admitJmaWarnings, type JmaWithheld } from "./jma-admission.js";
import { type JmaNativeSession, type JmaNativeTask, jmaNative } from "./jma-native-process.js";

export interface PackedState extends Omit<JmaPersistentState, "native"> {
  version: 2;
  reports: Record<string, JmaReport>;
  products: Record<string, string>;
  areas: Record<string, { report: string; warning: JmaReport["warnings"][number]; ended: boolean }>;
}
export function unpackJmaState(value: JmaPersistentState | PackedState): JmaPersistentState {
  if (!("version" in value)) return value;
  const report = (id: string) => {
    const r = value.reports[id];
    if (!r) throw new Error("JMA: corrupt report reference");
    return r;
  };
  return {
    withheld: value.withheld,
    lastSuccess: value.lastSuccess,
    coverage: value.coverage,
    gap: value.gap,
    initialization: value.initialization,
    native: {
      products: Object.fromEntries(
        Object.entries(value.products).map(([k, id]) => [k, report(id)]),
      ),
      areas: Object.fromEntries(
        Object.entries(value.areas).map(([k, a]) => [k, { ...a, report: report(a.report) }]),
      ),
    },
  };
}
export function packJmaState(state: JmaPersistentState): PackedState {
  // Refuse cardinality overflow before hashing or serializing large shared reports.
  if (
    Object.keys(state.native.areas).length > 20000 ||
    Object.keys(state.native.products).length > 4096 ||
    Object.keys(state.withheld ?? {}).length > 4096
  )
    throw new Error("JMA: lifecycle state bound exceeded; retaining last good publication");
  const reports: Record<string, JmaReport> = {};
  const references = new WeakMap<JmaReport, string>();
  const ref = (r: JmaReport) => {
    const known = references.get(r);
    if (known) return known;
    const id = createHash("sha256").update(JSON.stringify(r)).digest("hex");
    reports[id] = r;
    references.set(r, id);
    return id;
  };
  const packed: PackedState = {
    version: 2,
    withheld: state.withheld,
    lastSuccess: state.lastSuccess,
    coverage: state.coverage,
    gap: state.gap,
    initialization: state.initialization,
    reports,
    products: Object.fromEntries(
      Object.entries(state.native.products).map(([k, r]) => [k, ref(r)]),
    ),
    areas: Object.fromEntries(
      Object.entries(state.native.areas).map(([k, a]) => [k, { ...a, report: ref(a.report) }]),
    ),
  };
  if (
    Object.keys(packed.areas).length > 20000 ||
    Object.keys(packed.products).length > 4096 ||
    Buffer.byteLength(JSON.stringify(packed)) > 32_000_000
  )
    throw new Error("JMA: lifecycle state bound exceeded; retaining last good publication");
  return packed;
}
export interface JmaInitializationReceipt {
  source: string;
  at: string;
  coverage: "incomplete";
  method: "rolling-index-observed-reports";
  payloadHashes: string[];
}
export interface JmaPersistentState {
  withheld?: JmaWithheld;
  initialization?: JmaInitializationReceipt;
  native: JmaAreaState;
  lastSuccess: number;
  /** A rolling index cannot establish authoritative active-warning coverage. */
  coverage: "incomplete";
  gap: boolean;
}
/**
 * The callback must publish with this transaction, never open a second transaction.
 * No cursor or tombstone can advance if canonical publication or status recording fails.
 */
export async function reconcileJmaIn<T>(
  sql: postgres.Sql,
  source: string,
  reports: readonly JmaReport[],
  at: number,
  gap: boolean,
  publish: (
    tx: postgres.TransactionSql,
    state: JmaPersistentState,
    packed: PackedState,
  ) => Promise<T>,
  initialization?: JmaInitializationReceipt,
  rightsScopedWarnings = false,
  signal: AbortSignal = AbortSignal.timeout(120_000),
  session?: JmaNativeSession,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${source}))`;
    const [held] = await tx<
      { value: JmaPersistentState | PackedState }[]
    >`SELECT value FROM conditions.jma_state WHERE source = ${source}`;
    signal.throwIfAborted();
    const packed = await jmaNative(
      {
        kind: "state",
        source,
        previous: held?.value,
        reports,
        at,
        gap,
        initialization,
        warnings: rightsScopedWarnings,
      },
      signal,
      session,
    );
    signal.throwIfAborted();
    const next = unpackJmaState(packed);
    const result = await publish(tx, next, packed);
    signal.throwIfAborted();
    await tx`INSERT INTO conditions.jma_state (source, value) VALUES (${source}, ${tx.json(packed as unknown as postgres.JSONValue)})
      ON CONFLICT (source) DO UPDATE SET value = EXCLUDED.value`;
    signal.throwIfAborted();
    return result;
  }) as Promise<T>;
}

export function materializeJma(task: Extract<JmaNativeTask, { kind: "state" }>): PackedState {
  const { source, reports, at, gap, initialization, warnings } = task;
  const previous = task.previous ? unpackJmaState(task.previous) : undefined;
  if (previous && at < previous.lastSuccess) throw new Error("JMA: stale poll cannot commit");
  if (previous)
    for (const report of new Set([
      ...Object.values(previous.native.products),
      ...Object.values(previous.native.areas).map((a) => a.report),
    ]))
      assertJmaRights(report);
  if (!warnings) for (const report of reports) assertJmaRights(report);
  // Thirty-day publication horizon, longer than the long index. Removing old
  // quake tombstones is safe only because reports behind this floor are ignored.
  const floor = at - 30 * 86_400_000;
  const base = previous?.native ?? { products: {}, areas: {} };
  base.products = Object.fromEntries(
    Object.entries(base.products).filter(
      ([, r]) => !r.family.startsWith("VXSE") || Date.parse(r.controlAt) >= floor,
    ),
  );
  const eligible = reports.filter(
    (r) => !r.family.startsWith("VXSE") || Date.parse(r.controlAt) >= floor,
  );
  if (
    initialization &&
    (initialization.source !== source ||
      initialization.at !== new Date(at).toISOString() ||
      initialization.coverage !== "incomplete" ||
      initialization.method !== "rolling-index-observed-reports" ||
      initialization.payloadHashes.some((h) => !/^[a-f0-9]{64}$/.test(h)))
  )
    throw new Error("JMA: invalid initialization receipt");
  const admitted = warnings
    ? admitJmaWarnings(base, previous?.withheld ?? {}, eligible)
    : { native: applyJmaAreaReports(base, eligible), withheld: previous?.withheld };
  const { native, withheld } = admitted;
  const next: JmaPersistentState = {
    native,
    withheld,
    initialization: previous?.initialization ?? initialization,
    lastSuccess: at,
    coverage: "incomplete",
    gap: gap || (previous?.gap ?? false),
  };
  return packJmaState(next);
}
