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
 * A permanent problem with one entry skips it and is reported; a local
 * failure rejects the page so the peer retries from its cursor.
 */

import { checkGeometryPlausibility } from "@openconditions/contrib-core";
import type { GeoJsonGeometry } from "@openconditions/core";
import type { RevisionedClass } from "@openconditions/core/server";
import { admitFederatedRecord, readInboundEntry } from "@openconditions/federation/admit";
import type { Registry } from "@openconditions/model";
import { tombstoneRecords, writeRecordIn } from "@openconditions/storage";
import type postgres from "postgres";
import { actorOf, lockCrowd } from "../crowd.js";
import { crossValidateAgainstFeeds } from "../evidence/crossValidate.js";
import { recomputeEvidence } from "../evidence/recompute.js";
import { ERASURE_REASON, isErased, lockRecord, recordErasure } from "./tombstone.js";

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
  /** Deliveries that changed nothing: no newer than the stored copy. */
  stale: number;
  tombstoned: number;
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
    skipped: [],
    maxCursor: null,
  };
  let max: { txid: bigint; seq: number } | null = null;

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
    if (entry.operation === "delete") {
      const applied = await applyRetraction(sql, entry, ctx);
      if (applied === "tombstoned") result.tombstoned += 1;
      else result.skipped.push({ recordId: entry.recordId, reason: applied });
      continue;
    }
    const outcome = await landRecord(sql, entry.record, ctx, deps);
    if (outcome === "accepted") result.accepted += 1;
    else if (outcome === "stale") result.stale += 1;
    else result.skipped.push({ recordId: entry.recordId, reason: outcome });
  }
  result.maxCursor = max === null ? null : `${max.txid}.${max.seq}`;
  return result;
}

async function landRecord(
  sql: Sql,
  wire: unknown,
  ctx: InboxContext,
  deps: InboxDeps,
): Promise<"accepted" | "stale" | string> {
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
    return "skipped" in admission
      ? admission.skipped
      : admission.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  }
  const record = admission.record;
  const geometry = (record["location"] as { geometry: GeoJsonGeometry | null } | undefined)
    ?.geometry;
  if (geometry !== null && geometry !== undefined) {
    const reasons = checkGeometryPlausibility(geometry);
    if (reasons.length > 0) return `implausible geometry: ${reasons.join(", ")}`;
  }
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
 * peer's reason when the peer owns it. A copy another instance wrote, or one
 * already ended, is left alone and reported. An erasure records its fact
 * whether or not a copy is held, so the record cannot arrive later.
 */
async function applyRetraction(
  sql: Sql,
  entry: { recordClass: string; recordId: string; canonicalId: string | null; reason: string },
  ctx: InboxContext,
): Promise<"tombstoned" | string> {
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
      { source_id: string; instance_id: string; tombstoned: boolean }[]
    >(
      `SELECT source_id, instance_id, tombstoned_at IS NOT NULL AS tombstoned
         FROM conditions.${cls} WHERE id = $1`,
      [entry.recordId],
    );
    if (row === undefined) return "no copy of the record is held here";
    if (row.instance_id !== ctx.peerInstanceId) return "the record is not the peer's";
    if (row.tombstoned) return "the record has already ended here";
    await tx`SELECT pg_advisory_xact_lock(hashtext(${row.source_id}))`;
    await tombstoneRecords(tx, cls, [entry.recordId], entry.reason, {
      registry: ctx.registry,
      now: ctx.now,
    });
    return "tombstoned";
  }) as Promise<string>;
}
