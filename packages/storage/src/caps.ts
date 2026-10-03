/** Hard ceiling on the records of one class a source publishes in one poll. */
export const MAX_ROWS_PER_SOURCE = 100_000;

/**
 * Hard ceiling on the readings one poll may hold. A flow feed sends a speed
 * and a volume per site plus a reading per lane or vehicle class, so a
 * national feed passes the record cap with readings alone; the cap still
 * stops a runaway parser.
 */
export const MAX_OBSERVATIONS_PER_POLL = 1_000_000;

/** The reading cap, `OPENCONDITIONS_MAX_OBSERVATIONS_PER_POLL` (default 1,000,000). */
export function maxObservationsPerPollFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["OPENCONDITIONS_MAX_OBSERVATIONS_PER_POLL"];
  const n = raw == null || raw === "" ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : MAX_OBSERVATIONS_PER_POLL;
}

/**
 * Refuses a poll holding more records of one class than a source may
 * publish. A complete snapshot must never be reconciled against a locally
 * truncated set, so the poll fails as a whole and the last good publication
 * stays.
 */
export function capRows<T>(fresh: readonly T[], what: string, max = MAX_ROWS_PER_SOURCE): void {
  if (fresh.length > max) {
    throw new Error(
      `source snapshot has ${fresh.length} ${what} rows, exceeding publication limit ${max}`,
    );
  }
}
