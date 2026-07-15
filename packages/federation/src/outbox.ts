/**
 * The federation outbox journal read (`conditions.federation_outbox`). The
 * journal is written exclusively by the database trigger on
 * `conditions.observations` (migration 0014) in each mutation's own
 * transaction; a peer pages it with a COMPOSITE `(txid, seq)` cursor.
 *
 * Snapshots rest reporter-stripped (the trigger removes `origin.reporter`),
 * as jsonb of the point-in-time row with GeoJSON geometry; this module maps
 * them back to the wire `Observation` shape through the same
 * `rowToObservation` mapping the read API uses. Delete entries stay minimal
 * tombstone markers.
 *
 * WHY A COMPOSITE CURSOR (the gap-free ordering authority). `seq` (bigserial)
 * advances PER ROW, but `txid` (`pg_current_xact_id()`) is assigned at a
 * transaction's FIRST write and shared by all its rows. So an earlier-txid
 * multi-row swap can hold HIGHER interleaved seqs than a later-txid concurrent
 * writer — e.g. R1 (txid 1000) writes seqs 10,12,14 and R2 (txid 1001) writes
 * 11,13. A bare `seq` cursor, even fenced by xmin, would serve R1's 10,12,14,
 * advance the reader to 14, and then permanently skip R2's 11,13 (both < 14)
 * once R2 commits. Ordering by `(txid, seq)` instead makes the cursor advance
 * in transaction order: no in-flight (higher-or-equal-txid) transaction's rows
 * can sort below the cursor's txid, so a later-committing row is always beyond
 * the composite cursor and is delivered on the next poll — never skipped. This
 * gives the plan's "eventual delivery of every matching event, no
 * double-delivery"; it does NOT promise cross-transaction total seq ordering
 * (delivery order is `(txid, seq)`, and only WITHIN one transaction is it seq
 * order) — which the plan explicitly does not require.
 */
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { rowToObservation, type Observation, type ObservationRow } from "@openconditions/core";
import { applyFederationFilter, type FederationFilter } from "./filter.js";

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

export interface OutboxEntry {
  /** The per-row bigserial (unique, but NOT the standalone cursor — see txid). */
  seq: number;
  /** The row's creating transaction id (`xid8` decimal string). */
  txid: string;
  operation: OutboxOperation;
  objectId: string;
  canonicalId: string | null;
  /** When the mutation was journalled (ISO 8601). */
  createdAt: string;
  /** The point-in-time wire observation; absent on delete entries. */
  observation?: Observation;
  /** Present (true) on delete entries — the deletion fact is the payload. */
  tombstone?: boolean;
  /** The tombstone reason on a delete entry (why the row was retracted). */
  reason?: string;
}

export interface OutboxQuery {
  /** Return entries strictly after this composite cursor; default the start.
   *  Accepts either the parsed `{txid, seq}` or its wire form `"<txid>.<seq>"`
   *  (e.g. a prior page's `highWaterMark` replayed straight back). */
  after?: OutboxCursor | string;
  filter?: FederationFilter;
  /**
   * The PUSH-CHANNEL restriction: when set, the SQL scan returns ONLY entries
   * whose event `type` is in this list (plus every delete tombstone — a
   * retraction always propagates). The frontier ({@link OutboxPage.highWaterMark})
   * is then computed over the priority subsequence, so a webhook/SSE channel's
   * cursor advances ONLY across priority events and can never be advanced past a
   * non-priority (but subscriber-filter-matching) event — that event simply is
   * not part of the push channel. Completeness for non-priority events is the
   * PEER's independent pull's job, never the push channel's. Absent → the full
   * journal is scanned (the pull contract). Applied at SQL, not post-filter, so a
   * run of >`limit` non-priority events cannot starve the channel.
   */
  priorityClasses?: readonly string[];
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
   * this page carries the priority subsequence, not every matching event — the
   * receiving peer must run an independent `/peer/outbox` pull for completeness.
   * The pull response is complete and NEVER sets this. It does not change the
   * completeness contract (the peer's own pull is the authority); it just lets a
   * defensive peer recognise a restricted page without inferring it.
   */
  priorityRestricted?: boolean;
  /** Surviving entries in `(txid, seq)` order; filtered-out entries leave gaps. */
  orderedItems: OutboxEntry[];
}

export const OUTBOX_DEFAULT_LIMIT = 100;
export const OUTBOX_MAX_LIMIT = 500;

interface JournalRow {
  seq: string;
  txid: string;
  object_id: string;
  operation: OutboxOperation;
  canonical_id: string | null;
  payload_snapshot: Record<string, unknown>;
  created_at: Date;
}

/**
 * Maps a journal payload snapshot (the reporter-stripped `to_jsonb` of the
 * observation row, geometry as GeoJSON) to the wire Observation:
 * `rowToObservation` for everything the read API also maps, plus the commons
 * substrate columns it does not carry (identity, privacy, provenance-URI).
 */
function snapshotToObservation(payload: Record<string, unknown>): Observation {
  const row = {
    ...payload,
    geojson: JSON.stringify(payload["geom"]),
    is_stale: payload["is_stale"] ?? false,
  } as unknown as ObservationRow;
  const observation = rowToObservation(row);
  const extra = payload as {
    instance_id?: string | null;
    canonical_id?: string | null;
    phenomenon_fingerprint?: string | null;
    replaces?: string[] | null;
    corroborations?: string[] | null;
    fuzziness?: string | null;
    confidence_score?: number | null;
    severity_level?: number | null;
    privacy_class?: string | null;
    k_anonymity?: number | null;
    dp_epsilon?: number | null;
    dp_delta?: number | null;
    source_uri?: string | null;
    source_license?: string | null;
  };
  return {
    ...observation,
    ...(extra.instance_id != null ? { instanceId: extra.instance_id } : {}),
    ...(extra.canonical_id != null ? { canonicalId: extra.canonical_id } : {}),
    ...(extra.phenomenon_fingerprint != null
      ? { phenomenonFingerprint: extra.phenomenon_fingerprint }
      : {}),
    ...(extra.replaces != null ? { replaces: extra.replaces } : {}),
    ...(extra.corroborations != null ? { corroborations: extra.corroborations } : {}),
    ...(extra.fuzziness != null ? { fuzziness: extra.fuzziness } : {}),
    ...(extra.confidence_score != null ? { confidenceScore: extra.confidence_score } : {}),
    ...(extra.severity_level != null ? { severityLevel: extra.severity_level } : {}),
    ...(extra.privacy_class != null ? { privacyClass: extra.privacy_class } : {}),
    ...(extra.k_anonymity != null ? { kAnonymity: extra.k_anonymity } : {}),
    ...(extra.dp_epsilon != null ? { dpEpsilon: extra.dp_epsilon } : {}),
    ...(extra.dp_delta != null ? { dpDelta: extra.dp_delta } : {}),
    ...(extra.source_uri != null ? { sourceUri: extra.source_uri } : {}),
    ...(extra.source_license != null ? { sourceLicense: extra.source_license } : {}),
  } as unknown as Observation;
}

function rowToEntry(row: JournalRow): OutboxEntry {
  const base = {
    seq: Number(row.seq),
    txid: row.txid,
    objectId: row.object_id,
    canonicalId: row.canonical_id,
    createdAt: row.created_at.toISOString(),
  };
  if (row.operation === "delete") {
    const reason = row.payload_snapshot["reason"];
    return {
      ...base,
      operation: "delete",
      tombstone: true,
      ...(typeof reason === "string" ? { reason } : {}),
    };
  }
  return {
    ...base,
    operation: row.operation,
    observation: snapshotToObservation(row.payload_snapshot),
  };
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
 *    (its txid is higher) and delivered later — the interleaving skip a bare
 *    seq cursor suffers is structurally impossible;
 *  - the xmin fence (`txid < pg_snapshot_xmin(pg_current_snapshot())`) refuses
 *    to serve any row whose creating transaction — or any older one — could
 *    still be in flight, so the cursor never advances past a txid that has not
 *    fully settled. Together: no skip under arbitrary interleaving, at the cost
 *    of a bounded delivery delay while a long writer transaction is open.
 *
 * `highWaterMark` is the composite cursor of the last SCANNED row (so an
 * all-filtered page still advances the subscriber), wire-encoded, and equals
 * the request `after` when nothing stable is new. Re-reading the same cursor is
 * idempotent — the journal is append-only and never rewritten.
 */
export async function readOutbox(sql: postgres.Sql, q: OutboxQuery): Promise<OutboxPage> {
  const after = normalizeCursor(q.after);
  const limit = Math.min(Math.max(q.limit ?? OUTBOX_DEFAULT_LIMIT, 1), OUTBOX_MAX_LIMIT);
  const partOf = q.partOf ?? "/peer/outbox";
  const now = q.now ?? new Date().toISOString();

  // The push-channel restriction, applied AT SQL so the frontier is over the
  // priority subsequence (a delete tombstone always stays in the channel).
  const priorityClause =
    q.priorityClasses && q.priorityClasses.length > 0
      ? sql`AND (operation = 'delete'
                 OR payload_snapshot->>'type' = ANY(${[...q.priorityClasses]}))`
      : sql``;

  // The tier-bounded backfill floor: only entries at or after this instant are
  // scanned. Composed with the cursor + fence, so within-floor gap-freeness holds.
  const floorClause =
    q.minCreatedAt !== undefined ? sql`AND created_at >= ${q.minCreatedAt}::timestamptz` : sql``;

  const rows = await sql<JournalRow[]>`
    SELECT seq::text AS seq, txid::text AS txid, object_id, operation,
           canonical_id, payload_snapshot, created_at
    FROM conditions.federation_outbox
    WHERE (txid > ${after.txid}::xid8
           OR (txid = ${after.txid}::xid8 AND seq > ${after.seq}))
      AND txid < pg_snapshot_xmin(pg_current_snapshot())
      ${priorityClause}
      ${floorClause}
    ORDER BY txid ASC, seq ASC
    LIMIT ${limit}`;

  const last = rows.length > 0 ? rows[rows.length - 1]! : undefined;
  const frontier: OutboxCursor = last ? { txid: last.txid, seq: Number(last.seq) } : after;
  const highWaterMark = encodeOutboxCursor(frontier);
  const orderedItems = applyFederationFilter(rows.map(rowToEntry), q.filter, now);

  const page: OutboxPage = { type: "OrderedCollectionPage", partOf, highWaterMark, orderedItems };
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
  filter: FederationFilter | undefined,
  tier?: 0 | 1 | 2
): string {
  const canon = JSON.stringify(
    sortedCanonical({
      after: encodeOutboxCursor(after),
      limit,
      filter: filter ?? null,
      tier: tier ?? null,
    })
  );
  const hash = createHash("sha256").update(canon).digest("hex").slice(0, 16);
  return `"${height}-${hash}"`;
}
