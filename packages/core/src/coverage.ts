import type { QueryRunner } from "./query-runner.js";

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
 * fresh those sources are, as of `at` (default now). A reading has no country of its own: it counts
 * under its source's catalogue country (none for crowd readings). Fused rows
 * restate other rows and are not counted.
 */
export async function readCoverage(
  db: QueryRunner,
  opts: { at?: Date } = {},
): Promise<CoverageRow[]> {
  const rows = await db.execute<Record<string, unknown>[]>(
    `SELECT c.country, c.subdivision, c.class, c.kind, c.property, c.access_mode,
            count(*)::int AS records,
            array_agg(DISTINCT c.source_id ORDER BY c.source_id) AS sources,
            max(ss.last_success_at) AS last_success_at,
            min(ss.freshness_deadline) AS fresh_until
       FROM (SELECT country, subdivision, 'situation' AS class, kind, NULL::text AS property,
                    access_mode, source_id
               FROM conditions.situation WHERE tombstoned_at IS NULL
             UNION ALL
             SELECT country, subdivision, 'feature', kind, NULL, access_mode, source_id
               FROM conditions.feature WHERE tombstoned_at IS NULL
             UNION ALL
             SELECT country, subdivision, 'offer', kind, NULL, access_mode, source_id
               FROM conditions.offer WHERE tombstoned_at IS NULL
             UNION ALL
             SELECT s.country, s.subdivision, 'observation', 'observation', l.property,
                    l.access_mode, l.source_id
               FROM conditions.observation_latest l
               LEFT JOIN conditions.source s ON s.id = l.source_id
              WHERE l.source_id <> '@fused'
                AND (l.expires_at IS NULL OR l.expires_at > $1::timestamptz)
                AND (l.evidence_state IS NULL OR l.evidence_state NOT IN ('expired', 'negated'))) c
       LEFT JOIN conditions.source_status ss ON ss.source = c.source_id
      GROUP BY c.country, c.subdivision, c.class, c.kind, c.property, c.access_mode
      ORDER BY c.country NULLS LAST, c.subdivision NULLS FIRST, c.class, c.kind,
               c.property NULLS FIRST, c.access_mode`,
    [(opts.at ?? new Date()).toISOString()],
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
