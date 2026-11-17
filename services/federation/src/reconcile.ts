/**
 * Comparing this instance's copies of a peer's records with the peer's
 * present state, and repairing them. The journal tells a subscriber what
 * changed, and twice it cannot: for changes older than the window the
 * subscriber may read (a delete or an erasure is in no archive, and the
 * archive is narrower than the journal), and for a history the peer no longer
 * has (it was restored to an older backup and started a new epoch). The
 * puller makes a comparison due in both cases (`reconcile_due_since`), and
 * the main loop runs it once the pull reached the peer's live tail.
 *
 * For each class in turn (feature, situation, offer), the peer's listing of
 * its live records (`GET /peer/state`, filtered by this instance's pull
 * filter for the peer) is read page by page, each page checked as a pulled
 * page is (the peer's signature under a pinned key, bound to the request, its
 * size, its shape) and of the epoch the cursor is kept with. For the ids the
 * page covers, the copies held here are read and compared by version
 * (`revision`, `recordedAt`, as the peer sealed them): a record listed and
 * not held, or held at another version, is asked for (`POST /peer/records`),
 * and so is a copy held live that the listing leaves out while the pull
 * filter still keeps it. The answers land as the peer states them
 * (`landStatedEntries`); a copy of a record the peer does not know is retired
 * as `withdrawn` at the revision held, so a later delivery restores it.
 *
 * ORDER OF READS (load-bearing). The copies held here are read only after the
 * listing page arrived, and a copy is retired only on the peer's answer to a
 * request made after that read. So a copy held at the read and unknown to the
 * peer at its answer was gone from the peer after this instance held it; it
 * cannot be a record created and delivered in between. Each answer lands
 * against the version read, checked again under the record's lock, so what a
 * push or a pull landed since is never overwritten.
 *
 * The comparison runs for a time slice ({@link RECONCILE_SLICE_MS}) and stores
 * how far it got after every page, so it resumes there in the next round or
 * after a restart; a new reset or beyond-window page starts it over. Readings
 * are not compared: a subscriber keeps no tombstone of an observation, and a
 * newer reading replaces an older one. An answer that cannot land here is
 * counted as refused, not against the peer's health: it would be refused
 * again at every comparison.
 */

import type { InboxDeps } from "@openconditions/contributions-api/federation/inbox";
import {
  type HeldVersion,
  landStatedEntries,
  retireRecords,
} from "@openconditions/contributions-api/federation/inbox";
import {
  type AnsweredRequest,
  applyRecordFilter,
  compareVersions,
  type FederatedRecord,
  type InstanceKey,
  isPeerBlocked,
  loadPeerProtocolVersion,
  loadPeerVersions,
  type NonceStore,
  type PeerRecord,
  peerRouteUrl,
  RECORD_STATE_CLASSES,
  RECORD_STATE_PAGE_LIMIT,
  RECORD_STATE_PROTOCOL_VERSION,
  RECORDS_MAX_IDS,
  type RecordFilter,
  type RecordOutboxEntry,
  type RecordStateClass,
  type RecordStatePage,
  type RecordsPage,
  readRecordStatePage,
  readRecordsPage,
  recordAvailability,
  recordPeerFailure,
  signedPeerRequest,
  verifyPeerResponse,
} from "@openconditions/federation";
import type { Registry } from "@openconditions/model";
import { DECIDED_TOMBSTONE_REASONS } from "@openconditions/storage";
import type postgres from "postgres";
import {
  filterQuery,
  PageTooLarge,
  PULL_MAX_PAGE_BYTES,
  PULL_PAGE_TIMEOUT_MS,
  readCapped,
  retryAfterOf,
} from "./puller.js";

/** How long one round of a comparison runs before it yields. */
export const RECONCILE_SLICE_MS = 20_000;

/**
 * Whether a comparison may run after this pull of the peer: only once the
 * pull reached the live tail without an error, so it compares with what the
 * journal could deliver, not with a backlog still on its way.
 */
export function reconcileAfter(pull: { more?: boolean; error?: string }): boolean {
  return pull.more === false && pull.error === undefined;
}

export interface ReconcileContext {
  registry: Registry;
  localInstanceId: string;
  signingKey: InstanceKey;
  fetchImpl: typeof fetch;
  /** Replay cache of the peers' response signatures. */
  nonceStore: NonceStore;
  /** The clock (ISO 8601), which also measures the time slice. */
  now: () => string;
  /** How long the round runs; default {@link RECONCILE_SLICE_MS}. */
  sliceMs?: number;
  /** How long an answer may take; default {@link PULL_PAGE_TIMEOUT_MS}. */
  pageTimeoutMs?: number;
  /** The crowd hooks a landed report goes through; injectable for tests. */
  inboxDeps?: InboxDeps;
}

export interface ReconcileCounts {
  /** Records compared: listed by the peer, held here, or both. */
  compared: number;
  /** Copies created, or changed to the peer's version. */
  updated: number;
  /** Ended copies live again. */
  restored: number;
  /** Copies ended as the peer stated. */
  ended: number;
  /** Copies of records the peer does not know, ended `withdrawn`. */
  retired: number;
  /** Answers that could not land here. */
  refused: number;
}

export type ReconcileResult =
  /** No comparison is due. */
  | { status: "none" }
  /** One is due, but the peer does not serve the routes it needs. */
  | { status: "unsupported"; protocolVersion?: string }
  /** It finished: no comparison is due any more. */
  | { status: "finished"; counts: ReconcileCounts }
  /**
   * It yielded at its time slice, or started over, with work left;
   * `progressed` says whether it stored any progress or changed a copy in this round.
   */
  | { status: "more"; counts: ReconcileCounts; progressed: boolean }
  /** It stopped short and stays due. */
  | { status: "stopped"; counts: ReconcileCounts; error: string; retryAfterSec?: number };

interface DueState {
  /** When it became due, as the database states it (to the microsecond), to match it again. */
  dueSince: string;
  cls: string | null;
  after: string | null;
  epoch: string | null;
}

async function readDue(sql: postgres.Sql, peerId: string): Promise<DueState | undefined> {
  const [row] = await sql<
    {
      reconcile_due_since: string | null;
      reconcile_class: string | null;
      reconcile_after: string | null;
      journal_epoch: string | null;
    }[]
  >`
    SELECT reconcile_due_since::text AS reconcile_due_since, reconcile_class, reconcile_after,
           journal_epoch
      FROM conditions.federation_peer_cursor WHERE peer_instance_id = ${peerId}`;
  if (row?.reconcile_due_since == null) return undefined;
  return {
    dueSince: row.reconcile_due_since,
    cls: row.reconcile_class,
    after: row.reconcile_after,
    epoch: row.journal_epoch,
  };
}

/**
 * Stores how far the comparison due since `dueSince` got; false when another
 * one became due meanwhile (the peer's journal started over again).
 */
async function storeProgress(
  sql: postgres.Sql,
  peerId: string,
  dueSince: string,
  cls: RecordStateClass,
  after: string | null,
): Promise<boolean> {
  const updated = await sql`
    UPDATE conditions.federation_peer_cursor
       SET reconcile_class = ${cls}, reconcile_after = ${after}
     WHERE peer_instance_id = ${peerId} AND reconcile_due_since::text = ${dueSince}`;
  return updated.count > 0;
}

/** Notes the comparison due since `dueSince` finished, unless another became due meanwhile. */
async function storeFinished(
  sql: postgres.Sql,
  peerId: string,
  dueSince: string,
  now: string,
): Promise<boolean> {
  const updated = await sql`
    UPDATE conditions.federation_peer_cursor
       SET reconcile_due_since = NULL, reconcile_class = NULL, reconcile_after = NULL,
           reconciled_at = ${now}
     WHERE peer_instance_id = ${peerId} AND reconcile_due_since::text = ${dueSince}`;
  return updated.count > 0;
}

interface HeldRow {
  id: string;
  revision: number;
  recorded_at: Date;
  ended: boolean;
  tombstone_reason: string | null;
}

/**
 * The statement reading this instance's copies of the peer's records of `cls`
 * with an id in `(after, through]` in byte order. Each bound is in the
 * statement only when there is one, so the planner walks the index on
 * `id COLLATE "C"` over the range.
 */
export function heldCopiesStatement(
  cls: RecordStateClass,
  peerId: string,
  after: string | undefined,
  through: string | undefined,
): { text: string; params: string[] } {
  const params = [peerId];
  const bounds: string[] = [];
  if (after !== undefined) {
    params.push(after);
    bounds.push(`AND id COLLATE "C" > $${params.length}::text COLLATE "C"`);
  }
  if (through !== undefined) {
    params.push(through);
    bounds.push(`AND id COLLATE "C" <= $${params.length}::text COLLATE "C"`);
  }
  return {
    text: `SELECT id, revision, recorded_at, tombstoned_at IS NOT NULL AS ended, tombstone_reason
             FROM conditions.${cls}
            WHERE instance_id = $1 ${bounds.join(" ")}`,
    params,
  };
}

async function heldCopies(
  sql: postgres.Sql,
  cls: RecordStateClass,
  peerId: string,
  after: string | undefined,
  through: string | undefined,
): Promise<HeldRow[]> {
  const statement = heldCopiesStatement(cls, peerId, after, through);
  return sql.unsafe<HeldRow[]>(statement.text, statement.params);
}

/** Of the live copies `ids`, those the pull filter still keeps, judged on the stored record. */
async function keptByFilter(
  sql: postgres.Sql,
  cls: RecordStateClass,
  ids: readonly string[],
  filter: RecordFilter,
  now: string,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await sql.unsafe<
    { id: string; canonical_id: string | null; kind: string; domain: string; record: unknown }[]
  >(
    `SELECT id, canonical_id, kind, domain, record FROM conditions.${cls}
      WHERE id = ANY($1::text[])`,
    [ids as string[]],
  );
  const entries: RecordOutboxEntry[] = rows.map((row) => ({
    seq: 0,
    txid: "0",
    operation: "create",
    recordClass: cls,
    recordId: row.id,
    canonicalId: row.canonical_id,
    kind: row.kind,
    domain: row.domain,
    createdAt: now,
    record: row.record as FederatedRecord,
  }));
  return new Set(
    applyRecordFilter(entries, filter, now).map((e) => (e as RecordOutboxEntry).recordId),
  );
}

const versionOf = (row: HeldRow): HeldVersion => ({
  revision: row.revision,
  recordedAt: row.recorded_at.toISOString(),
  ended: row.ended,
});

type Fetched = { ok: true; body: unknown } | { ok: false; error: string; retryAfterSec?: number };

/**
 * Compares this instance's copies of `peer`'s records with the peer's state,
 * for one round, while a comparison is due; never throws for the peer's
 * answers.
 */
export async function reconcilePeer(
  sql: postgres.Sql,
  peer: PeerRecord & { pull: { filter: RecordFilter } },
  ctx: ReconcileContext,
): Promise<ReconcileResult> {
  const peerId = peer.instanceId;
  const due = await readDue(sql, peerId);
  if (due === undefined) return { status: "none" };
  const protocolVersion = await loadPeerProtocolVersion(sql, peerId);
  if (
    protocolVersion === undefined ||
    compareVersions(protocolVersion, RECORD_STATE_PROTOCOL_VERSION) < 0
  ) {
    return { status: "unsupported", ...(protocolVersion !== undefined ? { protocolVersion } : {}) };
  }
  const counts: ReconcileCounts = {
    compared: 0,
    updated: 0,
    restored: 0,
    ended: 0,
    retired: 0,
    refused: 0,
  };
  const stopped = (error: string, retryAfterSec?: number): ReconcileResult => ({
    status: "stopped",
    counts,
    error,
    ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
  });
  if (await isPeerBlocked(sql, peerId)) return stopped("the peer is blocked here");
  const peerVersions = await loadPeerVersions(sql, peerId);
  if (peerVersions === undefined) return stopped("the peer's capabilities are not yet verified");
  if (due.epoch === null) return stopped("no journal epoch of the peer is known yet");

  const refuse = async (failure: "signature" | "schema", error: string) => {
    await recordPeerFailure(sql, peerId, failure, ctx.now());
    return stopped(error);
  };

  /** A signed request to the peer and its signed JSON answer, checked as a pulled page is. */
  const exchange = async (
    method: "GET" | "POST",
    url: string,
    body?: unknown,
  ): Promise<Fetched> => {
    const signal = AbortSignal.timeout(ctx.pageTimeoutMs ?? PULL_PAGE_TIMEOUT_MS);
    let res: Response;
    let sent: AnsweredRequest;
    let bytes: Uint8Array;
    try {
      ({ response: res, request: sent } = await signedPeerRequest(
        ctx.fetchImpl,
        ctx.signingKey,
        method,
        url,
        body,
        signal,
      ));
      bytes = await readCapped(res, PULL_MAX_PAGE_BYTES);
    } catch (err) {
      if (err instanceof PageTooLarge) {
        await recordPeerFailure(sql, peerId, "schema", ctx.now());
        return { ok: false, error: err.message };
      }
      await recordAvailability(sql, peerId, false, ctx.now());
      return { ok: false, error: `the peer could not be reached: ${String(err)}` };
    }
    if (res.status === 429 || res.status === 503) {
      const retryAfterSec = retryAfterOf(res);
      return {
        ok: false,
        error: `the peer asked to retry later (${res.status})`,
        ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
      };
    }
    if (res.status !== 200) {
      await recordAvailability(sql, peerId, false, ctx.now());
      return { ok: false, error: `the peer answered ${res.status}` };
    }
    if (
      !(await verifyPeerResponse(
        peer,
        { status: 200, headers: res.headers, body: bytes },
        sent,
        ctx.nonceStore,
      ))
    ) {
      await recordPeerFailure(sql, peerId, "signature", ctx.now());
      return { ok: false, error: "the answer does not carry the peer's signature" };
    }
    try {
      return { ok: true, body: JSON.parse(Buffer.from(bytes).toString("utf8")) };
    } catch {
      await recordPeerFailure(sql, peerId, "schema", ctx.now());
      return { ok: false, error: "the answer is not JSON" };
    }
  };

  const inbox = {
    registry: ctx.registry,
    localInstanceId: ctx.localInstanceId,
    peerInstanceId: peerId,
    peerVersions,
    now: ctx.now(),
  };

  const started = Date.parse(ctx.now());
  const sliceOver = () => Date.parse(ctx.now()) - started >= (ctx.sliceMs ?? RECONCILE_SLICE_MS);
  let progressed = false;

  /**
   * Asks the peer for `asked` (each with the version held when compared) and
   * lands its answers; a stop when the peer could not answer. The round's
   * time slice ends it between two requests as well, however few records
   * the peer answers at a time: the listing page is then compared again in
   * the next round, where what landed already is no longer asked for.
   */
  const askAndLand = async (
    cls: RecordStateClass,
    asked: Map<string, HeldVersion | null>,
  ): Promise<ReconcileResult | undefined> => {
    let pending = [...asked.keys()];
    for (let request = 0; pending.length > 0; request++) {
      if (request > 0 && sliceOver()) return { status: "more", counts, progressed };
      const ids = pending.slice(0, RECORDS_MAX_IDS);
      pending = pending.slice(RECORDS_MAX_IDS);
      const fetched = await exchange("POST", peerRouteUrl(peer, "/peer/records"), {
        class: cls,
        ids,
      });
      if (!fetched.ok) return stopped(fetched.error, fetched.retryAfterSec);
      const read = readRecordsPage(fetched.body, { cls, ids });
      if (!read.ok) return refuse("schema", read.reason);
      const page: RecordsPage = read.value;
      if (page.epoch !== due.epoch) return stopped("the peer's journal epoch changed");
      if (page.orderedItems.length === 0 && page.unanswered.length === ids.length) {
        return refuse("schema", "the peer answered none of the records asked for");
      }
      const landed = await landStatedEntries(
        sql,
        page.orderedItems,
        asked,
        { ...inbox, now: ctx.now() },
        ctx.inboxDeps,
      );
      counts.updated += landed.updated;
      counts.restored += landed.restored;
      counts.ended += landed.ended;
      counts.refused += landed.refused.length;
      if (landed.updated + landed.restored + landed.ended > 0) progressed = true;
      const gone = new Map<string, HeldVersion>();
      for (const id of page.unknown) {
        const held = asked.get(id);
        if (held != null && !held.ended) gone.set(id, held);
      }
      if (gone.size > 0) {
        const { retired } = await retireRecords(sql, cls, gone, { ...inbox, now: ctx.now() });
        counts.retired += retired;
        if (retired > 0) progressed = true;
      }
      pending = [...page.unanswered, ...pending];
    }
    return undefined;
  };

  const filterParams = filterQuery(peer.pull.filter);
  const resumed = RECORD_STATE_CLASSES.indexOf(due.cls as RecordStateClass);
  let classIndex = Math.max(0, resumed);
  let after = resumed >= 0 ? (due.after ?? undefined) : undefined;
  for (;;) {
    if (sliceOver()) return { status: "more", counts, progressed };
    const cls = RECORD_STATE_CLASSES[classIndex]!;
    const query = new URLSearchParams(filterParams);
    query.set("class", cls);
    if (after !== undefined) query.set("after", after);
    query.set("limit", String(RECORD_STATE_PAGE_LIMIT));
    const fetched = await exchange("GET", `${peerRouteUrl(peer, "/peer/state")}?${query}`);
    if (!fetched.ok) return stopped(fetched.error, fetched.retryAfterSec);
    const read = readRecordStatePage(fetched.body, {
      cls,
      ...(after !== undefined ? { after } : {}),
      limit: RECORD_STATE_PAGE_LIMIT,
    });
    if (!read.ok) return refuse("schema", read.reason);
    const page: RecordStatePage = read.value;
    // A listing of another history: the next pull resets the cursor and
    // makes a new comparison due.
    if (page.epoch !== due.epoch) return stopped("the peer's journal epoch changed");

    // Read only now, after the listing arrived (see the header).
    const held = new Map(
      (await heldCopies(sql, cls, peerId, after, page.through)).map((row) => [row.id, row]),
    );
    const listed = new Map(page.items.map((item) => [item.id, item]));
    const asked = new Map<string, HeldVersion | null>();
    for (const item of page.items) {
      const copy = held.get(item.id);
      if (copy === undefined) {
        asked.set(item.id, null);
        continue;
      }
      if (copy.ended && DECIDED_TOMBSTONE_REASONS.has(copy.tombstone_reason ?? "")) continue;
      const same =
        copy.revision === item.revision &&
        copy.recorded_at.getTime() === Date.parse(item.recordedAt);
      if (!same) asked.set(item.id, versionOf(copy));
    }
    const unlisted = [...held.values()].filter((copy) => !copy.ended && !listed.has(copy.id));
    const kept = await keptByFilter(
      sql,
      cls,
      unlisted.map((copy) => copy.id),
      peer.pull.filter,
      ctx.now(),
    );
    for (const copy of unlisted) {
      if (kept.has(copy.id)) asked.set(copy.id, versionOf(copy));
    }
    counts.compared += new Set([...listed.keys(), ...held.keys()]).size;

    const stop = await askAndLand(cls, asked);
    if (stop !== undefined) return stop;

    if (page.through !== undefined) {
      after = page.through;
      if (!(await storeProgress(sql, peerId, due.dueSince, cls, after))) {
        return { status: "more", counts, progressed };
      }
      progressed = true;
    } else if (classIndex < RECORD_STATE_CLASSES.length - 1) {
      classIndex += 1;
      after = undefined;
      const next = RECORD_STATE_CLASSES[classIndex]!;
      if (!(await storeProgress(sql, peerId, due.dueSince, next, null))) {
        return { status: "more", counts, progressed };
      }
      progressed = true;
    } else {
      return (await storeFinished(sql, peerId, due.dueSince, ctx.now()))
        ? { status: "finished", counts }
        : { status: "more", counts, progressed };
    }
  }
}
