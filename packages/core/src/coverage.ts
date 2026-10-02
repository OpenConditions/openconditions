import type { QueryRunner } from "./query-runner.js";

/** What one country, subdivision, class, kind and access mode holds now. */
export interface CoverageRow {
  country: string | null;
  subdivision: string | null;
  class: "situation" | "feature" | "offer";
  kind: string;
  accessMode: string;
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
 * mode, with the sources behind them and how fresh those sources are.
 */
export async function readCoverage(db: QueryRunner): Promise<CoverageRow[]> {
  const rows = await db.execute<Record<string, unknown>[]>(
    `SELECT c.country, c.subdivision, c.class, c.kind, c.access_mode,
            count(*)::int AS records,
            array_agg(DISTINCT c.source_id ORDER BY c.source_id) AS sources,
            max(ss.last_success_at) AS last_success_at,
            min(ss.freshness_deadline) AS fresh_until
       FROM (SELECT country, subdivision, 'situation' AS class, kind, access_mode, source_id
               FROM conditions.situation WHERE tombstoned_at IS NULL
             UNION ALL
             SELECT country, subdivision, 'feature', kind, access_mode, source_id
               FROM conditions.feature WHERE tombstoned_at IS NULL
             UNION ALL
             SELECT country, subdivision, 'offer', kind, access_mode, source_id
               FROM conditions.offer WHERE tombstoned_at IS NULL) c
       LEFT JOIN conditions.source_status ss ON ss.source = c.source_id
      GROUP BY c.country, c.subdivision, c.class, c.kind, c.access_mode
      ORDER BY c.country NULLS LAST, c.subdivision NULLS FIRST, c.class, c.kind, c.access_mode`,
  );
  return rows.map((r) => ({
    country: (r["country"] as string | null) ?? null,
    subdivision: (r["subdivision"] as string | null) ?? null,
    class: r["class"] as CoverageRow["class"],
    kind: r["kind"] as string,
    accessMode: r["access_mode"] as string,
    records: r["records"] as number,
    sources: r["sources"] as string[],
    lastSuccessAt: iso(r["last_success_at"]),
    freshUntil: iso(r["fresh_until"]),
  }));
}
