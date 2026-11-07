import { createHash } from "node:crypto";
import { applyJmaAreaReports, type JmaAreaState, type JmaReport } from "@openconditions/hazards";
import type postgres from "postgres";

interface PackedState extends Omit<JmaPersistentState, "native"> {
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
    lastSuccess: value.lastSuccess,
    coverage: value.coverage,
    gap: value.gap,
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
function pack(state: JmaPersistentState): PackedState {
  const reports: Record<string, JmaReport> = {};
  const ref = (r: JmaReport) => {
    const id = createHash("sha256").update(JSON.stringify(r)).digest("hex");
    reports[id] = r;
    return id;
  };
  const packed: PackedState = {
    version: 2,
    lastSuccess: state.lastSuccess,
    coverage: state.coverage,
    gap: state.gap,
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
export interface JmaPersistentState {
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
  publish: (tx: postgres.TransactionSql, state: JmaPersistentState) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${source}))`;
    const [held] = await tx<
      { value: JmaPersistentState | PackedState }[]
    >`SELECT value FROM conditions.jma_state WHERE source = ${source}`;
    const previous = held ? unpackJmaState(held.value) : undefined;
    if (previous && at < previous.lastSuccess) throw new Error("JMA: stale poll cannot commit");
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
    const native = applyJmaAreaReports(base, eligible);
    const next: JmaPersistentState = {
      native,
      lastSuccess: at,
      coverage: "incomplete",
      gap: gap || (previous?.gap ?? false),
    };
    const packed = pack(next);
    const result = await publish(tx, next);
    await tx`INSERT INTO conditions.jma_state (source, value) VALUES (${source}, ${tx.json(packed as unknown as postgres.JSONValue)})
      ON CONFLICT (source) DO UPDATE SET value = EXCLUDED.value`;
    return result;
  }) as Promise<T>;
}
