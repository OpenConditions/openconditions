import { FUSED_SOURCE_IDS } from "@openconditions/model";
import type { QueryRunner } from "./query-runner.js";
import { type Scope, scopeClauses } from "./record-filters.js";

/** What one country, subdivision, class, kind (or property) and access mode holds now. */
export interface CoverageRow {
  country: string | null;
  subdivision: string | null;
  class: "situation" | "feature" | "offer" | "observation";
  /** The kind; `observation` for readings, which `property` tells apart. */
  kind: string;
  /** The property of the readings counted (observations only). */
  property?: string;
  accessMode: string;
  /** Live records, or for observations live series (one reading in effect each). */
  records: number;
  sources: string[];
  /** The latest successful poll among those sources. */
  lastSuccessAt: string | null;
  /** The earliest freshness deadline among those sources: when the first may go stale. */
  freshUntil: string | null;
}

const iso = (v: unknown) =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

/**
 * Live record counts per country, subdivision, record class, kind and access
 * mode, and live series per property, with the sources behind them and how
 * fresh those sources are, as of `at` (default now), as `scope` may see
 * them: the public scope counts no record of a restricted source and names
 * none. A record counts while it is not tombstoned and not past its expiry,
 * as a reading does. A reading has no country of its own: it counts
 * under its source's catalogue country (none for crowd readings). Fused rows,
 * `@fused` and `@fused-public`, restate other rows and are not counted.
 */
export async function readCoverage(
  db: QueryRunner,
  opts: { scope: Scope; at?: Date },
): Promise<CoverageRow[]> {
  const live = (t: string) =>
    [
      `${t}.tombstoned_at IS NULL`,
      `(${t}.expires_at IS NULL OR ${t}.expires_at > $1::timestamptz)`,
      ...scopeClauses(t, opts.scope),
    ].join(" AND ");
  const currentReadings = [
    "l.source_id <> ALL($2::text[])",
    "(l.expires_at IS NULL OR l.expires_at > $1::timestamptz)",
    "(l.evidence_state IS NULL OR l.evidence_state NOT IN ('expired', 'negated'))",
    ...scopeClauses("l", opts.scope),
  ].join(" AND ");
  const rows = await db.execute<Record<string, unknown>[]>(
    `SELECT c.country, c.subdivision, c.class, c.kind, c.property, c.access_mode,
            count(*)::int AS records,
            array_agg(DISTINCT c.source_id ORDER BY c.source_id) AS sources,
            max(ss.last_success_at) AS last_success_at,
            min(ss.freshness_deadline) AS fresh_until
       FROM (SELECT r.country, r.subdivision, 'situation' AS class, r.kind,
                    NULL::text AS property, r.access_mode, r.source_id
               FROM conditions.situation r WHERE ${live("r")}
             UNION ALL
             SELECT r.country, r.subdivision, 'feature', r.kind, NULL, r.access_mode, r.source_id
               FROM conditions.feature r WHERE ${live("r")}
             UNION ALL
             SELECT r.country, r.subdivision, 'offer', r.kind, NULL, r.access_mode, r.source_id
               FROM conditions.offer r WHERE ${live("r")}
             UNION ALL
             SELECT s.country, s.subdivision, 'observation', 'observation', l.property,
                    l.access_mode, l.source_id
               FROM conditions.observation_latest l
               LEFT JOIN conditions.source s ON s.id = l.source_id
              WHERE ${currentReadings}) c
       LEFT JOIN conditions.source_status ss ON ss.source = c.source_id
      GROUP BY c.country, c.subdivision, c.class, c.kind, c.property, c.access_mode
      ORDER BY c.country NULLS LAST, c.subdivision NULLS FIRST, c.class, c.kind,
               c.property NULLS FIRST, c.access_mode`,
    [(opts.at ?? new Date()).toISOString(), [...FUSED_SOURCE_IDS]],
  );
  return rows.map((r) => ({
    country: (r["country"] as string | null) ?? null,
    subdivision: (r["subdivision"] as string | null) ?? null,
    class: r["class"] as CoverageRow["class"],
    kind: r["kind"] as string,
    ...(r["property"] != null ? { property: r["property"] as string } : {}),
    accessMode: r["access_mode"] as string,
    records: r["records"] as number,
    sources: r["sources"] as string[],
    lastSuccessAt: iso(r["last_success_at"]),
    freshUntil: iso(r["fresh_until"]),
  }));
}
