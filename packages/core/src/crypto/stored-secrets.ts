import type postgres from "postgres";
import type { SealedSecret, SecretPlace, SecretsKey } from "./secrets.js";

/**
 * The secret `column` of a row as stored in its `<column>_ciphertext`,
 * `<column>_iv` and `<column>_tag` columns; null when all three are null.
 */
export function storedSecret(row: postgres.Row, place: SecretPlace): SealedSecret | null {
  const ciphertext = row[`${place.column}_ciphertext`] as Buffer | null | undefined;
  const iv = row[`${place.column}_iv`] as Buffer | null | undefined;
  const tag = row[`${place.column}_tag`] as Buffer | null | undefined;
  if (ciphertext == null && iv == null && tag == null) return null;
  if (ciphertext == null || iv == null || tag == null) {
    throw new Error(
      `conditions.${place.table}.${place.column} of the row ${place.row} is malformed: its ciphertext, IV and tag are not all stored`,
    );
  }
  return { ciphertext, iv, tag };
}

/** A table that stores secrets: its name, its primary key column and its secrets' columns. */
export interface SecretTable {
  table: string;
  rowKey: string;
  columns: readonly string[];
}

/**
 * Opens every secret stored in `spec.table` under `key` and discards the
 * plaintext. A service calls it at start, so a key that is not the one the
 * secrets were sealed with stops the boot with a "wrong key" error naming the
 * table, column and row, instead of failing at the first use.
 */
export async function assertStoredSecretsOpen(
  sql: postgres.Sql,
  key: SecretsKey,
  spec: SecretTable,
): Promise<void> {
  const columns = spec.columns.flatMap((c) => [`${c}_ciphertext`, `${c}_iv`, `${c}_tag`]);
  const rows = await sql.unsafe(
    `SELECT ${[spec.rowKey, ...columns].map((c) => `"${c}"`).join(", ")} FROM "conditions"."${spec.table}"`,
  );
  for (const row of rows) {
    for (const column of spec.columns) {
      const place = { table: spec.table, column, row: String(row[spec.rowKey]) };
      const sealed = storedSecret(row, place);
      if (sealed !== null) key.open(sealed, place).fill(0);
    }
  }
}
