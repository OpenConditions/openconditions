import { applyJmaAreaReports, type JmaAreaState, type JmaReport } from "@openconditions/hazards";
import type postgres from "postgres";

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
      { value: JmaPersistentState }[]
    >`SELECT value FROM conditions.jma_state WHERE source = ${source}`;
    if (held && at < held.value.lastSuccess) throw new Error("JMA: stale poll cannot commit");
    const native = applyJmaAreaReports(held?.value.native ?? { products: {}, areas: {} }, reports);
    const next: JmaPersistentState = {
      native,
      lastSuccess: at,
      coverage: "incomplete",
      gap: gap || (held?.value.gap ?? false),
    };
    const result = await publish(tx, next);
    await tx`INSERT INTO conditions.jma_state (source, value) VALUES (${source}, ${tx.json(next as unknown as postgres.JSONValue)})
      ON CONFLICT (source) DO UPDATE SET value = EXCLUDED.value`;
    return result;
  }) as Promise<T>;
}
