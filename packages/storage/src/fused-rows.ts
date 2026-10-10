import {
  canonicalKeyOf,
  fusableProperties,
  lastSuccessEnd,
  seriesKeyOf,
} from "@openconditions/core";
import {
  type EgressRecord,
  isPublicRecord,
  publicLicenseClassification,
} from "@openconditions/ingest-framework";
import {
  type CanonicalComponent,
  type EvidenceState,
  FUSED_PUBLIC_SOURCE_ID,
  FUSED_SOURCE_ID,
  FUSED_SOURCE_IDS,
  type FusableObservation,
  type FusedSourceId,
  type Fusion,
  type FusionCandidate,
  fuse,
  fusedObservation,
  jcs,
  type LocationRef,
  type Registry,
  type SourceTier,
  sealRecord,
} from "@openconditions/model";
import type postgres from "postgres";
import { type ColumnSpec, insertRows, type Sql, upsertClause } from "./bulk.js";
import { clustersHolding } from "./canonical-holding.js";
import { SERIES_COLUMNS, SERIES_KEY, seriesRowOf } from "./write-observations.js";

type Rec = Record<string, unknown>;

/** The source id of every crowd row, local or a peer's. */
const CROWD_SOURCE_ID = "crowd";

/**
 * Whether a fusion candidate may feed the fusion the public scope reads: its
 * source is one this catalogue holds and does not restrict
 * (`conditions.source.restricted`, the catalogue's effective rights; a source
 * the catalogue does not hold has no row, `restricted` null, and is not
 * public), and its record passes the public licence gate every egress
 * applies (`isPublicRecord`: its own licence and every upstream licence
 * public). A crowd row has no catalogue source and is judged by its record's
 * licence alone.
 */
export function isPublicCandidate(row: {
  restricted: boolean | null;
  record: Rec;
  sourceId: string;
}): boolean {
  const licensed = isPublicRecord(row.record as unknown as EgressRecord);
  return row.sourceId === CROWD_SOURCE_ID ? licensed : row.restricted === false && licensed;
}

/** One row of `feature_canonical`, as fusion and landing read it. */
export interface CanonicalRow {
  canonicalFeatureId: string;
  survivorId: string;
  memberIds: string[];
  components: CanonicalComponent[];
}

/** The canonical rows holding these ids, as canonical feature or as member. */
export async function loadCanonical(
  tx: Sql,
  featureIds: readonly string[],
): Promise<CanonicalRow[]> {
  if (featureIds.length === 0) return [];
  const rows = await tx<
    {
      canonical_feature_id: string;
      survivor_id: string;
      member_ids: string[];
      components: CanonicalComponent[];
    }[]
  >`
    WITH held AS MATERIALIZED (
      ${clustersHolding(tx, featureIds)}
      UNION SELECT unnest(${featureIds as string[]}::text[]))
    SELECT c.canonical_feature_id, c.survivor_id, c.member_ids, c.components
      FROM conditions.feature_canonical c JOIN held USING (canonical_feature_id)`;
  return rows.map((r) => ({
    canonicalFeatureId: r.canonical_feature_id,
    survivorId: r.survivor_id,
    memberIds: r.member_ids,
    components: r.components,
  }));
}

/**
 * What a fused row is refreshed for: a feature (a per-source member or the
 * canonical feature itself), and optionally the only properties that
 * changed. Without properties, every fusable property of its canonical
 * feature is refreshed.
 */
export interface FusedScope {
  featureId: string;
  properties?: readonly string[];
}

export interface FusedContext {
  instanceId: string;
  now: string;
  /**
   * Sources known fresh whatever their status row says: the source being
   * written now, whose status commits after its records.
   */
  freshSources?: readonly string[];
  /**
   * Canonical features this write ended: their fused rows are deleted under
   * the same locks, taken with the others in one ordered set. Deleting them
   * unlocked lets a writer that still sees the old cluster hold its lock
   * while waiting on the deleted row, as the deleter waits for that lock.
   */
  vanished?: readonly string[];
}

export interface FusedCounts {
  written: number;
  unchanged: number;
  deleted: number;
}

interface CandidateRow {
  series_id: string;
  feature_id: string;
  component_key: string | null;
  source_id: string;
  property: string;
  qualifier_key: string;
  record: Rec;
  evidence_state: EvidenceState | null;
  tier: SourceTier | null;
  restricted: boolean | null;
  stale: boolean;
}

interface FusedRow {
  series_id: string;
  source_id: FusedSourceId;
  subject_key: string;
  property: string;
  qualifier_key: string;
  record: Rec;
  since_at: Date;
  fused_public: boolean | null;
}

const FUSED_COLUMNS: ColumnSpec[] = [
  ...SERIES_COLUMNS,
  { name: "fused_from", type: "text[]" },
  { name: "fused_sources", type: "text[]" },
  { name: "fused_public", type: "boolean" },
];

/** A fused record as compared between refreshes: everything but when it was computed. */
const comparable = (record: Rec) => {
  const {
    recordedAt: _recorded,
    contentHash: _hash,
    freshness,
    ...rest
  } = record as Rec & {
    freshness: Rec;
  };
  const { fetchedAt: _fetched, ...lifetime } = freshness;
  return jcs({ ...rest, freshness: lifetime });
};

/**
 * Recomputes the `@fused` rows of the canonical features the scopes name:
 * for each canonical subject (the canonical feature, or one of its canonical
 * components) and each fusable property, the per-source rows of every member,
 * mapped through the stored canonical components, and the crowd rows on the
 * canonical subject compete in `fuse`. A feed row's tier is its source's
 * (`conditions.source.tier`; a source the catalogue does not hold, a peer's,
 * does not fuse here), a crowd row's its evidence; a source is stale when its
 * last successful poll finished longer ago than its freshness window (`lastSuccessEnd`; a source with no
 * status row yet has never failed one, and counts as fresh). The winner is
 * written as the subject's `@fused` row (latest only: it never enters history
 * or the federation), with its contributing readings' ids in `fused_from`
 * and their rows' sources in `fused_sources` (`crowd` for a crowd row); a
 * subject where nothing qualifies has no fused row. When every contributor is public
 * ({@link isPublicCandidate}), the row is flagged `fused_public`: dropping the
 * other candidates would not change the fusion. Otherwise the fusion of the
 * public candidates alone is written beside it as the `@fused-public` row,
 * flagged `fused_public`, when any of them qualifies. A public row takes its
 * location only from a public member (its source held unrestricted, its
 * record's licences public): the winner's feature, else the survivor, else
 * the first public member in member order. With none, the public row is not
 * written, and an all-public fusion is written unflagged. A fused row whose
 * value, contributors, lifetime and flag are unchanged is left alone.
 */
export async function refreshFused(
  tx: Sql,
  registry: Registry,
  scopes: readonly FusedScope[],
  ctx: FusedContext,
): Promise<FusedCounts> {
  const counts: FusedCounts = { written: 0, unchanged: 0, deleted: 0 };
  const fusable = fusableProperties(registry);
  const vanished = ctx.vanished ?? [];
  const wanted = scopes
    .map((s) => ({
      ...s,
      properties: s.properties?.filter((p) => fusable.has(p)),
    }))
    .filter((s) => s.properties === undefined || s.properties.length > 0);
  if (wanted.length === 0 && vanished.length === 0) return counts;

  const canonical =
    wanted.length === 0
      ? []
      : await loadCanonical(
          tx,
          wanted.map((s) => s.featureId),
        );
  // Writers of different sources refresh the same fused rows under their own
  // source locks; each canonical feature's lock, taken in id order, keeps one
  // refresh from overwriting another's newer view with its older one.
  await lockKeys(tx, LOCK_SPACES.fused, [
    ...canonical.map((c) => c.canonicalFeatureId),
    ...vanished,
  ]);
  counts.deleted += await dropFused(tx, vanished);
  if (canonical.length === 0) return counts;
  // The properties in scope of each canonical feature: all fusable ones once any scope asks for all.
  const scopeOf = new Map<string, Set<string> | "all">();
  for (const c of canonical) {
    const ids = new Set([c.canonicalFeatureId, ...c.memberIds]);
    for (const s of wanted.filter((w) => ids.has(w.featureId))) {
      const held = scopeOf.get(c.canonicalFeatureId);
      if (held === "all" || s.properties === undefined) {
        scopeOf.set(c.canonicalFeatureId, "all");
      } else {
        scopeOf.set(c.canonicalFeatureId, new Set([...(held ?? []), ...s.properties]));
      }
    }
  }
  const inScope = (canonicalId: string, property: string) => {
    const scope = scopeOf.get(canonicalId);
    return fusable.has(property) && (scope === "all" || scope?.has(property) === true);
  };

  const memberOf = new Map<string, CanonicalRow>();
  for (const c of canonical) for (const m of c.memberIds) memberOf.set(m, c);
  const byCanonical = new Map(canonical.map((c) => [c.canonicalFeatureId, c]));
  const fresh = ctx.freshSources ?? [];

  const rows = await tx<CandidateRow[]>`
    SELECT l.series_id::text AS series_id, l.feature_id, l.component_key, l.source_id, l.property,
           l.qualifier_key, conditions.observation_record(l.template, l.reading) AS record,
           l.evidence_state, s.tier, s.restricted,
           COALESCE(l.source_id <> ALL(${fresh as string[]}::text[]) AND ss.source IS NOT NULL
             AND (ss.last_success_at IS NULL
               OR ${tx.unsafe(lastSuccessEnd("ss"))} < ${ctx.now}::timestamptz
                    - make_interval(secs => ss.freshness_window_sec)), false) AS stale
      FROM conditions.observation_latest l
      LEFT JOIN conditions.source s ON s.id = l.source_id
      LEFT JOIN conditions.source_status ss ON ss.source = l.source_id
     WHERE l.property = ANY(${[...fusable]}::text[])
       AND l.source_id <> ALL(${[...FUSED_SOURCE_IDS]}::text[])
       AND ((l.source_id <> ${CROWD_SOURCE_ID} AND l.feature_id = ANY(${[...memberOf.keys()]}::text[]))
         OR (l.source_id = ${CROWD_SOURCE_ID}
             AND l.feature_id = ANY(${[...byCanonical.keys()]}::text[])))`;

  interface Group {
    canonical: CanonicalRow;
    componentKey: string | undefined;
    property: string;
    qualifierKey: string;
    candidates: { row: CandidateRow; candidate: FusionCandidate; public: boolean }[];
  }
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const crowd = row.source_id === CROWD_SOURCE_ID;
    const c = crowd ? byCanonical.get(row.feature_id) : memberOf.get(row.feature_id);
    if (c === undefined || !inScope(c.canonicalFeatureId, row.property)) continue;
    let componentKey: string | undefined;
    if (row.component_key !== null) {
      componentKey = crowd
        ? row.component_key
        : canonicalKeyOf(c, row.feature_id, row.component_key);
      if (componentKey === undefined) continue;
    }
    let candidate: FusionCandidate;
    if (crowd) {
      candidate = {
        observation: row.record as unknown as FusableObservation,
        ...(row.evidence_state === null ? {} : { evidence: { state: row.evidence_state } }),
        stale: false,
      };
    } else {
      // A source this catalogue does not hold has no tier to rank by here.
      if (row.tier === null) continue;
      candidate = {
        observation: row.record as unknown as FusableObservation,
        sourceTier: row.tier,
        stale: row.stale,
      };
    }
    const key = jcs([c.canonicalFeatureId, componentKey ?? null, row.property, row.qualifier_key]);
    const group = groups.get(key) ?? {
      canonical: c,
      componentKey,
      property: row.property,
      qualifierKey: row.qualifier_key,
      candidates: [],
    };
    group.candidates.push({
      row,
      candidate,
      public: isPublicCandidate({
        restricted: row.restricted,
        record: row.record,
        sourceId: row.source_id,
      }),
    });
    groups.set(key, group);
  }

  // A fused row sits where the record whose value it shows puts the feature,
  // under that record's credit: another member's geometry may be licensed
  // otherwise. A crowd value sits at the survivor's. A public row sits only
  // where a public member puts it: the winner's feature, else the survivor,
  // else the first public member in member order.
  const members = new Map(
    (
      await tx<
        {
          id: string;
          location: LocationRef | null;
          source_id: string;
          restricted: boolean | null;
          record: Rec;
        }[]
      >`
        SELECT f.id, f.record->'location' AS location, f.source_id, s.restricted,
               jsonb_build_object('provenance', f.record->'provenance') AS record
          FROM conditions.feature f
          LEFT JOIN conditions.source s ON s.id = f.source_id
         WHERE f.id = ANY(${canonical.flatMap((c) => c.memberIds)}::text[])`
    ).map((r) => [
      r.id,
      {
        location: r.location ?? undefined,
        public: isPublicCandidate({
          restricted: r.restricted,
          record: r.record,
          sourceId: r.source_id,
        }),
      },
    ]),
  );
  const locationOf = (
    group: Group,
    winner: CandidateRow | undefined,
    onlyPublic: boolean,
  ): LocationRef | undefined => {
    const order = [
      ...(winner === undefined || winner.source_id === CROWD_SOURCE_ID ? [] : [winner.feature_id]),
      group.canonical.survivorId,
      ...(onlyPublic ? group.canonical.memberIds : []),
    ];
    for (const id of order) {
      const member = members.get(id);
      if (member?.location !== undefined && (!onlyPublic || member.public)) return member.location;
    }
    return undefined;
  };
  const existing = await tx<FusedRow[]>`
    SELECT series_id::text AS series_id, source_id, subject_key, property, qualifier_key,
           conditions.observation_record(template, reading) AS record, since_at, fused_public
      FROM conditions.observation_latest
     WHERE source_id = ANY(${[...FUSED_SOURCE_IDS]}::text[])
       AND feature_id = ANY(${[...byCanonical.keys()]}::text[])`;
  const heldKey = (sourceId: string, subjectKey: string, property: string, qualifierKey: string) =>
    jcs([sourceId, subjectKey, property, qualifierKey]);
  const held = new Map(
    existing.map((r) => [heldKey(r.source_id, r.subject_key, r.property, r.qualifier_key), r]),
  );

  const keep = new Set<string>();
  const writes: Rec[] = [];
  const write = (
    group: Group,
    fusion: Fusion,
    sourceId: FusedSourceId,
    allPublic: boolean,
  ): void => {
    const winner = group.candidates.find((g) => g.candidate === fusion.winner)?.row;
    // An all-public fusion with no public member to sit at stays operator-only.
    const publicLocation = allPublic ? locationOf(group, winner, true) : undefined;
    const fusedPublic = publicLocation !== undefined;
    const location =
      publicLocation ??
      (sourceId === FUSED_SOURCE_ID ? locationOf(group, winner, false) : undefined);
    if (location === undefined) return;
    const draft = fusedObservation(registry, fusion, {
      subject: {
        kind: "feature",
        featureId: group.canonical.canonicalFeatureId,
        ...(group.componentKey === undefined ? {} : { componentKey: group.componentKey }),
      },
      location,
      instanceId: ctx.instanceId,
      now: ctx.now,
      sourceId,
    });
    if (!draft.ok) throw new TypeError(`a fused row failed validation: ${jcs(draft.issues)}`);
    const sealed = sealRecord(registry, draft.value, {
      instanceId: ctx.instanceId,
      revision: 1,
      recordedAt: ctx.now,
    });
    if (!sealed.ok) throw new TypeError(`a fused row failed sealing: ${jcs(sealed.issues)}`);
    const record = sealed.value;
    const key = seriesKeyOf(record);
    const k = heldKey(sourceId, key.subjectKey, key.property, key.qualifierKey);
    keep.add(k);
    const prev = held.get(k);
    if (
      prev !== undefined &&
      prev.fused_public === fusedPublic &&
      comparable(prev.record) === comparable(record)
    ) {
      counts.unchanged++;
      return;
    }
    const property = registry.property(group.property)!;
    const sameValue = prev !== undefined && jcs(prev.record["result"]) === jcs(record["result"]);
    const sinceAt = sameValue
      ? prev.since_at.toISOString()
      : new Date(Date.parse(startOf(record))).toISOString();
    const sourceOf = new Map(group.candidates.map((g) => [g.candidate, g.row.source_id]));
    writes.push({
      ...seriesRowOf({ ...record, sinceAt }, property, undefined, ctx.now),
      fused_from: fusion.contributors.map((c) => c.observation.id),
      fused_sources: [...new Set(fusion.contributors.map((c) => sourceOf.get(c)!))],
      fused_public: fusedPublic,
    });
  };
  for (const group of groups.values()) {
    const fusion = fuse(
      registry,
      group.property,
      group.candidates.map((g) => g.candidate),
      ctx.now,
    );
    if (fusion === undefined) continue;
    const isPublic = new Map(group.candidates.map((g) => [g.candidate, g.public]));
    // Fusion ranks the candidates and keeps the winner's peers, so dropping
    // candidates that did not contribute leaves the same fusion.
    const allPublic = fusion.contributors.every((c) => isPublic.get(c) === true);
    write(group, fusion, FUSED_SOURCE_ID, allPublic);
    if (allPublic) continue;
    const publicFusion = fuse(
      registry,
      group.property,
      group.candidates.filter((g) => g.public).map((g) => g.candidate),
      ctx.now,
    );
    if (publicFusion !== undefined) write(group, publicFusion, FUSED_PUBLIC_SOURCE_ID, true);
  }
  await insertRows(
    tx,
    "observation_latest",
    FUSED_COLUMNS,
    writes,
    upsertClause(SERIES_KEY, FUSED_COLUMNS),
  );
  counts.written = writes.length;

  const gone = existing
    .filter((r) => {
      const k = heldKey(r.source_id, r.subject_key, r.property, r.qualifier_key);
      const canonicalId = (r.record["subject"] as { featureId: string }).featureId;
      return !keep.has(k) && inScope(canonicalId, r.property);
    })
    .map((r) => r.series_id);
  if (gone.length > 0) {
    await tx`DELETE FROM conditions.observation_latest WHERE series_id = ANY(${gone}::bigint[])`;
  }
  counts.deleted += gone.length;
  return counts;
}

export interface OutdatedRefreshOptions {
  registry: Registry;
  instanceId: string;
  /** The time each batch is fused at, read as it starts. */
  now: () => string;
  /** Canonical features per transaction. */
  batchSize?: number;
  /** The licence registry's public classification; the registry's own by default. */
  licenses?: string;
  /** Ends the refresh before its next batch. */
  signal?: AbortSignal;
  /** Called once the outdated sources and their canonical features are listed. */
  onStart?: (plan: { sources: string[]; total: number }) => void;
  /** Called after each committed batch. */
  onBatch?: (progress: { done: number; total: number }) => void;
}

export interface OutdatedRefreshCounts extends FusedCounts {
  /** The sources whose fusions were outdated, in id order. */
  sources: string[];
  /** Of those, the ones whose fusions are now refreshed under their current basis. */
  settled: string[];
  /** Canonical features refreshed. */
  features: number;
  /** Canonical features the outdated sources have member features or fusable readings in. */
  total: number;
}

/**
 * Brings every source's fusions up to its current `restricted` flag and tier
 * and the licence registry's public classification
 * ({@link publicLicenseClassification}). A source's fusions are outdated when
 * the basis they were last refreshed under (`fusion_restricted`,
 * `fusion_tier`, `fusion_licenses`; null for a source never refreshed)
 * differs from its current one: a catalogue sync flipped it, a release
 * reclassified a licence (every source then), or an earlier refresh did not
 * finish. The fused rows of every canonical feature an outdated source has a
 * member feature or a fusable reading in are refreshed (a member that only
 * supplies the location still decides where a public row may sit), one
 * transaction per batch of canonical features, so a source with readings on
 * hundreds of thousands of them never holds one long transaction; each batch
 * takes the canonical features' locks in {@link refreshFused}, like any other
 * refresh, and fuses at its own `now`. A source's basis is recorded in the
 * transaction of the batch that holds its last canonical feature (at once,
 * when it has none), so a refresh stopped or failed part-way resumes at the
 * next call, and a finished one is not repeated. A canonical feature relinked
 * between the listing and its batch is refreshed by the write that relinked
 * it.
 */
export async function refreshOutdatedFusions(
  sql: postgres.Sql,
  opts: OutdatedRefreshOptions,
): Promise<OutdatedRefreshCounts> {
  const counts: OutdatedRefreshCounts = {
    sources: [],
    settled: [],
    features: 0,
    total: 0,
    written: 0,
    unchanged: 0,
    deleted: 0,
  };
  // The basis each source is refreshed under, as read now: a sync in between
  // leaves its source outdated again.
  const licenses = opts.licenses ?? publicLicenseClassification();
  const outdated = await sql<{ id: string; restricted: boolean; tier: string }[]>`
    SELECT id, restricted, tier FROM conditions.source
     WHERE (restricted, tier, ${licenses}::text)
           IS DISTINCT FROM (fusion_restricted, fusion_tier, fusion_licenses)
     ORDER BY id`;
  counts.sources = outdated.map((s) => s.id);
  const fusable = [...fusableProperties(opts.registry)];
  const touched = await sql<{ source_id: string; canonical_feature_id: string }[]>`
    SELECT DISTINCT f.source_id, c.canonical_feature_id
      FROM conditions.feature_canonical c
      CROSS JOIN LATERAL unnest(c.member_ids) AS m(feature_id)
      JOIN (SELECT l.source_id, l.feature_id FROM conditions.observation_latest l
             WHERE l.source_id = ANY(${counts.sources}::text[])
               AND l.feature_id IS NOT NULL
               AND l.property = ANY(${fusable}::text[])
            UNION
            SELECT ft.source_id, ft.id FROM conditions.feature ft
             WHERE ft.source_id = ANY(${counts.sources}::text[])) f
        ON f.feature_id = m.feature_id`;
  const canonicalIds = [...new Set(touched.map((t) => t.canonical_feature_id))].sort();
  const index = new Map(canonicalIds.map((id, i) => [id, i]));
  // Each source settles with the batch of its last canonical feature.
  const last = new Map<string, number>();
  for (const t of touched) {
    const i = index.get(t.canonical_feature_id)!;
    last.set(t.source_id, Math.max(last.get(t.source_id) ?? -1, i));
  }
  counts.total = canonicalIds.length;
  opts.onStart?.({ sources: counts.sources, total: counts.total });
  const settle = async (tx: Sql, ids: readonly string[]) => {
    const basis = outdated.filter((s) => ids.includes(s.id));
    if (basis.length === 0) return;
    // Row locks in id order before the update, so two refreshes settling
    // overlapping sources never wait on each other in a cycle.
    await tx`
      SELECT id FROM conditions.source
       WHERE id = ANY(${basis.map((b) => b.id)}::text[])
       ORDER BY id FOR NO KEY UPDATE`;
    await tx`
      UPDATE conditions.source s
         SET fusion_restricted = b.restricted, fusion_tier = b.tier, fusion_licenses = ${licenses}
        FROM jsonb_to_recordset(${tx.json(basis as never)}) AS b(id text, restricted boolean, tier text)
       WHERE s.id = b.id`;
    counts.settled.push(...basis.map((b) => b.id));
  };
  const stopped = () => opts.signal?.aborted === true;
  if (stopped()) return counts;
  await sql.begin((tx) =>
    settle(
      tx,
      counts.sources.filter((id) => !last.has(id)),
    ),
  );
  const size = opts.batchSize ?? 500;
  for (let i = 0; i < canonicalIds.length && !stopped(); i += size) {
    const batch = canonicalIds.slice(i, i + size);
    const end = i + batch.length;
    const batchCounts = (await sql.begin(async (tx) => {
      const c = await refreshFused(
        tx,
        opts.registry,
        batch.map((featureId) => ({ featureId })),
        { instanceId: opts.instanceId, now: opts.now() },
      );
      await settle(
        tx,
        [...last].filter(([, at]) => at >= i && at < end).map(([id]) => id),
      );
      return c;
    })) as FusedCounts;
    counts.features += batch.length;
    counts.written += batchCounts.written;
    counts.unchanged += batchCounts.unchanged;
    counts.deleted += batchCounts.deleted;
    opts.onBatch?.({ done: counts.features, total: counts.total });
  }
  counts.settled.sort();
  return counts;
}

/**
 * Refreshes the fusions of the sources whose freshness flipped in
 * (`from`, `to`]: a source whose last success passed its freshness window
 * then went stale, and a source whose success then followed none within its
 * window before it came back fresh. A polled feed restating its readings
 * writes nothing, so nothing else would refuse a stale winner, or give a
 * returning source its fusions back. Every canonical feature with a member
 * reading of a flipped source is refreshed as of `to`, 500 a transaction.
 * Returns the number of flipped sources.
 */
export async function refreshFlippedFusions(
  sql: postgres.Sql,
  registry: Registry,
  opts: { from: string; to: string; instanceId: string },
): Promise<number> {
  // Each source dated by when its last successful poll finished, as fusion
  // and read validity date it (`lastSuccessEnd`).
  const flipped = await sql<{ source: string }[]>`
    WITH last AS (
      SELECT ss.source, ss.last_success_at, ss.freshness_window_sec,
             ${sql.unsafe(lastSuccessEnd("ss"))} AS ended_at
        FROM conditions.source_status ss WHERE ss.last_success_at IS NOT NULL
    )
    SELECT source FROM last
     WHERE ended_at + make_interval(secs => freshness_window_sec) > ${opts.from}::timestamptz
       AND ended_at + make_interval(secs => freshness_window_sec) <= ${opts.to}::timestamptz
    UNION
    SELECT last.source FROM last
     WHERE ended_at > ${opts.from}::timestamptz AND ended_at <= ${opts.to}::timestamptz
       AND EXISTS (SELECT 1 FROM conditions.source_poll_attempt pa
                    WHERE pa.source = last.source AND pa.network_validated
                      AND pa.attempted_at < last.last_success_at)
       AND NOT EXISTS (SELECT 1 FROM conditions.source_poll_attempt pa
                        WHERE pa.source = last.source AND pa.network_validated
                          AND pa.attempted_at < last.last_success_at
                          AND COALESCE(pa.finished_at, pa.attempted_at)
                                >= last.ended_at - make_interval(secs => last.freshness_window_sec))`;
  if (flipped.length === 0) return 0;
  const fusable = [...fusableProperties(registry)];
  const features = await sql<{ feature_id: string }[]>`
    SELECT DISTINCT l.feature_id FROM conditions.observation_latest l
     WHERE l.source_id = ANY(${flipped.map((f) => f.source)}::text[])
       AND l.feature_id IS NOT NULL AND l.property = ANY(${fusable}::text[])`;
  const members = await sql<{ canonical_feature_id: string }[]>`
    WITH held AS MATERIALIZED (${clustersHolding(
      sql,
      features.map((f) => f.feature_id),
    )})
    SELECT canonical_feature_id FROM held ORDER BY canonical_feature_id`;
  const ids = members.map((m) => m.canonical_feature_id);
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    await sql.begin((tx) =>
      refreshFused(
        tx,
        registry,
        batch.map((featureId) => ({ featureId })),
        { instanceId: opts.instanceId, now: opts.to },
      ),
    );
  }
  return flipped.length;
}

const startOf = (record: Rec) => {
  const t = record["phenomenonTime"] as { instant?: string; start?: string };
  return (t.instant ?? t.start)!;
};

/** Deletes the fused rows, full and public, of canonical features that no longer exist. */
async function dropFused(tx: Sql, canonicalIds: readonly string[]): Promise<number> {
  if (canonicalIds.length === 0) return 0;
  const rows = await tx`
    DELETE FROM conditions.observation_latest
     WHERE source_id = ANY(${[...FUSED_SOURCE_IDS]}::text[])
       AND feature_id = ANY(${canonicalIds as string[]}::text[])
    RETURNING series_id`;
  return rows.length;
}

/** Advisory lock namespaces of {@link lockKeys}, always taken in this order. */
export const LOCK_SPACES = { featureLink: 1, fused: 2 } as const;

/**
 * Keys hash into this many locks per namespace. A first poll touches tens of
 * thousands of canonical features, and one lock per key would overflow the
 * shared lock table (`max_locks_per_transaction` × `max_connections`, 6400 by
 * default); two keys sharing a bucket only wait on each other.
 */
const LOCK_BUCKETS = 1024;

/**
 * Takes transaction-scoped advisory locks on keys within one namespace: the
 * two-key form, so they never meet a source's lock, and in bucket order so
 * two transactions locking overlapping sets never wait on each other in a
 * cycle. A transaction takes link locks before fused locks, never the other
 * way round.
 */
export async function lockKeys(
  tx: Sql,
  space: (typeof LOCK_SPACES)[keyof typeof LOCK_SPACES],
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  await tx`
    SELECT pg_advisory_xact_lock(${space}::int, b)
      FROM (SELECT DISTINCT (hashtext(k) & ${LOCK_BUCKETS - 1}) AS b
              FROM unnest(${keys as string[]}::text[]) AS k ORDER BY 1) s`;
}
