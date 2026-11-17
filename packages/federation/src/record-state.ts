/**
 * The publisher's present state of its records, for a subscriber to compare
 * its copies with. The journal says what changed, and twice it cannot say
 * enough: for changes older than the window a subscriber may read (a delete
 * or an erasure is in no archive) and for a history the publisher no longer
 * has (it was restored to an older backup and started a new epoch). Two
 * signed routes let a subscriber compare instead:
 *
 * - `GET /peer/state` lists the live records the outbox may carry to the
 *   requester, as `(id, revision, recordedAt)`, in byte order of their ids,
 *   with the requester's filter applied ({@link readRecordState});
 * - `POST /peer/records` answers for named records with the publisher's
 *   current state of each: a `create` entry carrying the record as the
 *   journal would carry it now, a `delete` entry for one that ended, or the
 *   id listed as unknown ({@link readRecords}).
 *
 * Both carry what the outbox carries and nothing more (`federation_may_carry`,
 * the snapshot the outbox serves, only public licences), but are not bounded
 * by the requester's journal window: the window bounds the journal, not what
 * a peer may hold. Readings are outside both: a subscriber keeps no tombstone
 * of an observation, and a newer reading replaces an older one.
 *
 * The parsers ({@link readRecordStatePage}, {@link readRecordsPage}) are what
 * a subscriber checks an answer against before it acts on it.
 */
import type postgres from "postgres";
import {
  entryBytes,
  OUTBOX_CURSOR_START,
  OUTBOX_PAGE_MAX_ENTRY_BYTES,
  readCursorStanding,
  type WithheldEntry,
} from "./outbox.js";
import {
  applyRecordFilter,
  type FederatedRecord,
  federatedSnapshot,
  type RecordFilter,
  type RecordOutboxEntry,
} from "./record-filter.js";

/** The record classes the state routes answer for, in the order a subscriber compares them. */
export const RECORD_STATE_CLASSES = ["feature", "situation", "offer"] as const;
export type RecordStateClass = (typeof RECORD_STATE_CLASSES)[number];

/** Rows a state listing scans at most per page, and its default. */
export const RECORD_STATE_PAGE_LIMIT = 1000;

/** Ids one records request may name at most. */
export const RECORDS_MAX_IDS = 100;

/** The longest record id, in UTF-8 bytes, a records request may name or a listing may continue after. */
export const RECORD_ID_MAX_BYTES = 512;

/** The longest journal epoch a page may name. */
const MAX_EPOCH_LENGTH = 64;

export function isRecordStateClass(value: unknown): value is RecordStateClass {
  return (RECORD_STATE_CLASSES as readonly unknown[]).includes(value);
}

/** Orders two record ids by their UTF-8 bytes, as `COLLATE "C"` does. */
export function compareRecordIds(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** One live record of a state listing: the version the publisher holds. */
export interface RecordStateItem {
  id: string;
  revision: number;
  recordedAt: string;
}

export interface RecordStatePage {
  type: "RecordStatePage";
  epoch: string;
  class: RecordStateClass;
  items: RecordStateItem[];
  /** The id of the last row scanned; present, with `next`, when the page scanned its limit. */
  through?: string;
  next?: string;
}

export interface RecordsPage {
  type: "RecordsPage";
  epoch: string;
  class: RecordStateClass;
  /** One entry per answered id, in request order, in the shape of an outbox page's entries. */
  orderedItems: RecordOutboxEntry[];
  /** Ids with no record of the class here, or one another instance owns. */
  unknown: string[];
  /** Ids not reached within the page's byte budget, to be asked again. */
  unanswered: string[];
  /** Ids whose entry alone is larger than a page may be. */
  withheld: string[];
}

interface StateRow {
  id: string;
  revision: number;
  recorded_at: Date;
  canonical_id: string | null;
  kind: string;
  domain: string;
  snapshot: FederatedRecord;
  extras_federate: boolean | null;
}

/** The journal's epoch: the history the state belongs to. */
async function journalEpoch(sql: postgres.Sql): Promise<string> {
  return (await readCursorStanding(sql, OUTBOX_CURSOR_START)).epoch;
}

/** The snapshot of a row as the journal carries it: a situation with its evidence. */
const snapshotOf = (cls: RecordStateClass) =>
  cls === "situation" ? "conditions.federation_situation_snapshot(r)" : "r.record";

/** A create entry of a stored record, as the journal would carry it now. */
function createEntry(
  cls: RecordStateClass,
  row: Omit<StateRow, "recorded_at" | "revision">,
  now: string,
): RecordOutboxEntry | undefined {
  const record = federatedSnapshot(row.snapshot, { federateExtras: row.extras_federate === true });
  if (record === undefined) return undefined;
  return {
    seq: 0,
    txid: "0",
    operation: "create",
    recordClass: cls,
    recordId: row.id,
    canonicalId: row.canonical_id,
    kind: row.kind,
    domain: row.domain,
    createdAt: now,
    record,
  };
}

/**
 * The statement a state listing page reads: up to `limit` live records of
 * `cls` the outbox may carry, after `after` in byte order. The bound is in
 * the statement only when there is one, so the planner walks the index on
 * `id COLLATE "C"` from it instead of sorting the class.
 */
export function recordStateStatement(
  cls: RecordStateClass,
  after: string | undefined,
  limit: number,
): { text: string; params: (string | number)[] } {
  const bound = after === undefined ? "" : `AND r.id COLLATE "C" > $2::text COLLATE "C"`;
  return {
    text: `SELECT r.id, r.revision, r.recorded_at, r.canonical_id, r.kind, r.domain,
                  ${snapshotOf(cls)} AS snapshot, src.extras_federate
             FROM conditions.${cls} r
             LEFT JOIN conditions.source src ON src.id = r.source_id
            WHERE r.tombstoned_at IS NULL
              AND conditions.federation_may_carry(r.record, r.access_mode, r.source_id)
              ${bound}
            ORDER BY r.id COLLATE "C"
            LIMIT $1`,
    params: after === undefined ? [limit] : [limit, after],
  };
}

export interface RecordStateQuery {
  cls: RecordStateClass;
  /** Continue strictly after this record id, in byte order. */
  after?: string;
  /** Rows scanned at most; default and maximum {@link RECORD_STATE_PAGE_LIMIT}. */
  limit?: number;
  /** The requester's filter, as its journal reads apply it. */
  filter?: RecordFilter;
  /** The listing's URL, without a query; `next` continues it. */
  partOf: string;
  /** Already encoded filter and limit parameters for the `next` link. */
  nextParams?: string;
  /** The filter's evaluation instant (ISO 8601); default the real clock. */
  now?: string;
}

/**
 * One page of the live records the outbox may carry, in byte order of their
 * ids after `after`: up to `limit` rows are scanned, and those the
 * requester's filter keeps (as a create its journal reads would serve) are
 * listed with the revision and `recordedAt` of the stored row. A page that
 * scanned its limit names the last id scanned (`through`) and the next page;
 * one without them reached the end of the class.
 */
export async function readRecordState(
  sql: postgres.Sql,
  q: RecordStateQuery,
): Promise<RecordStatePage> {
  const limit = Math.min(Math.max(q.limit ?? RECORD_STATE_PAGE_LIMIT, 1), RECORD_STATE_PAGE_LIMIT);
  const now = q.now ?? new Date().toISOString();
  const epoch = await journalEpoch(sql);
  const statement = recordStateStatement(q.cls, q.after, limit);
  const rows = await sql.unsafe<StateRow[]>(statement.text, statement.params as never);
  const versions = new Map(rows.map((row) => [row.id, row]));
  const entries = rows
    .map((row) => createEntry(q.cls, row, now))
    .filter((e): e is RecordOutboxEntry => e !== undefined);
  const items: RecordStateItem[] = [];
  for (const kept of applyRecordFilter(entries, q.filter, now)) {
    if (kept.operation !== "create") continue;
    const row = versions.get(kept.recordId)!;
    items.push({ id: row.id, revision: row.revision, recordedAt: row.recorded_at.toISOString() });
  }
  const page: RecordStatePage = { type: "RecordStatePage", epoch, class: q.cls, items };
  if (rows.length === limit) {
    const through = rows[rows.length - 1]!.id;
    const query = new URLSearchParams({ class: q.cls, after: through });
    page.through = through;
    page.next = `${q.partOf}?${query}${q.nextParams ? `&${q.nextParams}` : ""}`;
  }
  return page;
}

export interface RecordsQuery {
  cls: RecordStateClass;
  /** Distinct record ids, in the order they are answered. */
  ids: readonly string[];
  /** The answer's instant (ISO 8601); default the real clock. */
  now?: string;
}

interface RecordsRow extends StateRow {
  ended: boolean;
  tombstone_reason: string | null;
  own: boolean;
  may_carry: boolean;
  shared: boolean;
}

/**
 * The publisher's current state of named records of one class, in request
 * order: a live record the outbox may carry is a `create` entry carrying it
 * as the journal would carry it now; one that ended is a `delete` entry with
 * its reason at the row's revision, but only when a peer may hold the record
 * (`federation_was_shared`, the rule the journal's own deletes follow); an id
 * with no record of the class, one another instance owns, one ended that no
 * peer can hold, or one live but not to be carried (its source turned
 * restricted, its licence is not public) is unknown, so the answer says
 * nothing of a record the outbox does not carry. A subscriber ends its copy
 * of an unknown record as withdrawn, which is all a delete would have told
 * it. The requester's filter is not applied: it asks about records it holds. Entries are added while their total stays within
 * the page budget; the ids not reached are unanswered, and one whose entry
 * alone is over the budget is withheld.
 */
export async function readRecords(
  sql: postgres.Sql,
  q: RecordsQuery,
): Promise<{ page: RecordsPage; withheld: WithheldEntry[] }> {
  const now = q.now ?? new Date().toISOString();
  const epoch = await journalEpoch(sql);
  const rows = await sql.unsafe<RecordsRow[]>(
    `SELECT r.id, r.revision, r.recorded_at, r.canonical_id, r.kind, r.domain,
            r.tombstoned_at IS NOT NULL AS ended, r.tombstone_reason,
            conditions.federation_is_own(r.record, r.access_mode) AS own,
            conditions.federation_may_carry(r.record, r.access_mode, r.source_id) AS may_carry,
            conditions.federation_was_shared('${q.cls}', r.id, r.created_at, r.source_id)
              AS shared,
            ${snapshotOf(q.cls)} AS snapshot, src.extras_federate
       FROM conditions.${q.cls} r
       LEFT JOIN conditions.source src ON src.id = r.source_id
      WHERE r.id = ANY($1::text[])`,
    [q.ids as string[]],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const page: RecordsPage = {
    type: "RecordsPage",
    epoch,
    class: q.cls,
    orderedItems: [],
    unknown: [],
    unanswered: [],
    withheld: [],
  };
  const withheld: WithheldEntry[] = [];
  let bytes = 0;
  for (const [index, id] of q.ids.entries()) {
    const row = byId.get(id);
    const entry = row === undefined || !row.own ? undefined : stateEntry(q.cls, row, now);
    if (entry === undefined) {
      page.unknown.push(id);
      continue;
    }
    const size = entryBytes(entry);
    if (size > OUTBOX_PAGE_MAX_ENTRY_BYTES) {
      page.withheld.push(id);
      withheld.push({ recordClass: q.cls, recordId: id, bytes: size });
      continue;
    }
    if (bytes + size > OUTBOX_PAGE_MAX_ENTRY_BYTES) {
      page.unanswered.push(...q.ids.slice(index));
      break;
    }
    page.orderedItems.push(entry);
    bytes += size;
  }
  return { page, withheld };
}

/** The entry answering for a row this instance owns; undefined for one never federated. */
function stateEntry(
  cls: RecordStateClass,
  row: RecordsRow,
  now: string,
): RecordOutboxEntry | undefined {
  const retraction = (reason: string): RecordOutboxEntry => ({
    seq: 0,
    txid: "0",
    operation: "delete",
    recordClass: cls,
    recordId: row.id,
    canonicalId: row.canonical_id,
    kind: row.kind,
    domain: row.domain,
    createdAt: now,
    tombstone: true,
    reason,
    revision: row.revision,
  });
  if (row.ended) {
    // A record no peer can have held is not named, not even by a delete.
    return row.shared ? retraction(row.tombstone_reason ?? "withdrawn") : undefined;
  }
  // A live record the outbox does not carry is not named either.
  if (!row.may_carry) return undefined;
  const created = createEntry(cls, row, now);
  // An on-demand answer or a fused row never leaves the instance.
  if (created === undefined) return undefined;
  // What every journal read applies whatever the filter: only public
  // licences leave, and a report the crowd withdrew goes out as a delete.
  const [served] = applyRecordFilter([created], { minEvidenceTier: "self_reported" }, now);
  return served;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isEpoch = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_EPOCH_LENGTH;

/**
 * Checks a state listing answering a request for `cls` after `after` with at
 * most `limit` rows: its epoch and class, items with an id, a revision of at
 * least 1 and a readable `recordedAt`, in strictly ascending byte order after
 * `after` and up to `through`, and `through` and `next` present together.
 */
export function readRecordStatePage(
  body: unknown,
  ask: { cls: RecordStateClass; after?: string; limit: number },
): Parsed<RecordStatePage> {
  if (!isObject(body) || body["type"] !== "RecordStatePage") {
    return { ok: false, reason: "the answer is not a record state page" };
  }
  if (!isEpoch(body["epoch"])) return { ok: false, reason: "the page names no journal epoch" };
  if (body["class"] !== ask.cls) return { ok: false, reason: "the page is of another class" };
  const { items, through, next } = body;
  if (!Array.isArray(items) || items.length > ask.limit) {
    return { ok: false, reason: "the page carries no items, or more than were asked for" };
  }
  const hasThrough = through !== undefined;
  if (
    hasThrough !== (next !== undefined) ||
    (hasThrough && (typeof through !== "string" || through.length === 0)) ||
    (next !== undefined && typeof next !== "string")
  ) {
    return { ok: false, reason: "the page names through and next only together" };
  }
  let previous = ask.after;
  const parsed: RecordStateItem[] = [];
  for (const item of items) {
    if (
      !isObject(item) ||
      typeof item["id"] !== "string" ||
      item["id"].length === 0 ||
      !Number.isSafeInteger(item["revision"]) ||
      (item["revision"] as number) < 1 ||
      typeof item["recordedAt"] !== "string" ||
      !Number.isFinite(Date.parse(item["recordedAt"]))
    ) {
      return { ok: false, reason: "the page carries a malformed item" };
    }
    const id = item["id"];
    if (previous !== undefined && compareRecordIds(id, previous) <= 0) {
      return { ok: false, reason: "the page's items are not in order after the id asked for" };
    }
    if (hasThrough && compareRecordIds(id, through as string) > 0) {
      return { ok: false, reason: "the page lists an item beyond its through" };
    }
    previous = id;
    parsed.push({ id, revision: item["revision"] as number, recordedAt: item["recordedAt"] });
  }
  if (
    hasThrough &&
    ask.after !== undefined &&
    compareRecordIds(through as string, ask.after) <= 0
  ) {
    return { ok: false, reason: "the page's through is not after the id asked for" };
  }
  return {
    ok: true,
    value: {
      type: "RecordStatePage",
      epoch: body["epoch"],
      class: ask.cls,
      items: parsed,
      ...(hasThrough ? { through: through as string, next: next as string } : {}),
    },
  };
}

/**
 * Checks a records answer to a request for `ids` of `cls`: its epoch and
 * class, the three id lists, and every id it names (in an entry or a list)
 * one that was asked for, and every id asked for exactly once. The entries themselves are read as
 * any inbound entry is when they land.
 */
export function readRecordsPage(
  body: unknown,
  ask: { cls: RecordStateClass; ids: readonly string[] },
): Parsed<RecordsPage> {
  if (!isObject(body) || body["type"] !== "RecordsPage") {
    return { ok: false, reason: "the answer is not a records page" };
  }
  if (!isEpoch(body["epoch"])) return { ok: false, reason: "the page names no journal epoch" };
  if (body["class"] !== ask.cls) return { ok: false, reason: "the page is of another class" };
  const lists = ["unknown", "unanswered", "withheld"] as const;
  const items = body["orderedItems"];
  if (
    !Array.isArray(items) ||
    lists.some((name) => {
      const list = body[name];
      return !Array.isArray(list) || !list.every((id) => typeof id === "string");
    })
  ) {
    return { ok: false, reason: "the page lacks its entries or one of its id lists" };
  }
  const asked = new Set(ask.ids);
  const named = new Set<string>();
  const name = (id: unknown) => {
    if (typeof id !== "string" || !asked.has(id) || named.has(id)) return false;
    named.add(id);
    return true;
  };
  for (const item of items) {
    if (!isObject(item) || item["recordClass"] !== ask.cls || !name(item["recordId"])) {
      return { ok: false, reason: "the page answers for a record that was not asked for" };
    }
  }
  for (const list of lists) {
    if (!(body[list] as string[]).every(name)) {
      return { ok: false, reason: "the page answers for a record that was not asked for" };
    }
  }
  if (named.size !== asked.size) {
    return { ok: false, reason: "the page leaves out a record that was asked for" };
  }
  return {
    ok: true,
    value: {
      type: "RecordsPage",
      epoch: body["epoch"],
      class: ask.cls,
      orderedItems: items as RecordOutboxEntry[],
      unknown: body["unknown"] as string[],
      unanswered: body["unanswered"] as string[],
      withheld: body["withheld"] as string[],
    },
  };
}

/**
 * Checks a records request body: `{ "class", "ids" }` and nothing else, a
 * class the routes answer for, and 1 to {@link RECORDS_MAX_IDS} distinct
 * non-empty ids of at most {@link RECORD_ID_MAX_BYTES} bytes each.
 */
export function readRecordsRequest(
  body: unknown,
): Parsed<{ cls: RecordStateClass; ids: string[] }> {
  if (!isObject(body)) return { ok: false, reason: "the body must be a JSON object" };
  const extra = Object.keys(body).find((key) => key !== "class" && key !== "ids");
  if (extra !== undefined) return { ok: false, reason: `${extra} is not a field of the request` };
  if (!isRecordStateClass(body["class"])) {
    return { ok: false, reason: `class must be one of ${RECORD_STATE_CLASSES.join(", ")}` };
  }
  const ids = body["ids"];
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > RECORDS_MAX_IDS ||
    !ids.every(
      (id) =>
        typeof id === "string" &&
        id.length > 0 &&
        Buffer.byteLength(id, "utf8") <= RECORD_ID_MAX_BYTES,
    ) ||
    new Set(ids).size !== ids.length
  ) {
    return {
      ok: false,
      reason: `ids must be 1 to ${RECORDS_MAX_IDS} distinct non-empty strings of at most ${RECORD_ID_MAX_BYTES} bytes`,
    };
  }
  return { ok: true, value: { cls: body["class"], ids: ids as string[] } };
}
