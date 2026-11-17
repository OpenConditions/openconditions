/**
 * The federation inbox: one page of a peer's outbox (pushed to
 * `/peer/inbox`, or pulled from its `/peer/outbox`), landed record by record.
 * A peer sends only its own records (model §11), so nothing here collapses
 * resupplies across peers.
 *
 * - A change is admitted (`admitFederatedRecord`: another instance's record,
 *   an on-demand answer or a fused row is refused, a schema the two do not
 *   share at one major is skipped, a newer minor's fields are dropped, the
 *   reporter is stripped and the receipt joins the origin chain) and written
 *   as the peer sealed it (`writeRecord`): a delivery no newer than the stored
 *   copy changes nothing but a lifetime the peer moved, and a record another
 *   instance wrote under the same id stays that instance's.
 * - An admitted crowd situation gains a `report` evidence row (`via:
 *   federation`) in the write's transaction, its evidence is recomputed, and
 *   it goes through the same cross-validation as a local report. It carries
 *   no key, so it never corroborates with a crowd report.
 * - A retraction tombstones the local copy when the peer owns it; an erasure
 *   (`rights_revoked`) also records the peer's erasure fact, so no later
 *   delivery of the record from that peer is admitted for its lifetime.
 *
 * - Each source whose records a page delivered (landed or no newer than the
 *   stored copy) is noted as received from the peer now
 *   (`federation_source_receipt`): a peer's polled readings hold while their
 *   source keeps arriving. A liveness entry (the peer polled the source
 *   successfully) notes it as received when the peer polled it, never later
 *   than now: a quiet source sends no reading, yet its readings still hold.
 *
 * A permanent problem with one entry skips it and is reported; a local
 * failure rejects the page so the peer retries from its cursor.
 *
 * The peer's answer to a comparison of copies (`/peer/records`) lands as
 * stated instead ({@link landStatedEntries}): it is the peer's present state,
 * which replaces a copy from a history the peer no longer has whatever the
 * revisions, but never one that changed since this instance compared it: each
 * answer carries the version held then, checked again under the record's
 * lock. A copy the peer no longer knows is retired ({@link retireRecords}) as
 * a retraction of the peer's at the revision held, which a later delivery of
 * the record restores.
 */

import { checkGeometryPlausibility } from "@openconditions/contrib-core";
import type { GeoJsonGeometry } from "@openconditions/core";
import type { RevisionedClass } from "@openconditions/core/server";
import { admitFederatedRecord, readInboundEntry } from "@openconditions/federation/admit";
import type { Registry } from "@openconditions/model";
import {
  DECIDED_TOMBSTONE_REASONS,
  isLapsedCopy,
  restoreLapsedCopies,
  tombstoneRecords,
  writeRecordIn,
} from "@openconditions/storage";
import type postgres from "postgres";
import { actorOf, lockCrowd } from "../crowd.js";
import { crossValidateAgainstFeeds } from "../evidence/crossValidate.js";
import { recomputeEvidence } from "../evidence/recompute.js";
import {
  ERASURE_REASON,
  isErased,
  leaveCanonicalView,
  lockRecord,
  recordErasure,
} from "./tombstone.js";

type Sql = postgres.Sql;

export interface InboxContext {
  registry: Registry;
  localInstanceId: string;
  peerInstanceId: string;
  /** The schema versions the peer advertises. */
  peerVersions: readonly string[];
  now: string;
}

/** The crowd hook a landed peer report goes through; injectable for tests. */
export interface InboxDeps {
  crossValidate?: typeof crossValidateAgainstFeeds;
  log?: (message: string, err?: unknown) => void;
}

export interface InboxResult {
  /** Records created, changed or restored here. */
  accepted: number;
  /**
   * Deliveries that changed nothing: no newer than the stored copy, or a
   * retraction of a copy already ended or never held. A page that arrives
   * by push and by pull lands once.
   */
  stale: number;
  tombstoned: number;
  /** Liveness entries noted. */
  liveness: number;
  skipped: { recordId?: string; reason: string }[];
  /** The page's highest `<txid>.<seq>` cursor processed, skipped entries included. */
  maxCursor: string | null;
}

/** A page that is not an outbox page at all. */
export class FederatedPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FederatedPageError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const CLASSES_WITH_TOMBSTONES = new Set(["situation", "feature", "offer"]);

/** Lands one page of a peer's outbox. */
export async function ingestFederatedPage(
  sql: Sql,
  page: unknown,
  ctx: InboxContext,
  deps: InboxDeps = {},
): Promise<InboxResult> {
  if (!isRecord(page) || !Array.isArray(page["orderedItems"])) {
    throw new FederatedPageError(
      "federated page must be an object with an orderedItems array (OrderedCollectionPage)",
    );
  }
  const result: InboxResult = {
    accepted: 0,
    stale: 0,
    tombstoned: 0,
    liveness: 0,
    skipped: [],
    maxCursor: null,
  };
  let max: { txid: bigint; seq: number } | null = null;
  /** The sources this page delivered, each with when it was received. */
  const received = new Map<string, string>();
  const receive = (sourceId: string, at: string) => {
    const held = received.get(sourceId);
    if (held === undefined || Date.parse(at) > Date.parse(held)) received.set(sourceId, at);
  };
  /** The sources whose liveness this page carried, each with the cadence the peer stated. */
  const alive = new Map<string, number | null>();

  for (const item of page["orderedItems"]) {
    // Advance the processed frontier over EVERY entry that carries a usable
    // cursor — a skipped entry is still processed (skip-and-report), so the
    // peer's push-ack never wedges on one bad entry.
    if (isRecord(item) && typeof item["txid"] === "string" && /^\d+$/.test(item["txid"])) {
      const seq = Number.isSafeInteger(item["seq"]) ? (item["seq"] as number) : 0;
      const txid = BigInt(item["txid"]);
      if (max === null || txid > max.txid || (txid === max.txid && seq > max.seq)) {
        max = { txid, seq };
      }
    }
    const read = readInboundEntry(item);
    if (!read.ok) {
      result.skipped.push({
        ...(read.recordId === undefined ? {} : { recordId: read.recordId }),
        reason: read.reason,
      });
      continue;
    }
    const entry = read.entry;
    if (entry.operation === "liveness") {
      receive(
        entry.sourceId,
        Date.parse(entry.polledAt) < Date.parse(ctx.now) ? entry.polledAt : ctx.now,
      );
      alive.set(entry.sourceId, entry.cadenceSec ?? alive.get(entry.sourceId) ?? null);
      result.liveness += 1;
      continue;
    }
    if (entry.operation === "delete") {
      const applied = await applyRetraction(sql, entry, ctx);
      if (applied === "tombstoned") result.tombstoned += 1;
      else if (applied === "stale") result.stale += 1;
      else result.skipped.push({ recordId: entry.recordId, reason: applied });
      continue;
    }
    const outcome = await landRecord(sql, entry.record, ctx, deps);
    if (outcome === "accepted") result.accepted += 1;
    else if (outcome === "stale") result.stale += 1;
    else result.skipped.push({ recordId: entry.recordId, reason: outcome });
    if (outcome === "accepted" || outcome === "stale") {
      const provenance = (entry.record as { provenance?: { sourceId?: unknown } }).provenance;
      if (typeof provenance?.sourceId === "string") receive(provenance.sourceId, ctx.now);
    }
  }
  await recordReceipts(sql, ctx, received, alive);
  // The peer polls these sources again: what the sweep ended of them for
  // the peer's silence is live again, after this page's own retractions.
  for (const sourceId of alive.keys()) {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${sourceId}))`;
      await restoreLapsedCopies(tx, ctx.registry, ctx.peerInstanceId, sourceId, {
        instanceId: ctx.localInstanceId,
        now: ctx.now,
      });
    });
  }
  result.maxCursor = max === null ? null : `${max.txid}.${max.seq}`;
  return result;
}

/**
 * Notes when each source arrived from the peer: its readings hold while it
 * keeps arriving (`withPolledValidity`). A receipt never moves back. A source
 * whose liveness arrived is noted as one the peer says it polls, at the
 * cadence it states: its readings hold, and its copies stay, as long as that
 * polling keeps them current, and they end should the peer fall silent.
 */
async function recordReceipts(
  sql: Sql,
  ctx: InboxContext,
  sources: ReadonlyMap<string, string>,
  alive: ReadonlyMap<string, number | null>,
): Promise<void> {
  if (sources.size === 0) return;
  const keys = [...sources.keys()];
  await sql`
    INSERT INTO conditions.federation_source_receipt
      (peer_instance_id, source_id, last_received_at, liveness_at, cadence_sec)
    SELECT ${ctx.peerInstanceId}, r.s, r.at, CASE WHEN l.s IS NOT NULL THEN r.at END, l.cadence
      FROM unnest(${keys}::text[], ${[...sources.values()]}::timestamptz[]) AS r(s, at)
      LEFT JOIN unnest(${[...alive.keys()]}::text[], ${[...alive.values()]}::int[])
        AS l(s, cadence) ON l.s = r.s
    ON CONFLICT (peer_instance_id, source_id) DO UPDATE
      SET last_received_at = GREATEST(conditions.federation_source_receipt.last_received_at,
                                      excluded.last_received_at),
          liveness_at = GREATEST(conditions.federation_source_receipt.liveness_at,
                                 excluded.liveness_at),
          cadence_sec = COALESCE(excluded.cadence_sec,
                                 conditions.federation_source_receipt.cadence_sec)`;
}

/**
 * A peer's record admitted as the inbox admits it, with a plausible geometry,
 * or why it is refused.
 */
function admitForLanding(
  wire: unknown,
  ctx: InboxContext,
): { record: Record<string, unknown> } | { refused: string } {
  const admission = admitFederatedRecord(
    ctx.registry,
    {
      peerInstanceId: ctx.peerInstanceId,
      peerVersions: ctx.peerVersions,
      receivedAt: ctx.now,
    },
    wire,
  );
  if (!admission.admitted) {
    return {
      refused:
        "skipped" in admission
          ? admission.skipped
          : admission.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  const record = admission.record;
  const geometry = (record["location"] as { geometry: GeoJsonGeometry | null } | undefined)
    ?.geometry;
  if (geometry !== null && geometry !== undefined) {
    const reasons = checkGeometryPlausibility(geometry);
    if (reasons.length > 0) return { refused: `implausible geometry: ${reasons.join(", ")}` };
  }
  return { record };
}

async function landRecord(
  sql: Sql,
  wire: unknown,
  ctx: InboxContext,
  deps: InboxDeps,
): Promise<"accepted" | "stale" | string> {
  const admitted = admitForLanding(wire, ctx);
  if ("refused" in admitted) return admitted.refused;
  const record = admitted.record;
  const sourceId = (record["provenance"] as { sourceId: string }).sourceId;
  const isCrowd = record["class"] === "situation" && actorOf(record).origin === "crowd";
  // The erasure check and the write share the record's lock with a retraction
  // of it, so an erasure can never pass between them and leave it live. A
  // crowd report's evidence lands in the same transaction, so a failure
  // leaves nothing and the peer's retry lands it whole.
  const written = await sql.begin(async (tx) => {
    await lockRecord(tx, record["class"] as string, record["id"] as string);
    if (await isErased(tx, record["canonicalId"] as string, ctx.now, ctx.peerInstanceId)) {
      return "erased" as const;
    }
    await tx`SELECT pg_advisory_xact_lock(hashtext(${sourceId}))`;
    const result = await writeRecordIn(
      tx,
      { stored: record },
      { registry: ctx.registry, instanceId: ctx.localInstanceId, now: ctx.now },
    );
    if (
      isCrowd &&
      (result.status === "created" ||
        result.status === "updated" ||
        result.status === "restored" ||
        result.status === "refreshed")
    ) {
      await landCrowdEvidence(sql, tx, result.id, ctx);
    }
    return result;
  });
  if (written === "erased") return "the record was erased";
  switch (written.status) {
    case "rejected":
      return written.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    case "foreign":
      return "another instance's record holds this id here";
    case "stale":
    case "unchanged":
      return "stale";
    case "refreshed":
      return "accepted";
  }
  if (isCrowd) await runCrowdHooks(sql, written.id, ctx, deps);
  return "accepted";
}

/**
 * A peer's crowd report gets the evidence a local one starts with — one
 * `report`, from the peer rather than a key — and its evidence recomputed.
 */
async function landCrowdEvidence(
  sql: Sql,
  tx: postgres.TransactionSql,
  id: string,
  ctx: InboxContext,
): Promise<void> {
  await lockCrowd(tx);
  const [row] = await tx<{ reported_at: string | null }[]>`
    SELECT record #>> '{validity,start}' AS reported_at
    FROM conditions.situation WHERE id = ${id}`;
  const details = {
    via: "federation",
    peer: ctx.peerInstanceId,
    ...(row?.reported_at ? { reportedAt: row.reported_at } : {}),
  };
  await tx`
    INSERT INTO conditions.report_evidence
      (record_class, record_id, evidence_kind, actor_key_id, source_id, occurred_at, details)
    SELECT 'situation', ${id}, 'report', NULL, ${ctx.peerInstanceId}, ${ctx.now},
           ${tx.json(details)}
    WHERE NOT EXISTS (
      SELECT 1 FROM conditions.report_evidence
      WHERE record_class = 'situation' AND record_id = ${id} AND evidence_kind = 'report'
    )`;
  await recomputeEvidence(sql, ctx.registry, id, ctx.now, tx);
}

/**
 * A landed peer report goes through the same cross-validation as a local one;
 * it carries no key, so it never corroborates with a crowd report. The hook
 * is best-effort: the record has landed, and a hook failure never rejects
 * the page.
 */
async function runCrowdHooks(
  sql: Sql,
  id: string,
  ctx: InboxContext,
  deps: InboxDeps,
): Promise<void> {
  const log = deps.log ?? (() => {});
  try {
    await (deps.crossValidate ?? crossValidateAgainstFeeds)(sql, ctx.registry, id, ctx.now, {
      allowFederatedTarget: true,
    });
  } catch (err) {
    log(`[federation-inbox] cross-validation of ${id} failed`, err);
  }
}

/**
 * A peer retracts one of its records: the local copy is tombstoned with the
 * peer's reason, at the revision the peer ended it at, when the peer owns it.
 * A copy another instance wrote is left alone and reported; one already
 * ended, one newer than the retraction (a later change that arrived first,
 * by push), or none held, is a retraction that changes nothing (`stale`). An
 * erasure ends the copy whatever its revision, and records its fact whether
 * or not a copy is held, so the record cannot arrive later.
 */
async function applyRetraction(
  sql: Sql,
  entry: {
    recordClass: string;
    recordId: string;
    canonicalId: string | null;
    reason: string;
    revision?: number;
  },
  ctx: InboxContext,
): Promise<"tombstoned" | "stale" | string> {
  return sql.begin(async (tx) => {
    await lockRecord(tx, entry.recordClass, entry.recordId);
    if (entry.reason === ERASURE_REASON) {
      await recordErasure(tx, entry.canonicalId, ctx.now, ctx.peerInstanceId);
    }
    if (!CLASSES_WITH_TOMBSTONES.has(entry.recordClass)) {
      return `a ${entry.recordClass} is not tombstoned`;
    }
    const cls = entry.recordClass as RevisionedClass;
    const [row] = await tx.unsafe<
      {
        source_id: string;
        instance_id: string;
        tombstone_reason: string | null;
        revision: number;
      }[]
    >(
      `SELECT source_id, instance_id, tombstone_reason, revision
         FROM conditions.${cls} WHERE id = $1`,
      [entry.recordId],
    );
    // Nothing to end: the record never reached this instance (a filter kept
    // it out), or the retraction arrives a second time, by push and by pull.
    if (row === undefined) return "stale";
    if (row.instance_id !== ctx.peerInstanceId) return "the record is not the peer's";
    // The peer changed the record since: that change arrived first. An
    // erasure ends every revision of it.
    const erasure = entry.reason === ERASURE_REASON;
    if (!erasure && row.revision > entry.revision!) return "stale";
    // An erasure still applies to a copy that ended here: ending it kept its
    // content, and the rights to that content are gone.
    // A copy the sweep ended for the peer's silence is still the peer's to
    // retract: left as it is, the peer's returning liveness would bring it back.
    if (
      row.tombstone_reason !== null &&
      (entry.reason !== ERASURE_REASON || row.tombstone_reason === ERASURE_REASON) &&
      !(await isLapsedCopy(tx, cls, entry.recordId))
    ) {
      return "stale";
    }
    await tx`SELECT pg_advisory_xact_lock(hashtext(${row.source_id}))`;
    await tombstoneRecords(tx, cls, [entry.recordId], entry.reason, {
      registry: ctx.registry,
      now: ctx.now,
      byOwner: true,
      ...(entry.revision !== undefined && entry.revision >= row.revision
        ? { ownerRevision: entry.revision }
        : {}),
    });
    await leaveCanonicalView(tx, ctx.registry, { class: cls, id: entry.recordId }, row.source_id, {
      instanceId: ctx.localInstanceId,
      now: ctx.now,
    });
    return "tombstoned";
  }) as Promise<string>;
}

/** The version of a copy this instance held when it compared it with the peer's state. */
export interface HeldVersion {
  revision: number;
  recordedAt: string;
  ended: boolean;
}

export interface StatedResult {
  /** Copies created, or changed to the version stated. */
  updated: number;
  /** Ended copies live again as stated. */
  restored: number;
  /** Copies ended as stated. */
  ended: number;
  /** Answers that changed nothing: the copy was already as stated, or changed since it was compared. */
  unchanged: number;
  /** Answers that cannot land here, each with why. */
  refused: { recordId?: string; reason: string }[];
}

interface StoredVersion {
  source_id: string;
  instance_id: string;
  revision: number;
  recorded_at: Date;
  ended: boolean;
  tombstone_reason: string | null;
}

/** The stored version of a record, read under its lock. */
async function storedVersion(
  tx: postgres.TransactionSql,
  cls: RevisionedClass,
  id: string,
): Promise<StoredVersion | undefined> {
  const [row] = await tx.unsafe<StoredVersion[]>(
    `SELECT source_id, instance_id, revision, recorded_at,
            tombstoned_at IS NOT NULL AS ended, tombstone_reason
       FROM conditions.${cls} WHERE id = $1`,
    [id],
  );
  return row;
}

/** Whether the stored version is still the one held at the comparison. */
function stillHeld(row: StoredVersion | undefined, held: HeldVersion | null): boolean {
  if (held === null) return row === undefined;
  return (
    row !== undefined &&
    row.revision === held.revision &&
    row.recorded_at.getTime() === Date.parse(held.recordedAt) &&
    row.ended === held.ended
  );
}

/**
 * Lands the peer's answers to a comparison as the peer states them, each
 * against the version `held` names for its record (null: none was held). A
 * record is admitted as the inbox admits one (an erased one is still
 * refused: the erasure outlives a restore at the peer) and written over the
 * copy whatever their revisions (`asStated`); a delete ends the copy with
 * the reason at the revision stated, an erasure recording its fact as a
 * retraction does. Under the record's lock the copy is read again: one that
 * changed since the comparison, by a push or a pull that landed meanwhile,
 * is left as it is. An answer that cannot land is refused, not counted
 * against the peer: it would be refused again at every comparison.
 */
export async function landStatedEntries(
  sql: Sql,
  entries: readonly unknown[],
  held: ReadonlyMap<string, HeldVersion | null>,
  ctx: InboxContext,
  deps: InboxDeps = {},
): Promise<StatedResult> {
  const result: StatedResult = { updated: 0, restored: 0, ended: 0, unchanged: 0, refused: [] };
  for (const item of entries) {
    const read = readInboundEntry(item);
    if (!read.ok) {
      result.refused.push({
        ...(read.recordId === undefined ? {} : { recordId: read.recordId }),
        reason: read.reason,
      });
      continue;
    }
    const entry = read.entry;
    if (entry.operation === "liveness") {
      result.refused.push({ reason: "a liveness entry is not a record's state" });
      continue;
    }
    const before = held.get(entry.recordId);
    if (before === undefined || !CLASSES_WITH_TOMBSTONES.has(entry.recordClass)) {
      result.refused.push({ recordId: entry.recordId, reason: "the record was not compared" });
      continue;
    }
    // The version held was compared for the record the entry names, so the
    // record it carries must be that one.
    if (entry.operation !== "delete") {
      const carried = entry.record as { id?: unknown; class?: unknown };
      if (carried.id !== entry.recordId || carried.class !== entry.recordClass) {
        result.refused.push({
          recordId: entry.recordId,
          reason: "the entry carries another record than it names",
        });
        continue;
      }
    }
    const outcome =
      entry.operation === "delete"
        ? await endAsStated(sql, entry, before, ctx)
        : await landAsStated(sql, entry.record, before, ctx, deps);
    if (outcome === "updated") result.updated += 1;
    else if (outcome === "restored") result.restored += 1;
    else if (outcome === "ended") result.ended += 1;
    else if (outcome === "unchanged") result.unchanged += 1;
    else result.refused.push({ recordId: entry.recordId, reason: outcome });
  }
  return result;
}

async function landAsStated(
  sql: Sql,
  wire: unknown,
  before: HeldVersion | null,
  ctx: InboxContext,
  deps: InboxDeps,
): Promise<"updated" | "restored" | "unchanged" | string> {
  const admitted = admitForLanding(wire, ctx);
  if ("refused" in admitted) return admitted.refused;
  const record = admitted.record;
  const cls = record["class"] as RevisionedClass;
  const id = record["id"] as string;
  const sourceId = (record["provenance"] as { sourceId: string }).sourceId;
  const isCrowd = cls === "situation" && actorOf(record).origin === "crowd";
  const written = await sql.begin(async (tx) => {
    await lockRecord(tx, cls, id);
    if (await isErased(tx, record["canonicalId"] as string, ctx.now, ctx.peerInstanceId)) {
      return "erased" as const;
    }
    if (!stillHeld(await storedVersion(tx, cls, id), before)) return "moved" as const;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${sourceId}))`;
    const result = await writeRecordIn(
      tx,
      { stored: record, asStated: true },
      { registry: ctx.registry, instanceId: ctx.localInstanceId, now: ctx.now },
    );
    if (
      isCrowd &&
      (result.status === "created" || result.status === "updated" || result.status === "restored")
    ) {
      await landCrowdEvidence(sql, tx, result.id, ctx);
    }
    return result;
  });
  if (written === "erased") return "the record was erased";
  if (written === "moved") return "unchanged";
  switch (written.status) {
    case "rejected":
      return written.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    case "foreign":
      return "another instance's record holds this id here";
    case "created":
    case "updated":
    case "restored":
      if (isCrowd) await runCrowdHooks(sql, written.id, ctx, deps);
      return written.status === "restored" ? "restored" : "updated";
    default:
      return "unchanged";
  }
}

async function endAsStated(
  sql: Sql,
  entry: {
    recordClass: string;
    recordId: string;
    canonicalId: string | null;
    reason: string;
    revision?: number;
  },
  before: HeldVersion | null,
  ctx: InboxContext,
): Promise<"ended" | "unchanged" | string> {
  const cls = entry.recordClass as RevisionedClass;
  const erasure = entry.reason === ERASURE_REASON;
  return sql.begin(async (tx) => {
    await lockRecord(tx, cls, entry.recordId);
    if (erasure) await recordErasure(tx, entry.canonicalId, ctx.now, ctx.peerInstanceId);
    const row = await storedVersion(tx, cls, entry.recordId);
    if (row === undefined || !stillHeld(row, before)) return "unchanged";
    if (row.instance_id !== ctx.peerInstanceId) return "the record is not the peer's";
    if (row.ended && row.tombstone_reason === entry.reason && row.revision === entry.revision) {
      return "unchanged";
    }
    // A copy rejected or superseded here stays as this instance decided,
    // unless the rights to it are gone.
    if (row.ended && !erasure && DECIDED_TOMBSTONE_REASONS.has(row.tombstone_reason ?? "")) {
      return "unchanged";
    }
    await tx`SELECT pg_advisory_xact_lock(hashtext(${row.source_id}))`;
    if (entry.revision !== undefined) {
      await tx.unsafe(
        `DELETE FROM conditions.${cls}_revision WHERE ${cls}_id = $1 AND revision >= $2`,
        [entry.recordId, entry.revision],
      );
    }
    await tombstoneRecords(tx, cls, [entry.recordId], entry.reason, {
      registry: ctx.registry,
      now: ctx.now,
      byOwner: true,
      ...(entry.revision !== undefined ? { ownerRevision: entry.revision } : {}),
    });
    await leaveCanonicalView(tx, ctx.registry, { class: cls, id: entry.recordId }, row.source_id, {
      instanceId: ctx.localInstanceId,
      now: ctx.now,
    });
    return "ended";
  }) as Promise<string>;
}

/**
 * Retires copies of records the peer no longer knows: each held live at the
 * version `held` names is ended `withdrawn`, as the peer's retraction at the
 * revision held, so a later delivery of the record at that revision or a
 * higher one restores it. A copy that changed since the comparison is left
 * as it is.
 */
export async function retireRecords(
  sql: Sql,
  cls: RevisionedClass,
  held: ReadonlyMap<string, HeldVersion>,
  ctx: InboxContext,
): Promise<{ retired: number; unchanged: number }> {
  const result = { retired: 0, unchanged: 0 };
  for (const [id, before] of held) {
    const retired = await sql.begin(async (tx) => {
      await lockRecord(tx, cls, id);
      const row = await storedVersion(tx, cls, id);
      if (
        row === undefined ||
        row.ended ||
        !stillHeld(row, before) ||
        row.instance_id !== ctx.peerInstanceId
      ) {
        return false;
      }
      await tx`SELECT pg_advisory_xact_lock(hashtext(${row.source_id}))`;
      await tombstoneRecords(tx, cls, [id], "withdrawn", {
        registry: ctx.registry,
        now: ctx.now,
        byOwner: true,
        ownerRevision: row.revision,
      });
      await leaveCanonicalView(tx, ctx.registry, { class: cls, id }, row.source_id, {
        instanceId: ctx.localInstanceId,
        now: ctx.now,
      });
      return true;
    });
    if (retired) result.retired += 1;
    else result.unchanged += 1;
  }
  return result;
}
