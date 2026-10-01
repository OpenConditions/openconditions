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
import { componentRows, effectRows, expiryOf, relationRows, rowOf } from "./record-rows.js";
import { type ObservationCounts, type PollRef, writeObservationsIn } from "./write-observations.js";

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
   * it no longer holds has been withdrawn. False for a partial poll.
   * Observations are never withdrawn: a series outlives a missing reading.
   */
  complete: boolean;
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
 * new revision.
 */
export async function writeSnapshotIn(
  tx: Sql,
  sourceId: string,
  drafts: SnapshotDrafts,
  ctx: WriteContext,
): Promise<WriteSummary> {
  const summary: WriteSummary = {
    counts: { situation: emptyCounts(), feature: emptyCounts(), offer: emptyCounts() },
    observations: { latest: 0, history: 0, unchanged: 0, outsideRetention: 0 },
    rejected: [],
    changed: [],
  };
  for (const cls of ["feature", "situation", "offer"] as const) {
    await writeClass(tx, cls, sourceId, drafts[DRAFTS_OF[cls]] ?? [], ctx, summary);
  }
  summary.observations = await writeObservationsIn(
    tx,
    sourceId,
    drafts.observations ?? [],
    ctx,
    summary.rejected,
  );
  return summary;
}

interface Stored {
  content_hash: string;
  revision: number;
  tombstoned: boolean;
  expires_at: Date | null;
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
        `SELECT id, content_hash, revision, tombstoned_at IS NOT NULL AS tombstoned, expires_at
           FROM conditions.${cls} WHERE source_id = $1`,
        [sourceId],
      )
    ).map((r) => [r.id, r]),
  );

  const seen = new Set<string>();
  const sealed: { record: Rec; prev: Stored | undefined }[] = [];
  const expiryMoved: Rec[] = [];
  for (const draft of new Map(drafts.map((d) => [d["id"] as string, d])).values()) {
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
    if (prev !== undefined && !prev.tombstoned && prev.content_hash === hash) {
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

  if (ctx.complete) {
    const gone = [...existing.entries()]
      .filter(([id, r]) => !r.tombstoned && !seen.has(id))
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
 * Tombstones stored records: a new revision whose record carries the
 * tombstone (content unchanged, so the content hash stays), the row marked,
 * and the effect and relation rows removed so nothing joins a record that no
 * longer exists. A feature keeps its component rows for its history.
 */
export async function tombstoneRecords(
  tx: Sql,
  cls: RevisionedClass,
  ids: readonly string[],
  reason: string,
  ctx: Pick<WriteContext, "registry" | "now">,
  summary?: WriteSummary,
): Promise<void> {
  if (ids.length === 0) return;
  const previous = await loadRecords(tx, cls, ids);
  const revisions: Rec[] = [];
  for (const id of ids) {
    const prev = previous.get(id);
    if (prev === undefined) continue;
    const next = {
      ...prev,
      tombstone: { reason, at: ctx.now },
      revision: (prev["revision"] as number) + 1,
      recordedAt: ctx.now,
    };
    if (historyEligible(prev as unknown as Parameters<typeof historyEligible>[0])) {
      revisions.push(revisionRow(cls, next, computeChangeKinds(ctx.registry, prev, next)));
    }
    summary?.changed.push({ class: cls, id, revision: next.revision });
    await tx.unsafe(
      `UPDATE conditions.${cls}
          SET record = $2::text::jsonb, revision = $3, recorded_at = $4,
              tombstone_reason = $5, tombstoned_at = $4
        WHERE id = $1`,
      [id, JSON.stringify(next), next.revision, ctx.now, reason],
    );
  }
  await insertRows(tx, `${cls}_revision`, REVISION_COLUMNS(cls), revisions);
  if (cls === "situation") {
    await tx`DELETE FROM conditions.situation_effect WHERE situation_id = ANY(${ids as string[]})`;
  }
  await tx`
    DELETE FROM conditions.record_relation
    WHERE from_class = ${cls} AND from_id = ANY(${ids as string[]})`;
}
