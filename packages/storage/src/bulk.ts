import type postgres from "postgres";

export type Sql = postgres.Sql | postgres.TransactionSql;

/**
 * One column of a bulk write: its Postgres type in the JSON record set, and
 * whether it is a GeoJSON geometry (sent as JSON, stored as a 4326 geometry).
 */
export interface ColumnSpec {
  name: string;
  type: string;
  geometry?: true;
}

const BATCH = 1000;

function selectExpr(c: ColumnSpec): string {
  return c.geometry
    ? `CASE WHEN jsonb_typeof(r.${c.name}) = 'object'
         THEN ST_SetSRID(ST_GeomFromGeoJSON(r.${c.name}::text), 4326) END`
    : `r.${c.name}`;
}

/**
 * Inserts rows in batches through `jsonb_to_recordset`, one statement per
 * batch, so thousands of rows cost a handful of round trips. `conflict` is
 * the `ON CONFLICT` clause, if any; `returning` a `RETURNING` list, whose
 * rows come back from every batch.
 */
export async function insertRows<R extends Record<string, unknown> = Record<string, unknown>>(
  sql: Sql,
  table: string,
  columns: readonly ColumnSpec[],
  rows: readonly Record<string, unknown>[],
  conflict = "",
  returning = "",
): Promise<R[]> {
  const names = columns.map((c) => c.name).join(", ");
  const exprs = columns.map(selectExpr).join(", ");
  const defs = columns.map((c) => `${c.name} ${c.geometry ? "jsonb" : c.type}`).join(", ");
  const out: R[] = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const result = await sql.unsafe<R[]>(
      `INSERT INTO conditions.${table} (${names})
       SELECT ${exprs} FROM jsonb_to_recordset($1::text::jsonb) AS r(${defs}) ${conflict}
       ${returning ? `RETURNING ${returning}` : ""}`,
      [JSON.stringify(batch)],
    );
    out.push(...result);
  }
  return out;
}

/** `ON CONFLICT (key) DO UPDATE` setting every given column from the new row. */
export function upsertClause(key: readonly string[], columns: readonly ColumnSpec[]): string {
  const set = columns
    .filter((c) => !key.includes(c.name))
    .map((c) => `${c.name} = excluded.${c.name}`)
    .join(", ");
  return `ON CONFLICT (${key.join(", ")}) DO UPDATE SET ${set}`;
}
