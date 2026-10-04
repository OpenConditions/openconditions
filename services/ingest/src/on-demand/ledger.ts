import type postgres from "postgres";

type Sql = postgres.Sql | postgres.TransactionSql;

/** How long a cell whose fetch failed is left alone before it is tried again. */
export const FAILURE_BACKOFF_SEC = 120;

/** One cell's row of `conditions.on_demand_fetch`. */
export interface LedgerEntry {
  /** `pending` until the cell's first fetch ends. */
  status: "pending" | "fresh" | "failed";
  fetchedAt: Date | null;
  expiresAt: Date | null;
  retryAt: Date | null;
  claimedUntil: Date | null;
}

/**
 * What a read does with a cell: nothing when it is `fresh` (its answer is
 * stored and unexpired), nothing either while a failed fetch `backs off`,
 * and fetch it when it is `due` (never fetched, expired, or past its backoff).
 * A claim on a due cell is the fetcher's business, not the read's.
 */
export type CellState = "fresh" | "backoff" | "due";

export function cellState(entry: LedgerEntry | undefined, now: Date): CellState {
  if (entry === undefined) return "due";
  if (entry.status === "fresh" && entry.expiresAt !== null && entry.expiresAt > now) {
    return "fresh";
  }
  if (entry.status === "failed" && entry.retryAt !== null && entry.retryAt > now) {
    return "backoff";
  }
  return "due";
}

interface LedgerRow {
  cell: string;
  status: LedgerEntry["status"];
  fetched_at: Date | null;
  expires_at: Date | null;
  retry_at: Date | null;
  claimed_until: Date | null;
}

const entryOf = (r: LedgerRow): LedgerEntry => ({
  status: r.status,
  fetchedAt: r.fetched_at,
  expiresAt: r.expires_at,
  retryAt: r.retry_at,
  claimedUntil: r.claimed_until,
});

/** The ledger entries of `cells` of one source, by cell id; a cell never asked for has none. */
export async function readLedger(
  sql: Sql,
  sourceId: string,
  cells: readonly string[],
): Promise<Map<string, LedgerEntry>> {
  if (cells.length === 0) return new Map();
  const rows = await sql<LedgerRow[]>`
    SELECT cell, status, fetched_at, expires_at, retry_at, claimed_until
      FROM conditions.on_demand_fetch
     WHERE source_id = ${sourceId} AND cell = ANY(${[...cells]}::text[])`;
  return new Map(rows.map((r) => [r.cell, entryOf(r)]));
}

/**
 * How a claim on a cell ended: `won` (the caller fetches it, and nobody else
 * until `until`), or lost because the cell is `fresh`, `backoff` from a
 * failure, or `busy`, claimed by another fetcher whose claim has not lapsed.
 */
export type Claim = { result: "won"; until: Date } | { result: "fresh" | "backoff" | "busy" };

/**
 * Claims a cell for fetching until `until`, in one statement: only a cell
 * that is not fresh, not backing off from a failure, and not claimed by
 * anyone whose claim is still running at `now`. A claim a crashed claimant
 * never cleared lapses at its `claimed_until`. No connection is held after it.
 */
export async function claimCell(
  sql: Sql,
  sourceId: string,
  cell: string,
  now: Date,
  until: Date,
): Promise<Claim> {
  const won = await sql`
    INSERT INTO conditions.on_demand_fetch AS f (source_id, cell, status, claimed_until)
    VALUES (${sourceId}, ${cell}, 'pending', ${until})
    ON CONFLICT (source_id, cell) DO UPDATE SET claimed_until = EXCLUDED.claimed_until
     WHERE NOT (f.status = 'fresh' AND f.expires_at > ${now})
       AND NOT (f.status = 'failed' AND f.retry_at > ${now})
       AND (f.claimed_until IS NULL OR f.claimed_until <= ${now})
    RETURNING 1`;
  if (won.length === 1) return { result: "won", until };
  const entry = (await readLedger(sql, sourceId, [cell])).get(cell);
  const state = cellState(entry, now);
  return { result: state === "fresh" ? "fresh" : state === "backoff" ? "backoff" : "busy" };
}

/**
 * Moves the caller's claim to `until`, if it still holds it (the cell's
 * claim is still the one it set at `held`); false when the claim lapsed and
 * another fetcher took the cell.
 */
export async function renewClaim(
  sql: Sql,
  sourceId: string,
  cell: string,
  held: Date,
  until: Date,
): Promise<boolean> {
  const rows = await sql`
    UPDATE conditions.on_demand_fetch SET claimed_until = ${until}
     WHERE source_id = ${sourceId} AND cell = ${cell} AND claimed_until = ${held}
    RETURNING 1`;
  return rows.length === 1;
}

/** Gives up the caller's claim (the one it set at `held`) without fetching. */
export async function releaseClaim(
  sql: Sql,
  sourceId: string,
  cell: string,
  held: Date,
): Promise<void> {
  await sql`
    UPDATE conditions.on_demand_fetch SET claimed_until = NULL
     WHERE source_id = ${sourceId} AND cell = ${cell} AND claimed_until = ${held}`;
}

/**
 * Records a cell's answer as stored until `expiresAt`, and clears its claim,
 * if the caller still holds it (the claim it set at `held`). False when the
 * claim lapsed and another fetcher took the cell: nothing changes. Run in
 * the transaction writing the answer, first: it locks the cell's row, so no
 * fetcher claims the cell before that transaction ends.
 */
export async function markFresh(
  sql: Sql,
  sourceId: string,
  cell: string,
  held: Date,
  fetchedAt: Date,
  expiresAt: Date,
): Promise<boolean> {
  const rows = await sql`
    UPDATE conditions.on_demand_fetch
       SET fetched_at = ${fetchedAt}, expires_at = ${expiresAt},
           status = 'fresh', retry_at = NULL, claimed_until = NULL
     WHERE source_id = ${sourceId} AND cell = ${cell} AND claimed_until = ${held}
    RETURNING 1`;
  return rows.length === 1;
}

/**
 * Records a failed fetch of a cell, retried no sooner than the backoff, and
 * clears its claim, if the caller still holds it (the claim it set at
 * `held`); a cell another fetcher took over is left to it. The last good
 * fetch's time and expiry stay: its rows are kept until then.
 */
export async function markFailed(
  sql: Sql,
  sourceId: string,
  cell: string,
  held: Date,
  at: Date,
): Promise<void> {
  const retryAt = new Date(at.getTime() + FAILURE_BACKOFF_SEC * 1000);
  await sql`
    UPDATE conditions.on_demand_fetch
       SET status = 'failed', retry_at = ${retryAt}, claimed_until = NULL
     WHERE source_id = ${sourceId} AND cell = ${cell} AND claimed_until = ${held}`;
}
