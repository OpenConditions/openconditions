/**
 * The federation outbox journal read (`conditions.federation_outbox`). The
 * journal is written by the database triggers on the record tables
 * (migration `record_outbox_capture`) in each change's own transaction, and
 * by the boot's reconcile of a source whose `restricted` flag flipped
 * (`reconcileFederation`), in the same shape; a peer pages it with a
 * COMPOSITE `(txid, seq)` cursor.
 *
 * Each entry is one record change: its class, id, kind, domain and property
 * as columns, and the stored record (with a crowd report's evidence) as the
 * snapshot. A page carries what the outbox may carry of each
 * (`federatedSnapshot`: the reporter stripped, extras only from a source that
 * federates them; nothing of a source now restricted) and only what the
 * subscriber's filter keeps (`applyRecordFilter`). Delete entries carry the
 * reason and no record.
 *
 * WHY A COMPOSITE CURSOR (the gap-free ordering authority). `seq` (bigserial)
 * advances PER ROW, but `txid` (`pg_current_xact_id()`) is assigned at a
 * transaction's FIRST write and shared by all its rows. So an earlier-txid
 * multi-row write can hold HIGHER interleaved seqs than a later-txid concurrent
 * writer — e.g. R1 (txid 1000) writes seqs 10,12,14 and R2 (txid 1001) writes
 * 11,13. A bare `seq` cursor, even fenced by xmin, would serve R1's 10,12,14,
 * advance the reader to 14, and then permanently skip R2's 11,13 (both < 14)
 * once R2 commits. Ordering by `(txid, seq)` instead makes the cursor advance
 * in transaction order: no in-flight (higher-or-equal-txid) transaction's rows
 * can sort below the cursor's txid, so a later-committing row is always beyond
 * the composite cursor and is delivered on the next poll — never skipped.
 * Delivery order is `(txid, seq)`; only WITHIN one transaction is it seq order.
 */
import { createHash } from "node:crypto";
import type { RecordClass } from "@openconditions/model";
import type postgres from "postgres";
import {
  applyRecordFilter,
  type FederatedRecord,
  federatedSnapshot,
  type RecordFilter,
  type RecordOutboxEntry,
} from "./record-filter.js";

export type OutboxOperation = "create" | "update" | "delete";

/**
 * The composite journal cursor. `txid` is the row's creating transaction id
 * (`xid8`, kept as a decimal string — it is 64-bit and monotonic but not a
 * safe JS integer over a long-lived DB); `seq` is the per-row bigserial. The
 * ordering authority is `(txid, seq)` ascending.
 */
export interface OutboxCursor {
  txid: string;
  seq: number;
}

/** The cursor floor that serves the whole journal from the start. */
export const OUTBOX_CURSOR_START: OutboxCursor = { txid: "0", seq: 0 };

/** Encodes a cursor for the wire as `"<txid>.<seq>"` (both URL-safe). */
export function encodeOutboxCursor(cursor: OutboxCursor): string {
  return `${cursor.txid}.${cursor.seq}`;
}

/**
 * Parses a `"<txid>.<seq>"` wire cursor. Returns null (never throws) on any
 * malformed input so callers fail closed (the route answers 400). Both parts
 * must be non-negative decimal integers; `seq` must be a safe JS integer.
 */
export function decodeOutboxCursor(value: string): OutboxCursor | null {
  const match = /^(\d+)\.(\d+)$/.exec(value);
  if (match === null) return null;
  const seq = Number(match[2]);
  if (!Number.isSafeInteger(seq)) return null;
  return { txid: match[1]!, seq };
}

/** Coerces the `after` union to a cursor; a wire string round-trips through
 *  {@link decodeOutboxCursor} (throws on a malformed non-null string so a bad
 *  internal cursor fails loudly — the route validates untrusted input first). */
function normalizeCursor(after: OutboxCursor | string | undefined): OutboxCursor {
  if (after === undefined) return OUTBOX_CURSOR_START;
  if (typeof after !== "string") return after;
  const cursor = decodeOutboxCursor(after);
  if (cursor === null) throw new TypeError(`readOutbox: malformed cursor "${after}"`);
  return cursor;
}

export interface OutboxQuery {
  /** Return entries strictly after this composite cursor; default the start.
   *  Accepts either the parsed `{txid, seq}` or its wire form `"<txid>.<seq>"`
   *  (e.g. a prior page's `highWaterMark` replayed straight back). */
  after?: OutboxCursor | string;
  filter?: RecordFilter;
  /**
   * The PUSH-CHANNEL restriction: when set, the SQL scan returns ONLY priority
   * entries (a situation that closes a road or all its lanes, or an incident)
   * plus every delete — a retraction always propagates. The frontier
   * ({@link OutboxPage.highWaterMark}) is then computed over the priority
   * subsequence, so a webhook/SSE channel's cursor advances ONLY across
   * priority entries and can never be advanced past a non-priority (but
   * subscriber-filter-matching) one — that entry simply is not part of the push
   * channel. Completeness is the PEER's independent pull's job, never the push
   * channel's. Applied at SQL, not post-filter, so a run of >`limit`
   * non-priority entries cannot starve the channel.
   */
  priorityOnly?: boolean;
  /**
   * A LOWER TIME FLOOR (ISO 8601): when set, only entries whose `created_at` is
   * `>=` this instant are scanned — composed as an ADDITIONAL `WHERE` alongside
   * the composite cursor and the xmin fence, so gap-freeness within the floor is
   * preserved (pre-floor entries are simply never scanned, never counted against
   * the limit). Used by tier-bounded backfill; the live pull never sets it.
   */
  minCreatedAt?: string;
  /** Page size; default {@link OUTBOX_DEFAULT_LIMIT}, capped at {@link OUTBOX_MAX_LIMIT}. */
  limit?: number;
  /** The collection URL this page is part of; default "/peer/outbox". */
  partOf?: string;
  /** Extra query-string (already encoded) appended to the `next` link so a
   *  subscriber's filter survives pagination. */
  nextParams?: string;
  /** Filter evaluation instant (ISO 8601); defaults to the real clock. */
  now?: string;
}

export interface OutboxPage {
  type: "OrderedCollectionPage";
  partOf: string;
  next?: string;
  /**
   * The `(txid, seq)` composite cursor of the last entry this query SCANNED,
   * wire-encoded — an all-filtered page still advances it. Equal to the request
   * `after` (encoded) when nothing stable is new. This is the exact string a
   * subscriber stores and replays as `after` on its next poll.
   */
  highWaterMark: string;
  /**
   * Set (true) ONLY on a `priorityOnly` PUSH page: a self-describing hint that
   * this page carries the priority subsequence, not every matching entry — the
   * receiving peer must run an independent `/peer/outbox` pull for completeness.
   * The pull response is complete and NEVER sets this.
   */
  priorityRestricted?: boolean;
  /** Surviving entries in `(txid, seq)` order; filtered-out entries leave gaps. */
  orderedItems: RecordOutboxEntry[];
}

export const OUTBOX_DEFAULT_LIMIT = 100;
export const OUTBOX_MAX_LIMIT = 500;

interface JournalRow {
  seq: string;
  txid: string;
  operation: OutboxOperation;
  record_class: RecordClass;
  record_id: string;
  canonical_id: string | null;
  kind: string;
  domain: string;
  property: string | null;
  snapshot: FederatedRecord | null;
  tombstone_reason: string | null;
  created_at: Date;
  extras_federate: boolean | null;
  restricted: boolean | null;
}

/**
 * The wire entry of a journal row; undefined for a record the outbox never
 * carries. A change of a source restricted since it was journalled is
 * withheld; its delete still goes out, so a subscriber ends its copy.
 */
function rowToEntry(row: JournalRow): RecordOutboxEntry | undefined {
  const base = {
    seq: Number(row.seq),
    txid: row.txid,
    recordClass: row.record_class,
    recordId: row.record_id,
    canonicalId: row.canonical_id,
    kind: row.kind,
    domain: row.domain,
    ...(row.property === null ? {} : { property: row.property }),
    createdAt: row.created_at.toISOString(),
  };
  if (row.operation === "delete") {
    return {
      ...base,
      operation: "delete",
      tombstone: true,
      ...(row.tombstone_reason === null ? {} : { reason: row.tombstone_reason }),
    };
  }
  const record =
    row.snapshot === null || row.restricted === true
      ? undefined
      : federatedSnapshot(row.snapshot, { federateExtras: row.extras_federate === true });
  return record === undefined ? undefined : { ...base, operation: row.operation, record };
}

/**
 * Reads one outbox page: entries strictly after the composite `(txid, seq)`
 * cursor, in `(txid, seq)` order, `limit` rows scanned at most, with the
 * subscriber's filter applied at source.
 *
 * TWO defences, both load-bearing and both required:
 *  - the `(txid, seq)` composite cursor + `ORDER BY txid, seq` makes the cursor
 *    advance in TRANSACTION order, so a later-committing transaction whose rows
 *    interleave BELOW an earlier transaction's seqs is still beyond the cursor
 *    (its txid is higher) and delivered later;
 *  - the xmin fence (`txid < pg_snapshot_xmin(pg_current_snapshot())`) refuses
 *    to serve any row whose creating transaction — or any older one — could
 *    still be in flight, so the cursor never advances past a txid that has not
 *    fully settled. Together: no skip under arbitrary interleaving, at the cost
 *    of a bounded delivery delay while a long writer transaction is open.
 *
 * `highWaterMark` is the composite cursor of the last SCANNED row (so an
 * all-filtered page still advances the subscriber), wire-encoded, and equals
 * the request `after` when nothing stable is new. Re-reading the same cursor is
 * idempotent — the journal is append-only.
 */
export async function readOutbox(sql: postgres.Sql, q: OutboxQuery): Promise<OutboxPage> {
  const after = normalizeCursor(q.after);
  const limit = Math.min(Math.max(q.limit ?? OUTBOX_DEFAULT_LIMIT, 1), OUTBOX_MAX_LIMIT);
  const partOf = q.partOf ?? "/peer/outbox";
  const now = q.now ?? new Date().toISOString();

  // The push-channel restriction, applied AT SQL so the frontier is over the
  // priority subsequence (a delete always stays in the channel).
  const priorityClause = q.priorityOnly ? sql`AND (o.operation = 'delete' OR o.priority)` : sql``;

  // The tier-bounded backfill floor: only entries at or after this instant are
  // scanned. Composed with the cursor + fence, so within-floor gap-freeness holds.
  const floorClause =
    q.minCreatedAt !== undefined ? sql`AND o.created_at >= ${q.minCreatedAt}::timestamptz` : sql``;

  const rows = await sql<JournalRow[]>`
    SELECT o.seq::text AS seq, o.txid::text AS txid, o.operation, o.record_class, o.record_id,
           o.canonical_id, o.kind, o.domain, o.property, o.snapshot, o.tombstone_reason,
           o.created_at, src.extras_federate, src.restricted
    FROM conditions.federation_outbox o
    LEFT JOIN conditions.source src ON src.id = o.snapshot #>> '{provenance,sourceId}'
    WHERE (o.txid > ${after.txid}::xid8
           OR (o.txid = ${after.txid}::xid8 AND o.seq > ${after.seq}))
      AND o.txid < pg_snapshot_xmin(pg_current_snapshot())
      ${priorityClause}
      ${floorClause}
    ORDER BY o.txid ASC, o.seq ASC
    LIMIT ${limit}`;

  const last = rows.length > 0 ? rows[rows.length - 1]! : undefined;
  const frontier: OutboxCursor = last ? { txid: last.txid, seq: Number(last.seq) } : after;
  const highWaterMark = encodeOutboxCursor(frontier);
  const entries = rows.map(rowToEntry).filter((e): e is RecordOutboxEntry => e !== undefined);
  const orderedItems = applyRecordFilter(entries, q.filter, now);

  const page: OutboxPage = { type: "OrderedCollectionPage", partOf, highWaterMark, orderedItems };
  if (q.priorityOnly) page.priorityRestricted = true;
  if (rows.length === limit) {
    const params = q.nextParams ? `&${q.nextParams}` : "";
    page.next = `${partOf}?after=${highWaterMark}${params}`;
  }
  return page;
}

function sortedCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedCanonical);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortedCanonical((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * The STRONG ETag for a page: `"<height>-<hash(after+limit+filter)>"`. The
 * `height` is the FENCED page's own composite frontier
 * ({@link OutboxPage.highWaterMark}, the encoded `(txid, seq)`) — deriving it
 * from the same query that built the body makes the ETag and the body one
 * consistent snapshot (a row landing between two queries cannot make the body
 * outrun the ETag height). It advances exactly when this representation's
 * stable content changes; the composite `after`, `limit`, and the filter are
 * all folded in so two requests that differ in any of them never share a strong
 * ETag (a different `limit` is a different representation, not a false 304). The
 * requester's tier is folded in too: an anonymous (Tier-0) and an authenticated
 * (Tier-1/2) request see a different time-floored window at the same cursor and
 * must never collide on one ETag.
 */
export function outboxEtag(
  height: string,
  after: OutboxCursor,
  limit: number,
  filter: RecordFilter | undefined,
  tier?: 0 | 1 | 2,
): string {
  const canon = JSON.stringify(
    sortedCanonical({
      after: encodeOutboxCursor(after),
      limit,
      filter: filter ?? null,
      tier: tier ?? null,
    }),
  );
  const hash = createHash("sha256").update(canon).digest("hex").slice(0, 16);
  return `"${height}-${hash}"`;
}
