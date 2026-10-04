/**
 * Official cross-validation of crowd observations: a driver's reading is
 * resolved when a feed of this instance published the same reading of the
 * same subject — of any per-source feature (and component) the canonical
 * subject stands for — either in force when the report was made, or arriving
 * while the report was alive, its lifetime extended by confirmations
 * (`observationConfirms`). The match routes through the one external
 * resolution path, which records `official_match` and trains the reporter. A
 * feed reading that disagrees resolves nothing: the fused row already prefers
 * a fresh feed, and the feed may be what is wrong.
 */

import { canonicalKeyOf, recordFromHistory } from "@openconditions/core";
import {
  type AgreeingObservation,
  observationConfirms,
  type Registry,
} from "@openconditions/model";
import { loadCanonical } from "@openconditions/storage";
import type postgres from "postgres";
import { applyExternalResolution } from "../reputation/resolve.js";

type Sql = postgres.Sql;
type Rec = Record<string, unknown>;

export interface CrossValidateObservationDeps {
  applyExternalResolution?: typeof applyExternalResolution;
}

interface CrowdRow {
  subject_key: string;
  feature_id: string | null;
  component_key: string | null;
  property: string;
  qualifier_key: string;
  record: Rec;
  evidence_state: string | null;
  expires_at: Date | null;
}

interface FeedSeries {
  series_id: string;
  source_id: string;
  record: Rec;
  template: Rec;
}

const startOf = (record: Rec) => {
  const t = record["phenomenonTime"] as { instant?: string; start?: string };
  return Date.parse((t.instant ?? t.start)!);
};

/**
 * Cross-validates the crowd observation `observationId` against this
 * instance's feed readings of its subject. Returns the confirming feed
 * reading's id, or null when nothing confirms it, it is no longer the crowd
 * row of its series, it has ended or settled, or it carries no reporter.
 * Idempotent, as the resolution it applies is.
 */
export async function crossValidateObservation(
  sql: Sql,
  registry: Registry,
  observationId: string,
  now: string,
  deps: CrossValidateObservationDeps = {},
): Promise<string | null> {
  const resolve = deps.applyExternalResolution ?? applyExternalResolution;
  const [crowd] = await sql<CrowdRow[]>`
    SELECT subject_key, feature_id, component_key, property, qualifier_key,
           conditions.observation_record(template, reading) AS record, evidence_state, expires_at
      FROM conditions.observation_latest
     WHERE crowd_record_id = ${observationId}`;
  if (crowd === undefined) return null;
  if (["externally_resolved", "negated", "expired"].includes(crowd.evidence_state ?? ""))
    return null;
  if ((crowd.record["provenance"] as { reporter?: unknown }).reporter === undefined) return null;
  if (crowd.expires_at !== null && crowd.expires_at.getTime() <= Date.parse(now)) return null;

  const series = await feedSeries(sql, crowd);
  const at = startOf(crowd.record);
  const alive = crowd.expires_at?.getTime() ?? at;
  const report = {
    ...(crowd.record as unknown as AgreeingObservation),
    ...(crowd.expires_at === null ? {} : { expiresAt: crowd.expires_at.toISOString() }),
  };
  for (const s of series) {
    for (const reading of await readingsAround(sql, registry, s, at, alive)) {
      if (!observationConfirms(registry, report, reading as unknown as AgreeingObservation))
        continue;
      const id = reading["id"] as string;
      await resolve(
        sql,
        registry,
        { class: "observation", id: observationId },
        {
          source: "official",
          outcome: "confirmed",
          matchedRecord: { class: "observation", id, sourceId: s.source_id },
        },
        now,
      );
      return id;
    }
  }
  return null;
}

/**
 * The feed series of the subjects a crowd reading's canonical subject stands
 * for: of a feature, every member's (and the member component its canonical
 * component stands for); of a place, the series of that place. Only this
 * instance's own feeds count: a peer's copy is not ours to vouch for. A
 * restricted source's series never does: the public evidence state and the
 * reporter's trust a match earns would publish what it holds.
 */
async function feedSeries(sql: Sql, crowd: CrowdRow): Promise<FeedSeries[]> {
  const own = sql`
    l.source_id NOT IN ('crowd', '@fused', '@fused-public')
    AND l.template #>> '{provenance,origin}' = 'feed'
    AND jsonb_array_length(COALESCE(l.template #> '{provenance,originChain}', '[]'::jsonb)) = 0
    AND NOT EXISTS (SELECT 1 FROM conditions.source s WHERE s.id = l.source_id AND s.restricted)
    AND l.property = ${crowd.property} AND l.qualifier_key = ${crowd.qualifier_key}`;
  if (crowd.feature_id === null) {
    return sql<FeedSeries[]>`
      SELECT series_id::text AS series_id, source_id,
             conditions.observation_record(template, reading) AS record, template
        FROM conditions.observation_latest l WHERE ${own} AND l.subject_key = ${crowd.subject_key}`;
  }
  const [canonical] = await loadCanonical(sql, [crowd.feature_id]);
  if (canonical === undefined) return [];
  const pairs =
    crowd.component_key === null
      ? canonical.memberIds.map((featureId) => ({ featureId, key: null as string | null }))
      : (canonical.components.find((c) => c.key === crowd.component_key)?.members ?? []).filter(
          (m) => canonicalKeyOf(canonical, m.featureId, m.key) === crowd.component_key,
        );
  if (pairs.length === 0) return [];
  return sql<FeedSeries[]>`
    SELECT l.series_id::text AS series_id, l.source_id,
           conditions.observation_record(l.template, l.reading) AS record, l.template
      FROM conditions.observation_latest l
      JOIN jsonb_to_recordset(${JSON.stringify(pairs)}::text::jsonb) AS p("featureId" text, key text)
        ON l.feature_id = p."featureId" AND l.component_key IS NOT DISTINCT FROM p.key
     WHERE ${own}`;
}

/**
 * The readings of a feed series a report can be checked against: the one in
 * force when the report was made (its latest reading starting by then) and
 * every reading that started while the report was alive.
 */
async function readingsAround(
  sql: Sql,
  registry: Registry,
  series: FeedSeries,
  at: number,
  alive: number,
): Promise<Rec[]> {
  const latest = series.record;
  const out: Rec[] = [];
  const latestStart = startOf(latest);
  if (latestStart <= alive) out.push(latest);
  if (latestStart > at) {
    const rows = await sql<Rec[]>`
      (SELECT * FROM conditions.observation
        WHERE series_id = ${series.series_id}::bigint
          AND phenomenon_start <= ${new Date(at).toISOString()}
        ORDER BY phenomenon_start DESC LIMIT 1)
      UNION ALL
      (SELECT * FROM conditions.observation
        WHERE series_id = ${series.series_id}::bigint
          AND phenomenon_start > ${new Date(at).toISOString()}
          AND phenomenon_start <= ${new Date(alive).toISOString()})`;
    for (const row of rows) out.push(recordFromHistory(registry, series.template, row));
  }
  return out;
}
