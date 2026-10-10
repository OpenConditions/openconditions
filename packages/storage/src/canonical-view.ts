import {
  canonicalKeyOf,
  fusableFeatureKinds,
  fusableProperties,
  seriesKeyOf,
  templateOf,
} from "@openconditions/core";
import {
  type CanonicalCluster,
  type CanonicalComponent,
  type ComponentHolder,
  canonicalClusters,
  canonicalComponents,
  type FeatureLink,
  jcs,
  type LinkableFeature,
  observationId,
  parseRecordId,
  proposeLink,
  type Registry,
  sealRecord,
  survivorRank,
} from "@openconditions/model";
import type { Sql } from "./bulk.js";
import { clustersHolding } from "./canonical-holding.js";
import {
  type CanonicalRow,
  type FusedScope,
  LOCK_SPACES,
  lockKeys,
  refreshFused,
} from "./fused-rows.js";
import { pause, RECORDS_PER_TURN } from "./pause.js";
import { seriesRowOf } from "./write-observations.js";

type Rec = Record<string, unknown>;

export interface RelinkOptions {
  /** The features written or tombstoned: what linking starts from. */
  featureIds: readonly string[];
  instanceId: string;
  now: string;
}

export interface RelinkResult {
  /** The canonical features now holding the features linking reconsidered. */
  canonicalIds: string[];
  /** The kind of each of those canonical features (a cluster is of one kind). */
  kindOf: Map<string, string>;
  /** Canonical features replaced by others: their fused rows went, their crowd rows moved. */
  vanished: string[];
  /** Crowd series moved onto the canonical feature now holding their subject. */
  movedCrowdSeries: number;
  /** Crowd series whose canonical component no longer exists, deleted. */
  droppedCrowdSeries: number;
}

interface FeatureRow {
  id: string;
  kind: string;
  record: Rec;
  tombstoned: boolean;
}

interface LinkRow {
  a_id: string;
  b_id: string;
  status: string;
  decided_by: string | null;
}

const pairKey = (a: string, b: string) => (a < b ? jcs([a, b]) : jcs([b, a]));

/** Linkable features one write touches above which linking refreshes the planner's statistics. */
const ANALYZE_ABOVE = 1000;

/** A link a human or a reviewer decided, which recomputation never overwrites. */
const decided = (l: LinkRow) => l.status === "rejected" || l.decided_by !== null;

/**
 * Re-derives the links and canonical clusters around written features. For
 * each live feature of a kind with linking rules, the candidates are the
 * live features of that kind within its `neverMetres` or sharing one of its
 * authoritative external ids; `proposeLink` decides each pair, and the
 * stored link follows unless a person decided it (a `rejected` or manual
 * link stays as it is). The connected clusters the touched features belong
 * to now or did before are then recomputed with `canonicalClusters`, and
 * their `feature_canonical` rows replaced, each with its canonical component
 * set. A feature of a kind without linking rules is a cluster of one, so
 * every live feature has exactly one canonical row and a consumer resolves
 * any feature to its canonical feature with one lookup. A cluster whose id
 * or whose component keys changed takes its crowd rows along (see
 * {@link rekeyCrowdSeries}); its fused rows are the caller's to recompute.
 */
export async function relinkFeatures(
  tx: Sql,
  registry: Registry,
  opts: RelinkOptions,
): Promise<RelinkResult> {
  const result: RelinkResult = {
    canonicalIds: [],
    kindOf: new Map(),
    vanished: [],
    movedCrowdSeries: 0,
    droppedCrowdSeries: 0,
  };
  if (opts.featureIds.length === 0) return result;
  const touched = await loadFeatures(tx, opts.featureIds);
  // A feature deleted outright (an on-demand answer that lapsed) has no row
  // any more, but its links and its cluster still name it.
  const named = [...opts.featureIds];
  // Sources link with each other's features, so linking a kind is serialised
  // across their writes: two polls never rebuild one cluster at once.
  const kinds = [...new Set(touched.map((f) => f.kind))].filter(
    (k) => registry.kind("feature", k)?.linking !== undefined,
  );
  if (kinds.length > 0) {
    await lockKeys(tx, LOCK_SPACES.featureLink, kinds);
  }

  // Links: evaluate every pair of a live touched feature and its candidates.
  const linkable = touched.filter(
    (f) => !f.tombstoned && registry.kind("feature", f.kind)?.linking !== undefined,
  );
  const stored = await tx<LinkRow[]>`
    SELECT a_id, b_id, status, decided_by FROM conditions.feature_link
     WHERE a_id = ANY(${named}::text[]) OR b_id = ANY(${named}::text[])`;
  const storedByPair = new Map(stored.map((l) => [pairKey(l.a_id, l.b_id), l]));
  const proposals = new Map<string, FeatureLink>();
  // A register's first poll inserts thousands of features in this very
  // transaction, unseen by the planner's statistics: it would plan the pair
  // search as if the table were empty and compare every pair (minutes, not
  // a second). Analysing first lets it walk the spatial index.
  if (linkable.length >= ANALYZE_ABOVE) await tx`ANALYZE conditions.feature`;
  for (const kind of new Set(linkable.map((f) => f.kind))) {
    const rules = registry.kind("feature", kind)!.linking!;
    const own = linkable.filter((f) => f.kind === kind);
    const pairs = await candidatePairs(tx, kind, own, rules);
    const known = new Map(own.map((f) => [f.id, f]));
    const others = [...new Set(pairs.flat())].filter((id) => !known.has(id));
    for (const f of await loadFeatures(tx, others)) known.set(f.id, f);
    let compared = 0;
    for (const [a, b] of pairs) {
      if (++compared % (4 * RECORDS_PER_TURN) === 0) await pause();
      const key = pairKey(a, b);
      if (proposals.has(key)) continue;
      const left = known.get(a);
      const right = known.get(b);
      if (left === undefined || right === undefined) continue;
      const link = proposeLink(linkableOf(left.record), linkableOf(right.record), rules);
      if (link !== undefined) proposals.set(key, link);
    }
  }
  const upserts = [...proposals.entries()]
    .filter(([key]) => {
      const held = storedByPair.get(key);
      return held === undefined || !decided(held);
    })
    .map(([, l]) => ({
      a_id: l.aId,
      b_id: l.bId,
      method: l.method,
      confidence: l.confidence,
      status: l.status,
    }));
  if (upserts.length > 0) {
    await tx`
      INSERT INTO conditions.feature_link (a_id, b_id, method, confidence, status, decided_at)
      SELECT a_id, b_id, method, confidence, status, ${opts.now}::timestamptz
        FROM jsonb_to_recordset(${JSON.stringify(upserts)}::text::jsonb)
          AS r(a_id text, b_id text, method text, confidence double precision, status text)
      ON CONFLICT (a_id, b_id) DO UPDATE SET
        method = excluded.method, confidence = excluded.confidence, status = excluded.status,
        decided_at = excluded.decided_at
      WHERE conditions.feature_link.status <> 'rejected'
        AND conditions.feature_link.decided_by IS NULL`;
  }
  // An automatic link no proposal backs any more (a feature moved, changed or ended) goes.
  const stale = stored.filter((l) => !decided(l) && !proposals.has(pairKey(l.a_id, l.b_id)));
  if (stale.length > 0) {
    await tx`
      DELETE FROM conditions.feature_link l
       USING jsonb_to_recordset(${JSON.stringify(stale.map((l) => ({ a: l.a_id, b: l.b_id })))}::text::jsonb)
         AS r(a text, b text)
       WHERE l.a_id = r.a AND l.b_id = r.b`;
  }

  // Clusters: everything connected to a touched feature now, or clustered with one before.
  const before = await tx<
    {
      canonical_feature_id: string;
      survivor_id: string;
      member_ids: string[];
      components: CanonicalComponent[];
    }[]
  >`
    WITH held AS MATERIALIZED (${clustersHolding(tx, named)})
    SELECT c.canonical_feature_id, c.survivor_id, c.member_ids, c.components
      FROM conditions.feature_canonical c JOIN held USING (canonical_feature_id)`;
  const seeds = new Set([...named, ...before.flatMap((r) => r.member_ids)]);
  const { members, links } = await connected(tx, [...seeds]);
  const live = members.filter((m) => !m.tombstoned);
  const clusters = canonicalClusters(
    live.map((m) => linkableOf(m.record)),
    links,
    { instanceId: opts.instanceId, rank: survivorRank },
  );
  const byId = new Map(live.map((m) => [m.id, m]));
  const rows = clusters.map((cluster) => ({
    cluster,
    components: canonicalComponents(
      registry,
      cluster,
      cluster.memberIds.map((id) => byId.get(id)!.record as unknown as ComponentHolder),
    ),
  }));
  // The clusters being replaced: every one holding a feature reconsidered now.
  const replaced = await tx<
    {
      canonical_feature_id: string;
      survivor_id: string;
      member_ids: string[];
      components: CanonicalComponent[];
    }[]
  >`
    WITH held AS MATERIALIZED (${clustersHolding(tx, [...seeds, ...members.map((m) => m.id)])})
    DELETE FROM conditions.feature_canonical c USING held
     WHERE c.canonical_feature_id = held.canonical_feature_id
    RETURNING c.canonical_feature_id, c.survivor_id, c.member_ids, c.components`;
  if (rows.length > 0) {
    await tx`
      INSERT INTO conditions.feature_canonical
        (canonical_feature_id, survivor_id, member_ids, merged_sources, components, computed_at)
      SELECT canonical_feature_id, survivor_id, member_ids, merged_sources, components,
             ${opts.now}::timestamptz
        FROM jsonb_to_recordset(${JSON.stringify(
          rows.map(({ cluster, components }) => ({
            canonical_feature_id: cluster.canonicalFeatureId,
            survivor_id: cluster.survivorId,
            member_ids: cluster.memberIds,
            merged_sources: cluster.mergedSources,
            components,
          })),
        )}::text::jsonb)
          AS r(canonical_feature_id text, survivor_id text, member_ids text[],
               merged_sources jsonb, components jsonb)`;
  }
  const now = new Map(rows.map((r) => [r.cluster.canonicalFeatureId, r]));
  result.canonicalIds = [...now.keys()];
  for (const { cluster } of rows) {
    result.kindOf.set(cluster.canonicalFeatureId, byId.get(cluster.survivorId)!.kind);
  }
  const vanished = replaced.filter((r) => !now.has(r.canonical_feature_id));
  result.vanished = vanished.map((r) => r.canonical_feature_id);
  // A cluster that stays can still re-key its components (a member's charge
  // point gains the uid that makes it the survivor's): its crowd rows follow.
  const rekeyed = replaced.filter((r) => {
    const kept = now.get(r.canonical_feature_id);
    return kept !== undefined && jcs(kept.components) !== jcs(r.components);
  });
  const moved = await rekeyCrowdSeries(
    tx,
    registry,
    [...vanished, ...rekeyed].map((r) => ({
      canonicalFeatureId: r.canonical_feature_id,
      survivorId: r.survivor_id,
      memberIds: r.member_ids,
      components: r.components,
    })),
    rows.map(({ cluster, components }) => canonicalRowOf(cluster, components)),
    opts,
  );
  result.movedCrowdSeries = moved.moved;
  result.droppedCrowdSeries = moved.dropped;
  return result;
}

const canonicalRowOf = (
  cluster: CanonicalCluster,
  components: CanonicalComponent[],
): CanonicalRow => ({
  canonicalFeatureId: cluster.canonicalFeatureId,
  survivorId: cluster.survivorId,
  memberIds: [...cluster.memberIds],
  components,
});

async function loadFeatures(tx: Sql, ids: readonly string[]): Promise<FeatureRow[]> {
  if (ids.length === 0) return [];
  return tx<FeatureRow[]>`
    SELECT id, kind, record, tombstoned_at IS NOT NULL AS tombstoned
      FROM conditions.feature WHERE id = ANY(${ids as string[]}::text[])`;
}

/** A stored feature as linking reads it. */
const linkableOf = (record: Rec) => record as unknown as LinkableFeature;

/**
 * The pairs a linking pass decides: each written feature with every live
 * feature of its kind within the kind's `neverMetres` (a bounding box first,
 * so the spatial index serves it, then the exact distance) or sharing one of
 * its external ids of an authoritative scheme (the external-id index serves
 * it). Only these can link, so a register's first poll of thousands of
 * features compares neighbours, never every pair.
 */
async function candidatePairs(
  tx: Sql,
  kind: string,
  own: readonly FeatureRow[],
  rules: { neverMetres: number; idSchemes: readonly string[] },
): Promise<[string, string][]> {
  const ids = own.map((f) => f.id);
  const rows = await tx<{ a: string; b: string }[]>`
    SELECT t.id AS a, f.id AS b
      FROM conditions.feature t
      JOIN conditions.feature f
        ON f.kind = t.kind AND f.id <> t.id AND f.tombstoned_at IS NULL
       AND f.geom && ST_Expand(t.geom, ${rules.neverMetres}::float8
             / (111320 * cos(radians(least(abs(ST_Y(ST_Centroid(t.geom))), 89)))))
       AND ST_DWithin(f.geom::geography, t.geom::geography, ${rules.neverMetres})
     WHERE t.id = ANY(${ids}::text[]) AND t.kind = ${kind} AND t.geom IS NOT NULL
    UNION
    SELECT t.id AS a, f.id AS b
      FROM conditions.feature t
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.record -> 'externalIds', '[]'::jsonb)) e
     -- The external-id index alone: OFFSET 0 keeps the kind test out of the
     -- lookup, which would intersect every lookup with the whole kind.
     CROSS JOIN LATERAL (
       SELECT f.id, f.kind, f.tombstoned_at FROM conditions.feature f
        WHERE (f.record -> 'externalIds') @> jsonb_build_array(e) OFFSET 0) f
     WHERE t.id = ANY(${ids}::text[]) AND t.kind = ${kind}
       AND e ->> 'scheme' = ANY(${rules.idSchemes as string[]}::text[])
       AND f.kind = t.kind AND f.id <> t.id AND f.tombstoned_at IS NULL`;
  return rows.map((r) => [r.a, r.b]);
}

/**
 * The features connected to the seeds by accepted links, and those links:
 * the closure a cluster recomputation needs, since a cluster is decided over
 * every link of its members.
 */
async function connected(
  tx: Sql,
  seeds: readonly string[],
): Promise<{ members: FeatureRow[]; links: FeatureLink[] }> {
  const seen = new Set(seeds);
  const links = new Map<string, FeatureLink>();
  let frontier = [...seeds];
  while (frontier.length > 0) {
    const found = await tx<{ a_id: string; b_id: string; method: string; confidence: number }[]>`
      SELECT l.a_id, l.b_id, l.method, l.confidence FROM conditions.feature_link l
       WHERE l.status = 'accepted'
         AND (l.a_id = ANY(${frontier}::text[]) OR l.b_id = ANY(${frontier}::text[]))`;
    frontier = [];
    for (const l of found) {
      links.set(pairKey(l.a_id, l.b_id), {
        aId: l.a_id,
        bId: l.b_id,
        method: l.method as FeatureLink["method"],
        confidence: l.confidence,
        status: "accepted",
        reasons: [],
      });
      for (const id of [l.a_id, l.b_id]) {
        if (!seen.has(id)) {
          seen.add(id);
          frontier.push(id);
        }
      }
    }
  }
  return { members: await loadFeatures(tx, [...seen]), links: [...links.values()] };
}

/**
 * Moves the crowd rows of canonical features that no longer exist, or no
 * longer as they were, onto the clusters now holding what they report: `former`
 * holds each such cluster as it was, and a row already where it belongs stays
 * as it is. A reading about a component goes to the cluster holding the
 * member component it stood for (the survivor's first), a reading about the
 * feature to the cluster holding the former one's survivor (or, when the survivor ended, its first member still
 * standing). The subject becomes that cluster's canonical feature and
 * canonical component, and the record is re-derived for its new subject, its
 * evidence and votes following its new id. A crowd row whose component no
 * standing member holds any more, or whose cluster left nothing standing, is
 * deleted with its history: an observation has no tombstone. Where the new
 * subject already holds a crowd row, the later reading stays.
 */
export async function rekeyCrowdSeries(
  tx: Sql,
  registry: Registry,
  former: readonly CanonicalRow[],
  current: readonly CanonicalRow[],
  ctx: { instanceId: string; now: string },
): Promise<{ moved: number; dropped: number }> {
  const out = { moved: 0, dropped: 0 };
  if (former.length === 0) return out;
  // Crowd rows are the crowd's to write: under its lock, a report resolved
  // against the former cluster before this relink lands before the move
  // reads the rows, and one resolved after it sees the new clusters.
  await tx`SELECT pg_advisory_xact_lock(hashtext('crowd'))`;
  const series = await tx<
    {
      series_id: string;
      feature_id: string;
      component_key: string | null;
      since_at: Date;
      record: Rec;
      retention_days: number | null;
    }[]
  >`
    SELECT series_id::text AS series_id, feature_id, component_key, since_at,
           conditions.observation_record(template, reading) AS record, retention_days
      FROM conditions.observation_latest
     WHERE source_id = 'crowd'
       AND feature_id = ANY(${former.map((v) => v.canonicalFeatureId)}::text[])
     ORDER BY effective_from DESC`;
  if (series.length === 0) return out;
  const holding = new Map<string, CanonicalRow>();
  for (const c of current) for (const m of c.memberIds) holding.set(m, c);
  const old = new Map(former.map((v) => [v.canonicalFeatureId, v]));

  const drop: string[] = [];
  for (const s of series) {
    const was = old.get(s.feature_id)!;
    const rank = (featureId: string) => (featureId === was.survivorId ? 0 : 1);
    let target: CanonicalRow | undefined;
    let componentKey: string | undefined;
    if (s.component_key === null) {
      const order = [was.survivorId, ...was.memberIds.filter((m) => m !== was.survivorId)];
      target = order.map((m) => holding.get(m)).find((c) => c !== undefined);
    } else {
      // A component's reading follows the member component it stands for,
      // the survivor's first: to whichever cluster now holds that member.
      const members = [
        ...(was.components.find((c) => c.key === s.component_key)?.members ?? []),
      ].sort((a, b) => rank(a.featureId) - rank(b.featureId));
      for (const m of members) {
        const holder = holding.get(m.featureId);
        const key = holder === undefined ? undefined : canonicalKeyOf(holder, m.featureId, m.key);
        if (key !== undefined) {
          target = holder;
          componentKey = key;
          break;
        }
      }
    }
    if (target === undefined) {
      drop.push(s.series_id);
      continue;
    }
    if (target.canonicalFeatureId === s.feature_id && (componentKey ?? null) === s.component_key) {
      continue;
    }
    const oldId = s.record["id"] as string;
    const subject = {
      kind: "feature",
      featureId: target.canonicalFeatureId,
      ...(componentKey === undefined ? {} : { componentKey }),
    };
    const record = reseal(registry, { ...s.record, subject }, ctx.instanceId);
    const key = seriesKeyOf(record);
    const [clash] = await tx<{ series_id: string; effective_from: Date }[]>`
      SELECT series_id::text AS series_id, effective_from FROM conditions.observation_latest
       WHERE subject_key = ${key.subjectKey} AND property = ${key.property}
         AND qualifier_key = ${key.qualifierKey} AND source_id = 'crowd'`;
    if (clash !== undefined) {
      // Rows are visited newest first, so the one already there is the later reading.
      drop.push(s.series_id);
      continue;
    }
    const property = registry.property(key.property)!;
    const row = seriesRowOf(
      { ...record, sinceAt: s.since_at.toISOString() },
      property,
      s.retention_days ?? undefined,
      ctx.now,
    );
    await tx`
      UPDATE conditions.observation_latest
         SET subject_key = ${row["subject_key"] as string}, feature_id = ${target.canonicalFeatureId},
             component_key = ${componentKey ?? null}, reading = ${tx.json(row["reading"] as never)},
             template = ${tx.json(row["template"] as never)},
             template_hash = ${row["template_hash"] as string},
             crowd_record_id = ${row["crowd_record_id"] as string}, updated_at = ${ctx.now}
       WHERE series_id = ${s.series_id}::bigint`;
    const newId = record["id"] as string;
    await tx`
      UPDATE conditions.report_evidence SET record_id = ${newId}
       WHERE record_class = 'observation' AND record_id = ${oldId}`;
    await tx`
      UPDATE conditions.sub_claim SET subject_id = ${newId}
       WHERE subject_class = 'observation' AND subject_id = ${oldId}`;
    out.moved++;
  }
  if (drop.length > 0) {
    const records = await tx<{ id: string }[]>`
      DELETE FROM conditions.observation_latest WHERE series_id = ANY(${drop}::bigint[])
      RETURNING crowd_record_id AS id`;
    await tx`DELETE FROM conditions.observation WHERE series_id = ANY(${drop}::bigint[])`;
    const ids = records.map((r) => r.id);
    await tx`
      DELETE FROM conditions.report_evidence
       WHERE record_class = 'observation' AND record_id = ANY(${ids}::text[])`;
    await tx`
      DELETE FROM conditions.sub_claim
       WHERE subject_class = 'observation' AND subject_id = ANY(${ids}::text[])`;
    out.dropped += drop.length;
  }
  return out;
}

const startOf = (record: Rec) => {
  const t = record["phenomenonTime"] as { instant?: string; start?: string };
  return new Date((t.instant ?? t.start)!).toISOString();
};

/**
 * A stored crowd observation re-derived for a new subject: its id, canonical
 * id and content hash follow the subject; its revision, record time and
 * provenance stay.
 */
function reseal(registry: Registry, record: Rec, instanceId: string): Rec {
  const {
    canonicalId: _c,
    domain: _d,
    contentHash: _h,
    revision,
    recordedAt,
    sinceAt: _s,
    ...draft
  } = record;
  const { instanceId: _i, ...provenance } = draft["provenance"] as Rec;
  const namespace = parseRecordId(record["id"] as string)?.namespace ?? instanceId;
  const next: Rec = { ...draft, provenance };
  next["id"] = observationId(namespace, next as never);
  const sealed = sealRecord(registry, next, {
    instanceId: (record["provenance"] as Rec)["instanceId"] as string,
    revision: revision as number,
    recordedAt: recordedAt as string,
  });
  if (!sealed.ok) throw new TypeError(`a moved crowd row failed sealing: ${jcs(sealed.issues)}`);
  return sealed.value;
}

/** What one write changed that the canonical view and the fused rows depend on. */
export interface CanonicalTouch {
  /** The source written, fresh whatever its status row says until its poll commits. */
  sourceId: string;
  /** Features created, changed, restored or tombstoned. */
  featureIds: readonly string[];
  /** Observations written, as drafts or stored records. */
  observations: readonly Rec[];
  /** The fused readings of the series the write ended, which their fusion now leaves out. */
  ended?: readonly FusedScope[];
}

/**
 * Keeps the canonical view and the fused rows in step with one write, in the
 * writer's transaction: written features are relinked, the fused rows of
 * clusters that vanished are dropped, and the fused rows of every cluster
 * relinked, of every feature with a fusable reading written now and of every
 * series the write ended are recomputed. A reading only counts when it moved
 * its series in this write (`updated_at` is the write's time), so a feed
 * re-sending unchanged prices costs one indexed lookup and no fusion. The
 * links are locked before the fused rows, and the fused rows in one round
 * ({@link lockKeys}): a writer refreshing fused rows apart from this would
 * take them in an order another writer can wait on in a cycle.
 */
export async function updateCanonicalView(
  tx: Sql,
  registry: Registry,
  touch: CanonicalTouch,
  ctx: { instanceId: string; now: string },
): Promise<void> {
  const relinked = await relinkFeatures(tx, registry, {
    featureIds: touch.featureIds,
    instanceId: ctx.instanceId,
    now: ctx.now,
  });
  const fusable = fusableProperties(registry);
  const subjects = new Set<string>();
  for (const o of touch.observations) {
    const subject = o["subject"] as { kind?: string; featureId?: string } | undefined;
    if (subject?.kind === "feature" && subject.featureId !== undefined) {
      if (fusable.has(o["property"] as string)) subjects.add(subject.featureId);
    }
  }
  const moved =
    subjects.size === 0
      ? []
      : await tx<{ feature_id: string; property: string }[]>`
          SELECT DISTINCT feature_id, property FROM conditions.observation_latest
           WHERE feature_id = ANY(${[...subjects]}::text[]) AND source_id = ${touch.sourceId}
             AND updated_at = ${ctx.now}::timestamptz
             AND property = ANY(${[...fusable]}::text[])`;
  const fusableKinds = fusableFeatureKinds(registry);
  const scopes: FusedScope[] = [
    ...relinked.canonicalIds
      .filter((id) => fusableKinds.has(relinked.kindOf.get(id)!))
      .map((featureId) => ({ featureId })),
    ...moved.map((m) => ({ featureId: m.feature_id, properties: [m.property] })),
    ...(touch.ended ?? []),
  ];
  await refreshFused(tx, registry, scopes, {
    ...ctx,
    freshSources: [touch.sourceId],
    vanished: relinked.vanished,
  });
}
