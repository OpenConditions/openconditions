/**
 * Tier-bounded backfill — the SAME composite `(txid, seq)` cursor primitive as
 * the live pull (T3 readOutbox), with a LOWER TIME FLOOR on how far back an
 * instance serves history to a peer. The floor is a function of the peer's
 * TRUST TIER (authoritative from the bilateral pin, never a client field):
 *  - Tier 0 (public): the last 24 hours.
 *  - Tier 1 (peered): the last 30 days.
 *  - Tier 2 (governance): >= Tier 1 (30 days, or a configured longer window).
 *
 * WITHIN the window backfill is identical to the outbox pull: same cursor, same
 * gap-freeness, same signed page. BEYOND the window there is no protocol — a
 * request whose range reaches before the floor gets `beyondWindow: true` and an
 * `archiveUrl` pointing at the static GeoParquet archive (Plan 3 T9 —
 * docs/archive.md), which the peer fetches directly over HTTP Range. So the live
 * exchange stays bounded and the deep past is served by a single mirrorable file.
 *
 * The floor is applied as an ADDITIONAL `WHERE created_at >= now - windowSec` on
 * the readOutbox query (via its `minCreatedAt`), composed with the composite
 * cursor and the xmin fence — pre-floor entries are never scanned, so they never
 * count against the page limit and never break gap-freeness within the window.
 */
import type postgres from "postgres";
import {
  OUTBOX_CURSOR_START,
  decodeOutboxCursor,
  readOutbox,
  type FederationFilter,
  type OutboxCursor,
  type OutboxPage,
} from "@openconditions/federation";

/** Tier 0 (public) serves the last 24 hours. */
export const BACKFILL_WINDOW_TIER_0_SEC = 86_400;
/** Tier 1 (peered) serves the last 30 days. */
export const BACKFILL_WINDOW_TIER_1_SEC = 2_592_000;
/** Tier 2 (governance) serves at least Tier 1's window (configurable longer). */
export const BACKFILL_WINDOW_TIER_2_SEC = 2_592_000;

export interface BackfillWindow {
  /** How far back (seconds before `now`) this tier serves live. */
  maxAgeSec: number;
}

/**
 * The live-serve window for a trust tier. Tier 2 is at least Tier 1's window;
 * a configured `governanceWindowSec` widens it but can never shrink it below
 * Tier 1 (a governance anchor never sees less history than a plain peer).
 */
export function backfillWindowForTier(
  tier: 0 | 1 | 2,
  governanceWindowSec: number = BACKFILL_WINDOW_TIER_2_SEC
): BackfillWindow {
  switch (tier) {
    case 0:
      return { maxAgeSec: BACKFILL_WINDOW_TIER_0_SEC };
    case 1:
      return { maxAgeSec: BACKFILL_WINDOW_TIER_1_SEC };
    case 2: {
      // A non-finite override (NaN/±Infinity) must never reach `new Date`;
      // fall back to the Tier-1 floor, which a governance anchor never dips below.
      const configured = Number.isFinite(governanceWindowSec)
        ? governanceWindowSec
        : BACKFILL_WINDOW_TIER_2_SEC;
      return { maxAgeSec: Math.max(configured, BACKFILL_WINDOW_TIER_1_SEC) };
    }
  }
}

/**
 * The `minCreatedAt` ISO instant for a tier's window: `now - windowSec`. The one
 * place the tier floor is turned into a scan bound, shared by every journal
 * channel (backfill, the public outbox, and the SSE stream) so the tier CEILING
 * is uniform — an entry older than this is unreachable live and lives only in the
 * static archive.
 */
export function backfillFloorIso(
  tier: 0 | 1 | 2,
  now: string,
  governanceWindowSec?: number
): string {
  const window = backfillWindowForTier(tier, governanceWindowSec);
  return new Date(Date.parse(now) - window.maxAgeSec * 1000).toISOString();
}

export interface BackfillQuery {
  /** Serve entries strictly after this composite cursor; default the start. */
  after?: OutboxCursor | string;
  filter?: FederationFilter;
  /** The peer's trust tier — authoritative from the pinned peer record. */
  tier: 0 | 1 | 2;
  /** The window instant (ISO 8601); defaults to the real clock. */
  now?: string;
  limit?: number;
  /** The static archive URL served when the request reaches before the window. */
  archiveUrl?: string;
  /** The collection URL this page is part of; default "/peer/backfill". */
  partOf?: string;
  /** Extra (already-encoded) query-string appended to the `next` link. */
  nextParams?: string;
  /** Tier-2 window override in seconds; see {@link backfillWindowForTier}. */
  governanceWindowSec?: number;
}

/** An outbox page plus the beyond-window redirect: when the request's range
 *  reaches before the tier floor, `beyondWindow` is set and `archiveUrl` points
 *  at the static archive that covers the pre-floor history. */
export interface BackfillPage extends OutboxPage {
  beyondWindow?: boolean;
  archiveUrl?: string;
}

function normalizeCursor(after: OutboxCursor | string | undefined): OutboxCursor {
  if (after === undefined) return OUTBOX_CURSOR_START;
  if (typeof after !== "string") return after;
  const cursor = decodeOutboxCursor(after);
  if (cursor === null) throw new TypeError(`readBackfill: malformed cursor "${after}"`);
  return cursor;
}

/** Whether any COMMITTED entry strictly after the cursor falls before the floor
 *  — i.e. the request's range reaches into the pre-window past the archive
 *  covers. Independent of the subscriber filter: the redirect is about the time
 *  RANGE, not which types survive the filter. */
async function hasPreFloorEntries(
  sql: postgres.Sql,
  after: OutboxCursor,
  floorIso: string
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM conditions.federation_outbox
      WHERE (txid > ${after.txid}::xid8
             OR (txid = ${after.txid}::xid8 AND seq > ${after.seq}))
        AND txid < pg_snapshot_xmin(pg_current_snapshot())
        AND created_at < ${floorIso}::timestamptz
    ) AS exists`;
  return rows[0]?.exists === true;
}

/**
 * Reads one backfill page: the same composite-cursor outbox page, floored to the
 * peer's tier window. When the request's range reaches before the floor, the
 * page carries `beyondWindow: true` + the `archiveUrl` (the peer fetches the
 * static archive for the deep past); the live page still serves the in-window
 * entries after the cursor, gap-free.
 */
export async function readBackfill(sql: postgres.Sql, q: BackfillQuery): Promise<BackfillPage> {
  const nowIso = q.now ?? new Date().toISOString();
  const floorIso = backfillFloorIso(q.tier, nowIso, q.governanceWindowSec);
  const after = normalizeCursor(q.after);

  const page = await readOutbox(sql, {
    after,
    ...(q.filter !== undefined ? { filter: q.filter } : {}),
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(q.nextParams !== undefined ? { nextParams: q.nextParams } : {}),
    partOf: q.partOf ?? "/peer/backfill",
    minCreatedAt: floorIso,
    now: nowIso,
  });

  const result: BackfillPage = { ...page };
  if (await hasPreFloorEntries(sql, after, floorIso)) {
    result.beyondWindow = true;
    if (q.archiveUrl !== undefined) result.archiveUrl = q.archiveUrl;
  }
  return result;
}
