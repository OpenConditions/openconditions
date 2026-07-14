/**
 * Operator-controlled federation block list.
 *
 * An operator may block a pinned peer; a blocked peer's inbox / backfill /
 * outbox / subscribe requests are refused with 403. The list is stored per
 * instance and is NEVER auto-synced or propagated across the federation — an
 * operator adopting another instance's recommended list is a separate, explicit
 * opt-in, not enforced here (no code path writes a peer's block to any outbound
 * channel).
 *
 * BINDING (ADR §8): blocking is a TRANSPORT control, never a truth judgement. A
 * blocked peer's already-received events are NOT re-judged false; the block only
 * stops future requests. CRUD here is an accountable operator action (records
 * `created_by` + reason for audit), analogous to the reporter block list.
 */
import type postgres from "postgres";

type Sql = postgres.Sql;

export interface BlockedPeer {
  peerId: string;
  reason: string | null;
  createdAt: Date;
  createdBy: string;
}

interface RawBlockRow {
  peer_id: string;
  reason: string | null;
  created_at: Date;
  created_by: string;
}

function toBlockedPeer(raw: RawBlockRow): BlockedPeer {
  return {
    peerId: raw.peer_id,
    reason: raw.reason,
    createdAt: raw.created_at,
    createdBy: raw.created_by,
  };
}

export interface BlockPeerInput {
  peerId: string;
  reason?: string | null;
  /** The accountable operator identity recorded for audit. */
  createdBy: string;
  /** Injectable clock (ISO 8601). */
  now: string;
}

/** Blocks a peer (idempotent: re-blocking refreshes the reason and operator). */
export async function blockPeer(sql: Sql, input: BlockPeerInput): Promise<void> {
  await sql`
    INSERT INTO conditions.federation_blocklist (peer_id, reason, created_by, created_at)
    VALUES (${input.peerId}, ${input.reason ?? null}, ${input.createdBy}, ${input.now})
    ON CONFLICT (peer_id) DO UPDATE
      SET reason = ${input.reason ?? null},
          created_by = ${input.createdBy},
          created_at = ${input.now}`;
}

/** Removes a peer from the block list; a no-op when it was not blocked. */
export async function unblockPeer(sql: Sql, peerId: string): Promise<void> {
  await sql`DELETE FROM conditions.federation_blocklist WHERE peer_id = ${peerId}`;
}

/** Whether a peer is currently blocked. */
export async function isPeerBlocked(sql: Sql, peerId: string): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM conditions.federation_blocklist WHERE peer_id = ${peerId} LIMIT 1`;
  return rows.length > 0;
}

/** Lists every blocked peer, newest block first. */
export async function listBlockedPeers(sql: Sql): Promise<BlockedPeer[]> {
  const rows = await sql<RawBlockRow[]>`
    SELECT peer_id, reason, created_at, created_by
    FROM conditions.federation_blocklist
    ORDER BY created_at DESC, peer_id`;
  return rows.map(toBlockedPeer);
}
