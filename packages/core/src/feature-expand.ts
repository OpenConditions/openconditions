import { FUSED_SOURCE_IDS, isFusedSourceId } from "@openconditions/model";
import { withEvidence } from "./db/records.js";
import {
  CROWD_SOURCE_ID,
  currentReadingClauses,
  liveOfferClauses,
  readingColumns,
} from "./live-rows.js";
import type { QueryRunner } from "./query-runner.js";
import { binder, type Scope, scopeClauses } from "./record-filters.js";

type Rec = Record<string, unknown>;

/** A feature's reading in effect as a feature collection carries it. */
export interface LatestReading {
  property: string;
  /** The component the reading is about; in the canonical view, the canonical component key. */
  componentKey?: string;
  qualifiers?: Record<string, unknown>;
  result: unknown;
  phenomenonTime: unknown;
  validUntil?: string;
  /**
   * The source of the reading's record; for a fused reading, the fusion the
   * scope reads: `@fused` (every contributor) or `@fused-public` (the public
   * contributors, where the full fusion used one that is not).
   */
  source: string;
  /**
   * A fused reading only: the distinct sources whose readings it was fused
   * from (`crowd` for a crowd report), in the order of its contributors (the
   * winner's first).
   */
  contributors?: string[];
}

/**
 * A feature a page expands: a canonical feature names the members the page
 * serves and, where the caller holds them, its canonical components, which
 * spare the read of `feature_canonical`.
 */
export interface ExpandedFeature {
  id: string;
  memberIds?: readonly string[];
  components?: CanonicalComponents["components"];
}

/** The canonical component set of a cluster, as `feature_canonical.components` stores it. */
export interface CanonicalComponents {
  components: readonly { key: string; members: readonly { featureId: string; key: string }[] }[];
}

/** The canonical component a member's component stands in, by its key. */
export function canonicalKeyOf(
  canonical: CanonicalComponents,
  featureId: string,
  componentKey: string,
): string | undefined {
  return canonical.components.find((c) =>
    c.members.some((m) => m.featureId === featureId && m.key === componentKey),
  )?.key;
}

export interface LatestOfFeaturesQuery {
  features: readonly ExpandedFeature[];
  /** Whether the features are canonical features, whose members' readings they collect. */
  canonical: boolean;
  scope: Scope;
  /** The instant readings are current at: not past their expiry. */
  at: Date;
  /**
   * The records that may leave (the licence gate, the reporter stripped),
   * applied to every reading before a fused one stands in for its members',
   * so a withheld fused reading gives way to theirs. Default: all of them.
   */
  egress?: (records: readonly Rec[]) => Rec[];
}

interface ReadingRow extends Rec {
  feature_id: string;
  component_key: string | null;
  qualifier_key: string;
  source_id: string;
  fused_sources: string[] | null;
  record: Rec;
}

/**
 * The readings in effect of each of `q.features`, keyed by its id (an empty
 * list for a feature without any). Per source, a feature's own readings.
 * In the canonical view, a canonical feature's readings are its members',
 * each keyed by the canonical component its member component stands in
 * (`feature_canonical.components`), and the fused readings on the canonical
 * feature itself, already keyed so: where the scope and the egress leave a
 * fused reading of a canonical component, property and qualifiers, it
 * stands in for the members' readings of them; otherwise each member's
 * reading is served. A crowd reading of a canonical feature shows through
 * its fused reading, as `listLatestObservations` serves it. Two statements
 * for a page, whatever its size; one where every canonical feature carries
 * its components.
 */
export async function latestOfFeatures(
  db: QueryRunner,
  q: LatestOfFeaturesQuery,
): Promise<Map<string, LatestReading[]>> {
  const out = new Map<string, LatestReading[]>(q.features.map((f) => [f.id, []]));
  if (q.features.length === 0) return out;
  const ownerOf = new Map<string, string>();
  for (const f of q.features) {
    ownerOf.set(f.id, f.id);
    if (q.canonical) for (const m of f.memberIds ?? []) ownerOf.set(m, f.id);
  }
  const clusters = new Map<string, CanonicalComponents>();
  if (q.canonical) {
    for (const f of q.features) {
      if (f.components !== undefined) clusters.set(f.id, { components: f.components });
    }
    const missing = q.features.filter((f) => f.components === undefined).map((f) => f.id);
    if (missing.length > 0) {
      const rows = await db.execute<
        { canonical_feature_id: string; components: CanonicalComponents["components"] }[]
      >(
        `SELECT canonical_feature_id, components FROM conditions.feature_canonical
          WHERE canonical_feature_id = ANY($1::text[])`,
        [missing],
      );
      for (const r of rows) clusters.set(r.canonical_feature_id, { components: r.components });
    }
  }
  const params: unknown[] = [q.at.toISOString()];
  const p = binder(params);
  const clauses = [
    ...currentReadingClauses("l", "$1", q.scope),
    `l.feature_id = ANY(${p([...ownerOf.keys()])}::text[])`,
    // The scope's clauses leave the one fused row the scope reads, so a
    // full and a public fusion, which share a record id, never meet here.
    q.canonical
      ? `l.source_id <> ${p(CROWD_SOURCE_ID)}`
      : `l.source_id <> ALL(${p([...FUSED_SOURCE_IDS])}::text[])`,
  ];
  const rows = await db.execute<ReadingRow[]>(
    `SELECT l.feature_id, l.component_key, l.qualifier_key, l.source_id, l.fused_sources,
            ${readingColumns("l")}
       FROM conditions.observation_latest l
      WHERE ${clauses.join(" AND ")}
      ORDER BY l.property, l.component_key NULLS FIRST, l.qualifier_key, l.source_id, l.feature_id`,
    params,
  );
  const records = rows.map(withEvidence);
  const rowOf = new Map(records.map((r, i) => [r["id"] as string, rows[i]!]));
  const shown = q.egress === undefined ? records : q.egress(records);

  const groups = new Map<
    string,
    { owner: string; fused?: LatestReading; members: LatestReading[] }
  >();
  for (const record of shown) {
    const row = rowOf.get(record["id"] as string);
    if (row === undefined) continue;
    const owner = ownerOf.get(row.feature_id)!;
    const fused = isFusedSourceId(row.source_id);
    let componentKey = row.component_key ?? undefined;
    if (q.canonical && !fused && componentKey !== undefined) {
      // A member's component the cluster does not hold has no canonical
      // subject to serve it under, as fusion skips it.
      const cluster = clusters.get(owner);
      componentKey = cluster && canonicalKeyOf(cluster, row.feature_id, componentKey);
      if (componentKey === undefined) continue;
    }
    const reading = readingOf(record, componentKey, fused ? (row.fused_sources ?? []) : undefined);
    const key = JSON.stringify([owner, componentKey ?? null, reading.property, row.qualifier_key]);
    const group = groups.get(key) ?? { owner, members: [] };
    if (fused) group.fused = reading;
    else group.members.push(reading);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    out.get(group.owner)!.push(...(group.fused ? [group.fused] : group.members));
  }
  return out;
}

/**
 * A reading's record as a feature collection carries it; a fused one with
 * `contributors`, the sources of its contributing rows (`fused_sources`,
 * `crowd` for a crowd report).
 */
function readingOf(
  record: Rec,
  componentKey: string | undefined,
  contributors: readonly string[] | undefined,
): LatestReading {
  const qualifiers = record["qualifiers"] as Record<string, unknown> | undefined;
  const validUntil = record["validUntil"] as string | undefined;
  return {
    property: record["property"] as string,
    ...(componentKey !== undefined ? { componentKey } : {}),
    ...(qualifiers !== undefined ? { qualifiers } : {}),
    result: record["result"],
    phenomenonTime: record["phenomenonTime"],
    ...(validUntil !== undefined ? { validUntil } : {}),
    source: (record["provenance"] as Rec)["sourceId"] as string,
    ...(contributors !== undefined ? { contributors: [...contributors] } : {}),
  };
}

export interface OffersOfFeaturesQuery {
  features: readonly ExpandedFeature[];
  scope: Scope;
  /** The instant offers are current at: not tombstoned, not past their expiry or validity. */
  at: Date;
}

/**
 * The live offers of each of `q.features`, keyed by its id (an empty list
 * for a feature without any), ordered by id: every offer whose subject is
 * the feature, one of its members, or a component of either. One statement
 * for a page, whatever its size.
 */
export async function offersOfFeatures(
  db: QueryRunner,
  q: OffersOfFeaturesQuery,
): Promise<Map<string, Rec[]>> {
  const out = new Map<string, Rec[]>(q.features.map((f) => [f.id, []]));
  if (q.features.length === 0) return out;
  const ownerOf = new Map<string, string>();
  for (const f of q.features) {
    ownerOf.set(f.id, f.id);
    for (const m of f.memberIds ?? []) ownerOf.set(m, f.id);
  }
  const params: unknown[] = [q.at.toISOString()];
  const p = binder(params);
  const clauses = [
    ...liveOfferClauses("o", "$1"),
    ...scopeClauses("o", q.scope),
    "o.subject_class = 'feature'",
    `o.subject_id = ANY(${p([...ownerOf.keys()])}::text[])`,
  ];
  const rows = await db.execute<{ subject_id: string; record: Rec }[]>(
    `SELECT o.subject_id, o.record FROM conditions.offer o
      WHERE ${clauses.join(" AND ")}
      ORDER BY o.id`,
    params,
  );
  for (const row of rows) out.get(ownerOf.get(row.subject_id)!)!.push(row.record);
  return out;
}
