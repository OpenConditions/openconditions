import type postgres from "postgres";
import type { IngestPlan } from "./ingest-role.js";

/**
 * Claims, for the life of the process, the work no two ingest processes may
 * share: each feed it polls and, for the primary, the work one process of a
 * deployment runs. Each claim is a session advisory lock on `sql`, a client
 * of one connection that never recycles it, so the claims end with the
 * process. A claim another live process holds fails boot, naming it: two
 * processes polling one feed, or two primaries, is a misconfiguration. The
 * check is the boot's: claims a lost connection drops are not taken again.
 */
export async function claimIngestWork(
  sql: postgres.Sql,
  plan: Pick<IngestPlan, "role" | "feeds">,
): Promise<void> {
  if (plan.role === "primary") {
    const [row] = await sql<{ claimed: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtext('openconditions'), hashtext('ingest-primary')) AS claimed`;
    if (!row?.claimed) {
      throw new Error(
        "another primary ingest process runs against this database; a second one needs OPENCONDITIONS_INGEST_ROLE=feeds",
      );
    }
  }
  const ids = plan.feeds.map((f) => f.id);
  const held = await sql<{ id: string }[]>`
    SELECT id FROM unnest(${ids}::text[]) AS id
     WHERE NOT pg_try_advisory_lock(hashtext('openconditions-feed'), hashtext(id))`;
  if (held.length > 0) {
    throw new Error(
      `another ingest process polls ${held.map((r) => r.id).join(", ")}: give each feed to one ` +
        "process (OPENCONDITIONS_INGEST_FEEDS on one, OPENCONDITIONS_INGEST_FEEDS_EXCLUDE on the other)",
    );
  }
}

/**
 * Within the transaction `tx`, takes until it ends the claim of each feed of
 * `ids` no live ingest process holds, so none starts polling it meanwhile,
 * and sorts the feeds claimed already by their holder: the primary, or
 * another process.
 */
export async function claimFeedsFor(
  tx: postgres.TransactionSql,
  ids: readonly string[],
): Promise<{ free: string[]; primary: string[]; other: string[] }> {
  // pg_locks shows each key of a two-key advisory lock as an oid.
  const rows = await tx<{ id: string; free: boolean; by_primary: boolean }[]>`
    WITH k AS (
      SELECT (SELECT oid FROM pg_database WHERE datname = current_database()) AS db,
             (hashtext('openconditions-feed')::bigint & 4294967295)::text::oid AS feed,
             (hashtext('openconditions')::bigint & 4294967295)::text::oid AS role,
             (hashtext('ingest-primary')::bigint & 4294967295)::text::oid AS primary_role)
    SELECT s.id,
           pg_try_advisory_xact_lock(hashtext('openconditions-feed'), hashtext(s.id)) AS free,
           EXISTS (
             SELECT 1 FROM pg_locks f JOIN pg_locks p ON p.pid = f.pid
              WHERE f.locktype = 'advisory' AND f.granted AND f.objsubid = 2
                AND f.database = k.db AND f.classid = k.feed
                AND f.objid = (hashtext(s.id)::bigint & 4294967295)::text::oid
                AND p.locktype = 'advisory' AND p.granted AND p.objsubid = 2
                AND p.database = k.db AND p.classid = k.role AND p.objid = k.primary_role
           ) AS by_primary
      FROM unnest(${[...ids]}::text[]) AS s(id), k`;
  return {
    free: rows.filter((r) => r.free).map((r) => r.id),
    primary: rows.filter((r) => !r.free && r.by_primary).map((r) => r.id),
    other: rows.filter((r) => !r.free && !r.by_primary).map((r) => r.id),
  };
}
