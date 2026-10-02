/**
 * The one thing a read query needs from a database client. Structurally
 * identical to OpenMapX's `IntegrationContext.db` (`DatabaseClient`):
 * `execute<T>(query, params)` runs a positional-parameter SQL string and
 * returns the rows. Any postgres-js client wraps to this in one line:
 * `{ execute: (q, p) => sql.unsafe(q, p) }`.
 */
export interface QueryRunner {
  execute<T = unknown>(query: string, params?: unknown[]): Promise<T>;
}
