/**
 * The operator-controlled block list. Blocking a key is a single transaction:
 * it records the decision in `conditions.block_list` (upserting the reason) AND
 * flips the reporter row's `status` to `blocked`, so the attester zeroes the
 * key's grants and the report/vote paths refuse it. Unblocking removes the row
 * and restores the reporter to `active` (a no-op when no reporter row exists).
 *
 * Block lists are OPERATOR-CONTROLLED and NEVER auto-synced across federation —
 * each instance owns its own; propagation, if ever, is a plan-2 concern.
 */
import type postgres from "postgres";

type Sql = postgres.Sql;

/** The reviewer identity recorded on a block; v1 has a single operator. */
const BLOCKED_BY = "operator";

export interface BlockListItem {
  keyId: string;
  reason: string | null;
  createdAt: string;
  createdBy: string;
}

interface BlockRow {
  key_id: string;
  reason: string | null;
  created_at: Date;
  created_by: string;
}

/** Block a key: upsert the block_list row and mark the reporter (if any) blocked. */
export async function blockKey(
  sql: Sql,
  keyId: string,
  reason: string | null,
  now: string
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO conditions.block_list (key_id, reason, created_at, created_by)
      VALUES (${keyId}, ${reason}, ${now}, ${BLOCKED_BY})
      ON CONFLICT (key_id) DO UPDATE SET reason = EXCLUDED.reason
    `;
    await tx`
      UPDATE conditions.reporter SET status = 'blocked' WHERE key_id = ${keyId}
    `;
  });
}

/** Unblock a key: drop the block_list row and restore the reporter (if any) to active. */
export async function unblockKey(sql: Sql, keyId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM conditions.block_list WHERE key_id = ${keyId}`;
    await tx`
      UPDATE conditions.reporter SET status = 'active' WHERE key_id = ${keyId}
    `;
  });
}

/** List every blocked key, newest block first. */
export async function listBlocked(sql: Sql): Promise<BlockListItem[]> {
  const rows = await sql<BlockRow[]>`
    SELECT key_id, reason, created_at, created_by
    FROM conditions.block_list
    ORDER BY created_at DESC, key_id DESC
  `;
  return rows.map((row) => ({
    keyId: row.key_id,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
  }));
}
