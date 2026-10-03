import { canonicalIdOf, parseRecordId } from "@openconditions/model";
import type { CanonicalFeature } from "./db/records.js";
import type { QueryRunner } from "./query-runner.js";
import { binder, type RecordFilters, recordFilterClauses } from "./record-filters.js";

type Rec = Record<string, unknown>;

export interface FeatureQuery extends RecordFilters {
  /** The instant features are current at: not tombstoned, not past their expiry. Default now. */
  at?: Date;
  /** The last id of the previous page. */
  cursor?: string;
  limit: number;
}

export interface FeaturePage {
  records: Rec[];
  /** The cursor of the next page; null when this page is the last. */
  next: string | null;
}

/** A feature as a collection lists it by default: without its components. */
export function withoutComponents(record: Rec): Rec {
  if (record["components"] === undefined) return record;
  const { components: _components, ...rest } = record;
  return rest;
}

function liveClauses(t: string, at: string, f: RecordFilters, p: (v: unknown) => string) {
  return [
    `${t}.tombstoned_at IS NULL`,
    `(${t}.expires_at IS NULL OR ${t}.expires_at > ${p(at)}::timestamptz)`,
    ...recordFilterClauses(t, f, p),
  ];
}

/**
 * The live features matching `q`, one keyset page ordered by id, each whole
 * (components included). Each page is one statement, so a walk never returns
 * a feature twice and never skips one that exists throughout it.
 */
export async function listFeatures(db: QueryRunner, q: FeatureQuery): Promise<FeaturePage> {
  const params: unknown[] = [];
  const p = binder(params);
  const clauses = liveClauses("f", (q.at ?? new Date()).toISOString(), q, p);
  if (q.cursor !== undefined) clauses.push(`f.id > ${p(q.cursor)}`);
  const rows = await db.execute<{ id: string; record: Rec }[]>(
    `SELECT f.id, f.record FROM conditions.feature f
      WHERE ${clauses.join(" AND ")}
      ORDER BY f.id
      LIMIT ${p(q.limit + 1)}`,
    params,
  );
  const page = rows.slice(0, q.limit);
  return {
    records: page.map((r) => r.record),
    next: rows.length > q.limit ? page.at(-1)!.id : null,
  };
}

/** One cluster of the canonical view with the records of its live members. */
export interface CanonicalCluster extends CanonicalFeature {
  members: Rec[];
}

export interface CanonicalPage {
  clusters: CanonicalCluster[];
  /** The cursor of the next page, a canonical feature id; null when this page is the last. */
  next: string | null;
}

/**
 * The clusters of the canonical view with a live member matching `q`, one
 * keyset page ordered by canonical feature id, each with all its live
 * members (whether they match or not). Every feature has a cluster, a lone
 * one included, so the view is complete.
 */
export async function listCanonicalFeatures(
  db: QueryRunner,
  q: FeatureQuery,
): Promise<CanonicalPage> {
  const params: unknown[] = [];
  const p = binder(params);
  const at = (q.at ?? new Date()).toISOString();
  const matching = liveClauses("f", at, q, p);
  const live = liveClauses("m", at, {}, p);
  // Without a box, walking the clusters in id order and stopping at the page
  // limit is cheapest. A box may hold few features of many clusters: there
  // the box picks the features (spatial index) and each one's cluster is
  // looked up by member, rather than testing every cluster until a page fills.
  const clauses = [
    q.bbox
      ? `c.canonical_feature_id IN (
           SELECT h.canonical_feature_id FROM conditions.feature f
             JOIN conditions.feature_canonical h ON h.member_ids @> ARRAY[f.id]
            WHERE ${matching.join(" AND ")})`
      : `EXISTS (SELECT 1 FROM conditions.feature f
                  WHERE f.id = ANY(c.member_ids) AND ${matching.join(" AND ")})`,
  ];
  if (q.cursor !== undefined) clauses.push(`c.canonical_feature_id > ${p(q.cursor)}`);
  const rows = await db.execute<
    {
      canonical_feature_id: string;
      survivor_id: string;
      member_ids: string[];
      components: CanonicalFeature["components"];
      members: Rec[] | null;
    }[]
  >(
    `SELECT c.canonical_feature_id, c.survivor_id, c.member_ids, c.components,
            (SELECT jsonb_agg(m.record ORDER BY m.id) FROM conditions.feature m
              WHERE m.id = ANY(c.member_ids) AND ${live.join(" AND ")}) AS members
       FROM conditions.feature_canonical c
      WHERE ${clauses.join(" AND ")}
      ORDER BY c.canonical_feature_id
      LIMIT ${p(q.limit + 1)}`,
    params,
  );
  const page = rows.slice(0, q.limit);
  return {
    clusters: page.map((r) => ({
      canonicalFeatureId: r.canonical_feature_id,
      survivorId: r.survivor_id,
      memberIds: r.member_ids,
      components: r.components,
      members: r.members ?? [],
    })),
    next: rows.length > q.limit ? page.at(-1)!.canonical_feature_id : null,
  };
}

/**
 * The canonical feature of a cluster as a record: the survivor's record
 * under the cluster's canonical id, with the canonical component set (the
 * union of the members' components, keyed as the fused and crowd rows key
 * them), the other members credited in `provenance.mergedSources` and every
 * member named in `provenance.derivedFrom`. Built from `members` only, so a
 * caller that withholds a member (licence egress) withholds its components
 * and credit too; the cluster's survivor is replaced by the first member
 * left when it is withheld. Undefined when no member is left.
 */
export function canonicalFeatureRecord(
  cluster: Pick<CanonicalFeature, "canonicalFeatureId" | "survivorId" | "memberIds" | "components">,
  members: readonly Rec[],
): Rec | undefined {
  const byId = new Map(members.map((m) => [m["id"] as string, m]));
  const present = cluster.memberIds.filter((id) => byId.has(id));
  if (present.length === 0) return undefined;
  const survivorId = byId.has(cluster.survivorId) ? cluster.survivorId : present[0]!;
  const survivor = byId.get(survivorId)!;
  const componentOf = (featureId: string, key: string) =>
    ((byId.get(featureId)?.["components"] as Rec[] | undefined) ?? []).find(
      (c) => c["key"] === key,
    );
  const keys = new Set<string>();
  const components: Rec[] = [];
  for (const canonical of cluster.components) {
    const source = canonical.members
      .map((m) => componentOf(m.featureId, m.key))
      .find((c) => c !== undefined);
    if (source === undefined) continue;
    const { parentKey: _parent, ...rest } = source;
    keys.add(canonical.key);
    components.push({
      ...rest,
      key: canonical.key,
      ...(canonical.parentKey !== undefined ? { parentKey: canonical.parentKey } : {}),
    });
  }
  // A child whose parent no member left holds would dangle.
  const kept = components.filter(
    (c) => c["parentKey"] === undefined || keys.has(c["parentKey"] as string),
  );
  const provenance = survivor["provenance"] as Rec;
  const others = present.filter((id) => id !== survivorId).map((id) => byId.get(id)!);
  const merged = [
    ...((provenance["mergedSources"] as Rec[] | undefined) ?? []),
    ...others.map((m) => {
      const p = m["provenance"] as Rec;
      return {
        source: p["sourceId"],
        recordId: m["id"],
        attribution: p["attribution"],
        link: "same_asset",
      };
    }),
  ];
  const id = cluster.canonicalFeatureId;
  const parts = parseRecordId(id);
  const { components: _components, ...record } = survivor;
  return {
    ...record,
    id,
    ...(parts ? { canonicalId: canonicalIdOf(parts.namespace, parts.localId) } : {}),
    ...(kept.length > 0 ? { components: kept } : {}),
    provenance: {
      ...provenance,
      ...(merged.length > 0 ? { mergedSources: merged } : {}),
      derivedFrom: {
        records: present.map((m) => ({ class: "feature", id: m })),
        method: "canonical_view",
        version: "1",
      },
    },
  };
}
