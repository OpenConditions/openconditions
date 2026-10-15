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
