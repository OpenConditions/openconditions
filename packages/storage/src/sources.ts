import type { EffectiveRights } from "@openconditions/ingest-framework";
import type postgres from "postgres";

/** The catalogue fields of one loaded source that SQL joins read. */
export interface SourceEntry {
  id: string;
  domain: string;
  format: string;
  /** What the source publishes, from its domain's product list (`flow`, `events`, …). */
  product: string;
  accessMode?: "bulk" | "on_demand";
  tier: string;
  /** Upper-case ISO 3166-1 alpha-2; absent for a source of no single country. */
  country?: string;
  subdivision?: string;
  operator: string;
  license: string;
  licenseUrl?: string;
  attribution: string;
  rights?: EffectiveRights;
  /** How often the source is polled: its smallest data-endpoint cadence. */
  cadenceSec: number;
  freshnessWindowSec: number;
  rawRetention?: string;
  extrasAllow?: readonly string[];
  extrasFederate?: boolean;
  laneNumbering?: string;
  parentSourceId?: string;
  policyIds?: readonly string[];
  selectionState?: string;
}

/**
 * Makes `conditions.source` mirror the loaded catalogue: every given source is
 * inserted or refreshed and marked active, every other row is marked inactive
 * (kept, because records still name it). One transaction, so a reader never
 * sees a half-synced catalogue.
 */
export async function syncSources(sql: postgres.Sql, sources: readonly SourceEntry[]) {
  const rows = sources.map((s) => ({
    id: s.id,
    domain: s.domain,
    format: s.format,
    product: s.product,
    access_mode: s.accessMode ?? "bulk",
    tier: s.tier,
    country: s.country ?? null,
    subdivision: s.subdivision ?? null,
    operator: s.operator,
    license: s.license,
    license_url: s.licenseUrl ?? null,
    attribution: s.attribution,
    rights: s.rights ?? null,
    cadence_sec: s.cadenceSec,
    freshness_window_sec: s.freshnessWindowSec,
    raw_retention: s.rawRetention ?? null,
    extras_allow: [...(s.extrasAllow ?? [])],
    extras_federate: s.extrasFederate ?? false,
    lane_numbering: s.laneNumbering ?? null,
    parent_source_id: s.parentSourceId ?? null,
    policy_ids: s.policyIds ? [...s.policyIds] : null,
    selection_state: s.selectionState ?? null,
  }));
  await sql.begin(async (tx) => {
    if (rows.length > 0) {
      await tx`
        INSERT INTO conditions.source (
          id, domain, format, product, access_mode, tier, country, subdivision, operator,
          license, license_url, attribution, rights, cadence_sec, freshness_window_sec,
          raw_retention, extras_allow, extras_federate, lane_numbering, parent_source_id,
          policy_ids, selection_state, active, updated_at
        )
        SELECT r.id, r.domain, r.format, r.product, r.access_mode, r.tier, r.country,
          r.subdivision, r.operator, r.license, r.license_url, r.attribution, r.rights,
          r.cadence_sec, r.freshness_window_sec, r.raw_retention,
          ARRAY(SELECT jsonb_array_elements_text(r.extras_allow)), r.extras_federate,
          r.lane_numbering, r.parent_source_id,
          CASE WHEN r.policy_ids IS NULL THEN NULL
               ELSE ARRAY(SELECT jsonb_array_elements_text(r.policy_ids)) END,
          r.selection_state, true, now()
        FROM jsonb_to_recordset(${tx.json(rows as never)}) AS r(
          id text, domain text, format text, product text, access_mode text, tier text,
          country text, subdivision text, operator text, license text, license_url text,
          attribution text, rights jsonb, cadence_sec int, freshness_window_sec int,
          raw_retention text, extras_allow jsonb, extras_federate boolean, lane_numbering text,
          parent_source_id text, policy_ids jsonb, selection_state text
        )
        ON CONFLICT (id) DO UPDATE SET
          domain = excluded.domain, format = excluded.format, product = excluded.product,
          access_mode = excluded.access_mode, tier = excluded.tier, country = excluded.country,
          subdivision = excluded.subdivision, operator = excluded.operator,
          license = excluded.license, license_url = excluded.license_url,
          attribution = excluded.attribution, rights = excluded.rights,
          cadence_sec = excluded.cadence_sec,
          freshness_window_sec = excluded.freshness_window_sec,
          raw_retention = excluded.raw_retention, extras_allow = excluded.extras_allow,
          extras_federate = excluded.extras_federate, lane_numbering = excluded.lane_numbering,
          parent_source_id = excluded.parent_source_id, policy_ids = excluded.policy_ids,
          selection_state = excluded.selection_state, active = true, updated_at = now()`;
    }
    await tx`
      UPDATE conditions.source SET active = false, updated_at = now()
      WHERE active AND NOT (id = ANY(${rows.map((r) => r.id)}::text[]))`;
  });
}
