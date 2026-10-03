import { fusableProperties, seriesKeyOf } from "@openconditions/core";
import {
  type CanonicalComponent,
  type EvidenceState,
  FUSED_SOURCE_ID,
  type FusableObservation,
  type FusionCandidate,
  fuse,
  fusedObservation,
  jcs,
  type LocationRef,
  type Registry,
  type SourceTier,
  sealRecord,
} from "@openconditions/model";
import { type ColumnSpec, insertRows, type Sql, upsertClause } from "./bulk.js";
import { SERIES_COLUMNS, SERIES_KEY, seriesRowOf } from "./write-observations.js";

type Rec = Record<string, unknown>;

/** The source id of every crowd row, local or a peer's. */
const CROWD_SOURCE_ID = "crowd";

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
    SELECT canonical_feature_id, survivor_id, member_ids, components
      FROM conditions.feature_canonical
     WHERE canonical_feature_id = ANY(${featureIds as string[]})
        OR member_ids && ${featureIds as string[]}::text[]`;
  return rows.map((r) => ({
    canonicalFeatureId: r.canonical_feature_id,
    survivorId: r.survivor_id,
    memberIds: r.member_ids,
    components: r.components,
  }));
}

/** The canonical component a member's component stands in, by its key. */
export function canonicalKeyOf(
  canonical: CanonicalRow,
  featureId: string,
  componentKey: string,
): string | undefined {
  return canonical.components.find((c) =>
    c.members.some((m) => m.featureId === featureId && m.key === componentKey),
  )?.key;
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
  stale: boolean;
}

interface FusedRow {
  series_id: string;
  subject_key: string;
  property: string;
  qualifier_key: string;
  record: Rec;
  since_at: Date;
}

const FUSED_COLUMNS: ColumnSpec[] = [...SERIES_COLUMNS, { name: "fused_from", type: "text[]" }];

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
 * last successful poll is older than its freshness window (a source with no
 * status row yet has never failed one, and counts as fresh). The winner is
 * written as the subject's fused row (latest only: it never enters history
 * or the federation), with its contributors in `fused_from`; a subject where
 * nothing qualifies has no fused row. A fused row whose value, contributors
 * and lifetime are unchanged is left alone.
 */
export async function refreshFused(
  tx: Sql,
  registry: Registry,
  scopes: readonly FusedScope[],
  ctx: FusedContext,
): Promise<FusedCounts> {
  const counts: FusedCounts = { written: 0, unchanged: 0, deleted: 0 };
  const fusable = fusableProperties(registry);
  const wanted = scopes
    .map((s) => ({
      ...s,
      properties: s.properties?.filter((p) => fusable.has(p)),
    }))
    .filter((s) => s.properties === undefined || s.properties.length > 0);
  if (wanted.length === 0) return counts;

  const canonical = await loadCanonical(
    tx,
    wanted.map((s) => s.featureId),
  );
  if (canonical.length === 0) return counts;
  // Writers of different sources refresh the same fused rows under their own
  // source locks; each canonical feature's lock, taken in id order, keeps one
  // refresh from overwriting another's newer view with its older one.
  await lockKeys(
    tx,
    LOCK_SPACES.fused,
    canonical.map((c) => c.canonicalFeatureId),
  );
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
           l.evidence_state, s.tier,
           COALESCE(l.source_id <> ALL(${fresh as string[]}::text[]) AND ss.source IS NOT NULL
             AND (ss.last_success_at IS NULL
               OR ss.last_success_at < ${ctx.now}::timestamptz
                    - make_interval(secs => ss.freshness_window_sec)), false) AS stale
      FROM conditions.observation_latest l
      LEFT JOIN conditions.source s ON s.id = l.source_id
      LEFT JOIN conditions.source_status ss ON ss.source = l.source_id
     WHERE l.property = ANY(${[...fusable]}::text[])
       AND l.source_id <> ${FUSED_SOURCE_ID}
       AND ((l.source_id <> ${CROWD_SOURCE_ID} AND l.feature_id = ANY(${[...memberOf.keys()]}::text[]))
         OR (l.source_id = ${CROWD_SOURCE_ID}
             AND l.feature_id = ANY(${[...byCanonical.keys()]}::text[])))`;

  interface Group {
    canonical: CanonicalRow;
    componentKey: string | undefined;
    property: string;
    qualifierKey: string;
    candidates: { row: CandidateRow; candidate: FusionCandidate }[];
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
    group.candidates.push({ row, candidate });
    groups.set(key, group);
  }

  // A fused row sits where the record whose value it shows puts the feature,
  // under that record's credit: another member's geometry may be licensed
  // otherwise. A crowd value sits at the survivor's.
  const locations = new Map(
    (
      await tx<{ id: string; location: LocationRef }[]>`
        SELECT id, record->'location' AS location FROM conditions.feature
         WHERE id = ANY(${canonical.flatMap((c) => c.memberIds)}::text[])`
    ).map((r) => [r.id, r.location]),
  );
  const existing = await tx<FusedRow[]>`
    SELECT series_id::text AS series_id, subject_key, property, qualifier_key,
           conditions.observation_record(template, reading) AS record, since_at
      FROM conditions.observation_latest
     WHERE source_id = ${FUSED_SOURCE_ID}
       AND feature_id = ANY(${[...byCanonical.keys()]}::text[])`;
  const held = new Map(existing.map((r) => [jcs([r.subject_key, r.property, r.qualifier_key]), r]));

  const keep = new Set<string>();
  const writes: Rec[] = [];
  for (const group of groups.values()) {
    const fusion = fuse(
      registry,
      group.property,
      group.candidates.map((g) => g.candidate),
      ctx.now,
    );
    if (fusion === undefined) continue;
    const winner = group.candidates.find((g) => g.candidate === fusion.winner)?.row;
    const location =
      (winner === undefined ? undefined : locations.get(winner.feature_id)) ??
      locations.get(group.canonical.survivorId);
    if (location === undefined) continue;
    const draft = fusedObservation(registry, fusion, {
      subject: {
        kind: "feature",
        featureId: group.canonical.canonicalFeatureId,
        ...(group.componentKey === undefined ? {} : { componentKey: group.componentKey }),
      },
      location,
      instanceId: ctx.instanceId,
      now: ctx.now,
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
    const k = jcs([key.subjectKey, key.property, key.qualifierKey]);
    keep.add(k);
    const prev = held.get(k);
    if (prev !== undefined && comparable(prev.record) === comparable(record)) {
      counts.unchanged++;
      continue;
    }
    const property = registry.property(group.property)!;
    const sameValue = prev !== undefined && jcs(prev.record["result"]) === jcs(record["result"]);
    const sinceAt = sameValue
      ? prev.since_at.toISOString()
      : new Date(Date.parse(startOf(record))).toISOString();
    writes.push({
      ...seriesRowOf({ ...record, sinceAt }, property, undefined, ctx.now),
      fused_from: fusion.contributors.map((c) => c.observation.id),
    });
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
      const k = jcs([r.subject_key, r.property, r.qualifier_key]);
      const canonicalId = (r.record["subject"] as { featureId: string }).featureId;
      return !keep.has(k) && inScope(canonicalId, r.property);
    })
    .map((r) => r.series_id);
  if (gone.length > 0) {
    await tx`DELETE FROM conditions.observation_latest WHERE series_id = ANY(${gone}::bigint[])`;
  }
  counts.deleted = gone.length;
  return counts;
}

const startOf = (record: Rec) => {
  const t = record["phenomenonTime"] as { instant?: string; start?: string };
  return (t.instant ?? t.start)!;
};

/** Deletes the fused rows of canonical features that no longer exist. */
export async function dropFused(tx: Sql, canonicalIds: readonly string[]): Promise<number> {
  if (canonicalIds.length === 0) return 0;
  const rows = await tx`
    DELETE FROM conditions.observation_latest
     WHERE source_id = ${FUSED_SOURCE_ID} AND feature_id = ANY(${canonicalIds as string[]}::text[])
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
