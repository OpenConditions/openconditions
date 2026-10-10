import type { RevisionedClass } from "@openconditions/core/server";
import {
  computeChangeKinds,
  contentHash,
  historyEligible,
  type Registry,
  sealRecord,
  type ValidationIssue,
} from "@openconditions/model";
import type postgres from "postgres";
import { type ColumnSpec, insertRows, type Sql, upsertClause } from "./bulk.js";
import { updateCanonicalView } from "./canonical-view.js";
import { capRows, maxObservationsPerPollFromEnv } from "./caps.js";
import { pause, RECORDS_PER_TURN } from "./pause.js";
import { componentRows, effectRows, expiryOf, relationRows, rowOf } from "./record-rows.js";
import {
  endUnstatedSeries,
  type ObservationCounts,
  type PollRef,
  writeObservationsIn,
} from "./write-observations.js";

type Rec = Record<string, unknown>;

/** One poll's parser output: drafts of each record class, all of one source. */
export interface SnapshotDrafts {
  situations?: readonly Rec[];
  features?: readonly Rec[];
  offers?: readonly Rec[];
  observations?: readonly Rec[];
}

export interface WriteContext extends PollRef {
  registry: Registry;
  /** This instance's id, stamped on every record it seals. */
  instanceId: string;
  /** The transaction time: every revision written now records it. */
  now: string;
  /**
   * The snapshot holds every record the source publishes, so a stored record
   * it no longer holds has been withdrawn. False for a partial poll; per
   * class for a poll that holds some classes in full and others not (a flow
   * poll holds all its derived congestion, but only the sites that reported).
   * Observations are never withdrawn: a series outlives a missing reading
   * (see `statesComplete`).
   */
  complete: boolean | Readonly<Partial<Record<RevisionedClass, boolean>>>;
  /**
   * The snapshot states every change-only reading its source publishes now
   * (a full parse with every role answered): a polled change-only series it
   * does not state has ended, and its reading stops holding.
   */
  statesComplete?: boolean;
  /** The most records of one class a poll may hold (default `MAX_ROWS_PER_SOURCE`). */
  maxRowsPerClass?: number;
  /**
   * The most readings a poll may hold (default
   * `OPENCONDITIONS_MAX_OBSERVATIONS_PER_POLL`, else `MAX_OBSERVATIONS_PER_POLL`).
   */
  maxObservationsPerPoll?: number;
}

/** Whether a write holds every record of a class its source publishes. */
export function completeFor(ctx: Pick<WriteContext, "complete">, cls: RevisionedClass): boolean {
  return typeof ctx.complete === "boolean" ? ctx.complete : ctx.complete[cls] === true;
}

export interface ClassCounts {
  created: number;
  updated: number;
  restored: number;
  unchanged: number;
  withdrawn: number;
}

/** A draft that could not be stored, with why; the poll goes on without it. */
export interface Rejection {
  class: RevisionedClass | "observation";
  id: string | undefined;
  issues: readonly ValidationIssue[];
}

export interface WriteSummary {
  counts: Record<RevisionedClass, ClassCounts>;
  observations: ObservationCounts;
  rejected: Rejection[];
  /** Records whose stored revision changed (created, updated, restored, withdrawn). */
  changed: { class: RevisionedClass; id: string; revision: number }[];
}

const KERNEL: ColumnSpec[] = [
  { name: "id", type: "text" },
  { name: "record", type: "jsonb" },
  { name: "canonical_id", type: "text" },
  { name: "kind", type: "text" },
  { name: "type", type: "text" },
  { name: "subtype", type: "text" },
  { name: "domain", type: "text" },
  { name: "temporality", type: "text" },
  { name: "source_id", type: "text" },
  { name: "source_record_id", type: "text" },
  { name: "origin", type: "text" },
  { name: "access_mode", type: "text" },
  { name: "privacy_class", type: "text" },
  { name: "instance_id", type: "text" },
  { name: "revision", type: "integer" },
  { name: "recorded_at", type: "timestamptz" },
  { name: "content_hash", type: "text" },
  { name: "fetched_at", type: "timestamptz" },
  { name: "expires_at", type: "timestamptz" },
  { name: "geom", type: "geometry", geometry: true },
  { name: "country", type: "text" },
  { name: "subdivision", type: "text" },
  { name: "tombstone_reason", type: "text" },
  { name: "tombstoned_at", type: "timestamptz" },
];

export const CLASS_COLUMNS: Record<RevisionedClass, ColumnSpec[]> = {
  situation: [
    ...KERNEL,
    { name: "severity", type: "text" },
    { name: "severity_level", type: "smallint" },
    { name: "certainty", type: "text" },
    { name: "planned", type: "boolean" },
    { name: "validity_status", type: "text" },
    { name: "valid_from", type: "timestamptz" },
    { name: "valid_to", type: "timestamptz" },
    { name: "group_id", type: "text" },
  ],
  feature: [...KERNEL, { name: "lifecycle", type: "text" }],
  offer: [
    ...KERNEL,
    { name: "subject_class", type: "text" },
    { name: "subject_id", type: "text" },
    { name: "component_key", type: "text" },
    { name: "currency", type: "text" },
    { name: "valid_from", type: "timestamptz" },
    { name: "valid_to", type: "timestamptz" },
    { name: "min_price", type: "numeric" },
    { name: "max_price", type: "numeric" },
  ],
};

export const REVISION_COLUMNS = (cls: RevisionedClass): ColumnSpec[] => [
  { name: `${cls}_id`, type: "text" },
  { name: "revision", type: "integer" },
  { name: "recorded_at", type: "timestamptz" },
  { name: "change_kinds", type: "text[]" },
  { name: "snapshot", type: "jsonb" },
];

const EFFECT_COLUMNS: ColumnSpec[] = [
  { name: "situation_id", type: "text" },
  { name: "effect_id", type: "text" },
  { name: "phase_id", type: "text" },
  { name: "kind", type: "text" },
  { name: "applicability_kind", type: "text" },
  { name: "normalization", type: "text" },
  { name: "compliance", type: "text" },
  { name: "direction", type: "text" },
  { name: "valid_from", type: "timestamptz" },
  { name: "valid_to", type: "timestamptz" },
  { name: "geom", type: "geometry", geometry: true },
  { name: "value", type: "jsonb" },
];

const COMPONENT_COLUMNS: ColumnSpec[] = [
  { name: "feature_id", type: "text" },
  { name: "key", type: "text" },
  { name: "parent_key", type: "text" },
  { name: "kind", type: "text" },
  { name: "lifecycle", type: "text" },
  { name: "position", type: "geometry", geometry: true },
  { name: "external_ids", type: "jsonb" },
  { name: "details", type: "jsonb" },
  { name: "content_hash", type: "text" },
];

const RELATION_COLUMNS: ColumnSpec[] = [
  { name: "from_class", type: "text" },
  { name: "from_id", type: "text" },
  { name: "relation", type: "text" },
  { name: "to_class", type: "text" },
  { name: "to_id", type: "text" },
  { name: "component_key", type: "text" },
];

const DRAFTS_OF: Record<RevisionedClass, "situations" | "features" | "offers"> = {
  situation: "situations",
  feature: "features",
  offer: "offers",
};

const emptyCounts = (): ClassCounts => ({
  created: 0,
  updated: 0,
  restored: 0,
  unchanged: 0,
  withdrawn: 0,
});

/**
 * Writes one poll of one source, in one transaction under the source's
 * advisory lock. See {@link writeSnapshotIn}.
 */
export async function writeSnapshot(
  sql: postgres.Sql,
  sourceId: string,
  drafts: SnapshotDrafts,
  ctx: WriteContext,
): Promise<WriteSummary> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${sourceId}))`;
    return writeSnapshotIn(tx, sourceId, drafts, ctx);
  }) as Promise<WriteSummary>;
}

/**
 * Writes one poll of one source inside the caller's transaction, which must
 * hold the source's advisory lock. A draft whose content is unchanged is
 * neither validated nor written: the source's poll time is what says it was
 * seen again. A new or changed draft is sealed and stored with a revision
 * naming what changed; a draft that fails validation is rejected and the
 * poll goes on. When the snapshot is complete, a stored record it no longer
 * holds is tombstoned `withdrawn`; one that comes back is restored with a
 * new revision. A poll holding more records of one class than a source may
 * publish is refused as a whole. The features that changed are relinked and
 * the fused rows they and the written readings feed are recomputed, in the
 * same transaction.
 */
export async function writeSnapshotIn(
  tx: Sql,
  sourceId: string,
  drafts: SnapshotDrafts,
  ctx: WriteContext,
): Promise<WriteSummary> {
  const summary: WriteSummary = {
    counts: { situation: emptyCounts(), feature: emptyCounts(), offer: emptyCounts() },
    observations: {
      latest: 0,
      history: 0,
      unchanged: 0,
      outsideRetention: 0,
      pastRollup: 0,
      ended: 0,
    },
    rejected: [],
    changed: [],
  };
  for (const cls of ["feature", "situation", "offer"] as const) {
    capRows(drafts[DRAFTS_OF[cls]] ?? [], cls, ctx.maxRowsPerClass);
  }
  capRows(
    drafts.observations ?? [],
    "observation",
    ctx.maxObservationsPerPoll ?? maxObservationsPerPollFromEnv(),
  );
  for (const cls of ["feature", "situation", "offer"] as const) {
    await writeClass(tx, cls, sourceId, drafts[DRAFTS_OF[cls]] ?? [], ctx, summary);
  }
  const changedFeatures = new Set(
    summary.changed.filter((c) => c.class === "feature").map((c) => c.id),
  );
  summary.observations = await writeObservationsIn(
    tx,
    sourceId,
    drafts.observations ?? [],
    { ...ctx, changedFeatures },
    summary.rejected,
  );
  const ended = ctx.statesComplete
    ? await endUnstatedSeries(tx, sourceId, drafts.observations ?? [], ctx)
    : [];
  summary.observations.ended = ended.length;
  await updateCanonicalView(
    tx,
    ctx.registry,
    {
      sourceId,
      featureIds: summary.changed.filter((c) => c.class === "feature").map((c) => c.id),
      observations: drafts.observations ?? [],
      ended: ended.flatMap((e) =>
        e.featureId === null ? [] : [{ featureId: e.featureId, properties: [e.property] }],
      ),
    },
    ctx,
  );
  return summary;
}

interface Stored {
  content_hash: string;
  revision: number;
  tombstoned: boolean;
  expires_at: Date | null;
  instance_id: string;
}

/**
 * Whether a draft written here leaves its stored record as it is: same
 * content, live, and this instance's own. A peer's copy of the same content
 * (it reached us before our own first poll of the feed) is taken over and
 * sealed anew as ours: left peer-owned, it would never be journalled to this
 * instance's subscribers, and the peer's retraction could tombstone it.
 */
export function unchangedOwn(
  stored: Pick<Stored, "content_hash" | "tombstoned" | "instance_id">,
  hash: string,
  instanceId: string,
): boolean {
  return !stored.tombstoned && stored.content_hash === hash && stored.instance_id === instanceId;
}

/**
 * Moves the expiry of records whose content is unchanged to what the source
 * now says, in place: the expiry is when the source's statement lapses, not
 * content, so it takes no revision. Left at the first fetch's expiry, a record
 * the source still publishes would be expired by the sweep and restored by
 * the next poll, over and over.
 */
export async function refreshExpiries(tx: Sql, cls: RevisionedClass, drafts: readonly Rec[]) {
  if (drafts.length === 0) return;
  const rows = drafts.map((d) => ({
    id: d["id"],
    expires_at: (d["freshness"] as Rec | undefined)?.["expiresAt"] ?? null,
  }));
  await tx.unsafe(
    `UPDATE conditions.${cls} r
        SET expires_at = n.expires_at,
            record = CASE WHEN n.expires_at IS NULL
              THEN r.record #- '{freshness,expiresAt}'
              ELSE jsonb_set(r.record, '{freshness,expiresAt}', to_jsonb(n.expires_text)) END
       FROM (SELECT id, expires_at::timestamptz AS expires_at, expires_at AS expires_text
               FROM jsonb_to_recordset($1::text::jsonb) AS x(id text, expires_at text)) n
      WHERE r.id = n.id`,
    [JSON.stringify(rows)],
  );
}

async function writeClass(
  tx: Sql,
  cls: RevisionedClass,
  sourceId: string,
  drafts: readonly Rec[],
  ctx: WriteContext,
  summary: WriteSummary,
): Promise<void> {
  const counts = summary.counts[cls];
  const existing = new Map(
    (
      await tx.unsafe<(Stored & { id: string })[]>(
        `SELECT id, content_hash, revision, tombstoned_at IS NOT NULL AS tombstoned, expires_at,
                instance_id
           FROM conditions.${cls} WHERE source_id = $1`,
        [sourceId],
      )
    ).map((r) => [r.id, r]),
  );

  const seen = new Set<string>();
  const sealed: { record: Rec; prev: Stored | undefined }[] = [];
  const expiryMoved: Rec[] = [];
  let handled = 0;
  for (const draft of new Map(drafts.map((d) => [d["id"] as string, d])).values()) {
    if (++handled % RECORDS_PER_TURN === 0) await pause();
    const id = typeof draft["id"] === "string" ? draft["id"] : undefined;
    if (id !== undefined) seen.add(id);
    const owner = (draft["provenance"] as Rec | undefined)?.["sourceId"];
    if (draft["class"] !== cls || owner !== sourceId) {
      summary.rejected.push({
        class: cls,
        id,
        issues: [
          {
            path: [],
            code: "custom",
            message: `a ${cls} draft of source ${sourceId} is expected`,
          },
        ],
      });
      continue;
    }
    let hash: string;
    try {
      hash = contentHash(draft);
    } catch (err) {
      summary.rejected.push({
        class: cls,
        id,
        issues: [{ path: [], code: "custom", message: (err as Error).message }],
      });
      continue;
    }
    const prev = existing.get(id!);
    if (prev !== undefined && unchangedOwn(prev, hash, ctx.instanceId)) {
      counts.unchanged++;
      if (expiryOf(draft) !== (prev.expires_at?.getTime() ?? null)) expiryMoved.push(draft);
      continue;
    }
    const result = sealRecord(ctx.registry, draft, {
      instanceId: ctx.instanceId,
      revision: (prev?.revision ?? 0) + 1,
      recordedAt: ctx.now,
    });
    if (!result.ok) {
      summary.rejected.push({ class: cls, id, issues: result.issues });
      continue;
    }
    sealed.push({ record: result.value, prev });
  }

  await refreshExpiries(tx, cls, expiryMoved);
  const changedIds = sealed.filter((s) => s.prev && !s.prev.tombstoned).map((s) => s.record["id"]);
  const previous = await loadRecords(tx, cls, changedIds as string[]);
  const revisions: Rec[] = [];
  for (const { record, prev } of sealed) {
    const id = record["id"] as string;
    let changeKinds: string[];
    if (prev === undefined) {
      counts.created++;
      changeKinds = ["created"];
    } else if (prev.tombstoned) {
      counts.restored++;
      changeKinds = ["created"];
    } else {
      counts.updated++;
      changeKinds = computeChangeKinds(ctx.registry, previous.get(id), record);
    }
    // An on-demand answer is a cache for one consumer's query: it keeps no history.
    if (historyEligible(record as unknown as Parameters<typeof historyEligible>[0])) {
      revisions.push(revisionRow(cls, record, changeKinds));
    }
    summary.changed.push({ class: cls, id, revision: record["revision"] as number });
  }

  const records = sealed.map((s) => s.record);
  await storeRecords(tx, cls, records, ctx.registry);
  await insertRows(tx, `${cls}_revision`, REVISION_COLUMNS(cls), revisions);

  if (completeFor(ctx, cls)) {
    // Only this instance's own records: a peer's copy of the same source ends
    // when the peer says so, or two instances polling it would flap.
    const gone = [...existing.entries()]
      .filter(([id, r]) => !r.tombstoned && !seen.has(id) && r.instance_id === ctx.instanceId)
      .map(([id]) => id);
    await tombstoneRecords(tx, cls, gone, "withdrawn", ctx, summary);
    counts.withdrawn += gone.length;
  }
}

/** A `*_revision` row: the stored record (without its evidence) and what changed. */
export function revisionRow(
  cls: RevisionedClass,
  record: Rec,
  changeKinds: readonly string[],
): Rec {
  const { evidence: _evidence, ...snapshot } = record;
  return {
    [`${cls}_id`]: record["id"],
    revision: record["revision"],
    recorded_at: record["recordedAt"],
    change_kinds: changeKinds,
    snapshot,
  };
}

async function loadRecords(tx: Sql, cls: RevisionedClass, ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, Rec>();
  const rows = await tx.unsafe<{ id: string; record: Rec }[]>(
    `SELECT id, record FROM conditions.${cls} WHERE id = ANY($1::text[])`,
    [ids as string[]],
  );
  return new Map(rows.map((r) => [r.id, r.record]));
}

/**
 * Upserts sealed records and re-materialises their child rows: a
 * situation's effects, a feature's components, every record's relations. A
 * tombstoned record (a peer's tombstone) keeps its components for its
 * history but gets no effect or relation rows, as a local tombstone.
 */
export async function storeRecords(
  tx: Sql,
  cls: RevisionedClass,
  records: readonly Rec[],
  registry: Registry,
): Promise<void> {
  if (records.length === 0) return;
  const columns = CLASS_COLUMNS[cls];
  await insertRows(
    tx,
    cls,
    columns,
    records.map((r) => rowOf(cls, r)),
    upsertClause(["id"], columns),
  );
  const ids = records.map((r) => r["id"] as string);
  await deleteChildren(tx, cls, ids);
  const live = records.filter((r) => r["tombstone"] === undefined);
  if (cls === "situation") {
    await insertRows(
      tx,
      "situation_effect",
      EFFECT_COLUMNS,
      live.flatMap((r) => effectRows(registry, r)),
    );
    await enqueueBindings(
      tx,
      records.map((r) => ({ id: r["id"] as string, revision: r["revision"] as number })),
    );
  }
  if (cls === "feature") {
    await insertRows(tx, "feature_component", COMPONENT_COLUMNS, records.flatMap(componentRows));
  }
  await insertRows(
    tx,
    "record_relation",
    RELATION_COLUMNS,
    live.flatMap((r) => relationRows(cls, r)),
    "ON CONFLICT DO NOTHING",
  );
}

/**
 * Queues the graph binding of situations whose stored revision changed, in
 * the writing transaction: a revision is never visible without its binding
 * work. The binder places a live situation and its effects, and drops the
 * bindings of a tombstoned one. Queued rows are taken in key order, as the
 * binder settles them, so the two never wait on each other in a cycle.
 */
async function enqueueBindings(tx: Sql, refs: readonly { id: string; revision: number }[]) {
  if (refs.length === 0) return;
  await tx`
    INSERT INTO conditions.binding_queue
      (record_class, record_id, effect_id, record_revision, attempts, next_attempt_at,
       last_error, updated_at)
    SELECT 'situation', r.id, '', r.revision, 0, now(), NULL, now()
      FROM jsonb_to_recordset(${JSON.stringify(refs)}::text::jsonb) AS r(id text, revision int)
     ORDER BY r.id
    ON CONFLICT (record_class, record_id, effect_id) DO UPDATE SET
      record_revision = excluded.record_revision, attempts = 0, next_attempt_at = now(),
      last_error = NULL, updated_at = now()`;
}

async function deleteChildren(tx: Sql, cls: RevisionedClass, ids: readonly string[]) {
  if (ids.length === 0) return;
  if (cls === "situation") {
    await tx`DELETE FROM conditions.situation_effect WHERE situation_id = ANY(${ids as string[]})`;
  }
  if (cls === "feature") {
    await tx`DELETE FROM conditions.feature_component WHERE feature_id = ANY(${ids as string[]})`;
  }
  await tx`
    DELETE FROM conditions.record_relation
    WHERE from_class = ${cls} AND from_id = ANY(${ids as string[]})`;
}

/**
 * Tombstone reasons that are this instance's decision about a record
 * (a reviewer's rejection, a merge into another report): a peer's copy ended
 * for one stays ended through the peer's later revisions.
 */
export const DECIDED_TOMBSTONE_REASONS: ReadonlySet<string> = new Set(["rejected", "superseded"]);

/** The tombstone reason that erases a record: the rights to it were revoked. */
const ERASURE_REASON = "rights_revoked";

/** Whether a stored record is a peer's copy: it carries the origin chain of its receipt. */
function isPeerCopy(record: Rec): boolean {
  const chain = (record["provenance"] as Rec | undefined)?.["originChain"];
  return Array.isArray(chain) && chain.length > 0;
}

/**
 * Tombstones stored records: a new revision whose record carries the
 * tombstone (content unchanged, so the content hash stays), the row marked,
 * and the effect and relation rows removed so nothing joins a record that no
 * longer exists. A feature keeps its component rows for its history.
 *
 * A peer's copy ended here (expired, withdrawn, rejected, superseded, erased)
 * keeps the peer's revision and takes no history row: its revisions are the
 * peer's to number, and a local one would make the stale check drop the
 * peer's next change. Whether a later revision of the peer's restores it is
 * the reason's ({@link DECIDED_TOMBSTONE_REASONS}). The peer's own retraction
 * (`byOwner`) is a revision of the peer's, numbered as the peer numbered it.
 *
 * An erasure (`rights_revoked`) also removes the record's revision history:
 * the erased content must not outlive the erasure there for the history
 * window. The tombstoned row stays, as the fact that the record is erased.
 */
/**
 * What an erased record keeps of its provenance: whose and which record it
 * was, under what terms, and where a peer's copy came from — the origin chain
 * keeps a peer's erased copy from being federated as this instance's own, the
 * upstream terms keep its licence what it was.
 */
const ERASED_PROVENANCE = [
  "origin",
  "sourceId",
  "sourceFormat",
  "accessMode",
  "recordId",
  "instanceId",
  "attribution",
  "upstream",
  "originChain",
  "privacy",
] as const;

/**
 * An erased record as it stays until the history window purges its row: what
 * it was (class, kind, ids, source) so its tombstone still answers for it,
 * and nothing of what it said or where — the rights to that were revoked.
 */
function erasedStub(record: Rec): Rec {
  const provenance = record["provenance"] as Rec;
  const stub: Rec = {};
  for (const key of ["id", "class", "kind", "type", "domain", "temporality", "canonicalId"]) {
    if (record[key] !== undefined) stub[key] = record[key];
  }
  stub["provenance"] = Object.fromEntries(
    ERASED_PROVENANCE.filter((k) => provenance[k] !== undefined).map((k) => [k, provenance[k]]),
  );
  return stub;
}

export async function tombstoneRecords(
  tx: Sql,
  cls: RevisionedClass,
  ids: readonly string[],
  reason: string,
  ctx: Pick<WriteContext, "registry" | "now"> & { byOwner?: boolean },
  summary?: WriteSummary,
): Promise<void> {
  if (ids.length === 0) return;
  const previous = await loadRecords(tx, cls, ids);
  const revisions: Rec[] = [];
  const bindings: { id: string; revision: number }[] = [];
  for (const id of ids) {
    const prev = previous.get(id);
    if (prev === undefined) continue;
    const keepRevision = ctx.byOwner !== true && isPeerCopy(prev);
    const revision = (prev["revision"] as number) + (keepRevision ? 0 : 1);
    const recordedAt = keepRevision ? (prev["recordedAt"] as string) : ctx.now;
    const kept = reason === ERASURE_REASON ? erasedStub(prev) : prev;
    const next = { ...kept, tombstone: { reason, at: ctx.now }, revision, recordedAt };
    if (
      !keepRevision &&
      historyEligible(prev as unknown as Parameters<typeof historyEligible>[0])
    ) {
      revisions.push(revisionRow(cls, next, computeChangeKinds(ctx.registry, prev, next)));
    }
    summary?.changed.push({ class: cls, id, revision });
    bindings.push({ id, revision });
    await tx.unsafe(
      `UPDATE conditions.${cls}
          SET record = $2::text::jsonb, revision = $3, recorded_at = $4,
              tombstone_reason = $5, tombstoned_at = $6
        WHERE id = $1`,
      [id, JSON.stringify(next), revision, recordedAt, reason, ctx.now],
    );
  }
  if (reason === ERASURE_REASON) {
    await tx.unsafe(`DELETE FROM conditions.${cls}_revision WHERE ${cls}_id = ANY($1::text[])`, [
      ids as string[],
    ]);
    await tx.unsafe(`UPDATE conditions.${cls} SET geom = NULL WHERE id = ANY($1::text[])`, [
      ids as string[],
    ]);
    if (cls === "feature") {
      await tx`DELETE FROM conditions.feature_component WHERE feature_id = ANY(${ids as string[]})`;
    }
  } else {
    await insertRows(tx, `${cls}_revision`, REVISION_COLUMNS(cls), revisions);
  }
  if (cls === "situation") {
    await tx`DELETE FROM conditions.situation_effect WHERE situation_id = ANY(${ids as string[]})`;
    await enqueueBindings(tx, bindings);
  }
  await tx`
    DELETE FROM conditions.record_relation
    WHERE from_class = ${cls} AND from_id = ANY(${ids as string[]})`;
}
