import type { CatalogFeed } from "@openconditions/ingest-framework";
import type postgres from "postgres";
import { dataRoles } from "../pipeline/run.js";

type Sql = postgres.Sql | postgres.TransactionSql;

/** The upstream requests one cell of an on-demand source costs: one per URL of each data endpoint. */
export function requestsPerCell(feed: CatalogFeed): number {
  return dataRoles(feed).reduce(
    (n, role) => n + Math.max(1, feed.endpoints[role]?.urls?.length ?? 1),
    0,
  );
}

/**
 * Takes the requests one cell costs ({@link requestsPerCell}) from an
 * on-demand source's quota at `now`, or answers false when its limits leave
 * fewer: `requestLimits` counts upstream requests. `perMinute` is a token
 * bucket that refills that many tokens per 60 s and holds at most that many;
 * `perDay` caps a counter that resets at the UTC date change. An absent
 * limit does not limit. The quota lives in `conditions.on_demand_quota`, so
 * a restart does not reset it, and the take is one atomic statement: two
 * readers, in one process or several, never spend the same token. A refused
 * take changes nothing; the bucket refills from the last take.
 */
export async function takeCellTokens(sql: Sql, feed: CatalogFeed, now: Date): Promise<boolean> {
  const perMinute = feed.requestLimits?.perMinute ?? null;
  const perDay = feed.requestLimits?.perDay ?? null;
  if (perMinute === null && perDay === null) return true;
  const n = requestsPerCell(feed);
  // The tokens the bucket holds at `now`, before this take.
  const refilled = sql`LEAST(${perMinute}::float8, q.tokens::float8
    + GREATEST(0, extract(epoch FROM EXCLUDED.refilled_at - q.refilled_at)::float8)
      * ${perMinute}::float8 / 60)`;
  // Today's count before this take: none yet on a new UTC day.
  const counted = sql`CASE WHEN q.day = EXCLUDED.day THEN q.day_count ELSE 0 END`;
  const rows = await sql`
    INSERT INTO conditions.on_demand_quota AS q (source_id, tokens, refilled_at, day, day_count)
    SELECT ${feed.id}, COALESCE(${perMinute}::float8 - ${n}, 0), ${now}::timestamptz,
           (${now}::timestamptz AT TIME ZONE 'UTC')::date, ${n}
     WHERE (${perMinute}::float8 IS NULL OR ${perMinute}::float8 >= ${n})
       AND (${perDay}::int IS NULL OR ${perDay}::int >= ${n})
    ON CONFLICT (source_id) DO UPDATE SET
      tokens = COALESCE(${refilled} - ${n}, 0),
      refilled_at = GREATEST(q.refilled_at, EXCLUDED.refilled_at),
      day = EXCLUDED.day,
      day_count = ${counted} + ${n}
    WHERE (${perMinute}::float8 IS NULL OR ${refilled} >= ${n} - 1e-6)
      AND (${perDay}::int IS NULL OR ${counted} + ${n} <= ${perDay}::int)
    RETURNING 1`;
  return rows.length === 1;
}
