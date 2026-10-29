import type { RevisionedClass } from "@openconditions/core/server";
import type postgres from "postgres";

const CLASSES: readonly RevisionedClass[] = ["situation", "feature", "offer"];

/** Revisions deleted per statement, so a backlog goes in bounded transactions. */
const REVISION_BATCH = 10_000;

/**
 * Deletes the revisions recorded more than `historyDays` before `now`, except
 * each record's latest: the history API keeps a short window of changes and
 * the revision a record now stands at. Nothing else reads revisions; a
 * record's next revision number comes from the record itself. Returns how
 * many it deleted.
 */
export async function pruneRevisions(
  sql: postgres.Sql,
  opts: { now: string; historyDays: number },
): Promise<number> {
  let pruned = 0;
  for (const cls of CLASSES) {
    let deleted: number;
    do {
      const result = await sql.unsafe(
        `DELETE FROM conditions.${cls}_revision
          WHERE (${cls}_id, revision) IN (
            SELECT v.${cls}_id, v.revision FROM conditions.${cls}_revision v
              JOIN conditions.${cls} r ON r.id = v.${cls}_id
             WHERE v.recorded_at < $1::timestamptz - make_interval(days => $2)
               AND v.revision < r.revision
             LIMIT ${REVISION_BATCH})`,
        [opts.now, opts.historyDays],
      );
      deleted = result.count;
      pruned += deleted;
    } while (deleted === REVISION_BATCH);
  }
  return pruned;
}
