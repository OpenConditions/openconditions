import type { Sql } from "./bulk.js";

/**
 * The ids of the canonical clusters holding any of `featureIds` as a member,
 * for a `WITH held AS MATERIALIZED` clause. Each id is looked up in the member
 * index on its own. A member test against the whole list, evaluated per
 * cluster, compares every cluster with every id: for a national feed that ran
 * for tens of minutes and ignored cancellation. Materializing the result keeps
 * the planner from folding the lookup back into a per-cluster test.
 */
export function clustersHolding(tx: Sql, featureIds: readonly string[]) {
  return tx`
    SELECT DISTINCT held.canonical_feature_id
      FROM unnest(${featureIds as string[]}::text[]) AS named(id)
     CROSS JOIN LATERAL (
       SELECT c.canonical_feature_id FROM conditions.feature_canonical c
        WHERE c.member_ids @> ARRAY[named.id]) held`;
}

/**
 * Restricts `feature_canonical c` to the clusters of a `held` clause, through
 * the primary key. The planner has no statistics for a member test against a
 * lateral id and assumes each id is held by 0.5% of all clusters, so a batch
 * of a few hundred ids looks like the whole table: joined, `held` became a
 * hash join over a sequential scan of every cluster, spilled to temporary
 * files on each call. An array of `held` is probed key by key instead.
 */
export function inHeld(tx: Sql) {
  return tx`c.canonical_feature_id = ANY(ARRAY(SELECT canonical_feature_id FROM held))`;
}
