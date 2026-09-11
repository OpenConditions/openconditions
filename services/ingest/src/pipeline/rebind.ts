import type postgres from "postgres";
import { bindObservations, bindOptionsFromEnv } from "./bind-observations.js";

type Sql = postgres.Sql;

/** Ids per `bindObservations` call, so one pass never holds the whole store in memory. */
const BATCH = 500;

interface RebindDeps {
  now: () => string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Everything a rebind pass has to look at: every active road event, plus every
 * id that still carries a binding while no longer being an active road event.
 * The second branch exists because a writer can flip `observations.status` in
 * place without going through the binding stage — the FK cascade only fires on
 * a real delete, so without it an ended closure would keep its `exact` status
 * and its spans forever. `bindObservations` drops those bindings itself.
 */
async function rebindableIds(sql: Sql): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM conditions.observations
    WHERE kind = 'event' AND domain = 'roads' AND status = 'active'
    UNION
    SELECT b.observation_id AS id FROM conditions.observation_binding b
    JOIN conditions.observations o ON o.id = b.observation_id
    WHERE o.status <> 'active' OR o.kind <> 'event' OR o.domain <> 'roads'`;
  return rows.map((r) => r.id);
}

/**
 * Binds `ids` in batches. `force` marks stored bindings obsolete first so
 * `bindObservations` cannot skip them as unchanged, while readers immediately
 * stop applying the old graph and the old diagnostic/spans survive until their
 * transactional replacement succeeds. Returns the number of
 * ids the stage actually re-resolved, so an id it skipped as unchanged and one
 * it only cleared are both excluded.
 */
async function bindIds(sql: Sql, ids: string[], deps: RebindDeps, force: boolean): Promise<number> {
  let rebound = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    if (force) {
      await sql`UPDATE conditions.observation_binding SET status = 'obsolete'
        WHERE observation_id = ANY(${sql.array(slice)}::text[])`;
    }
    const r = await bindObservations(sql, slice, deps);
    rebound += r.attempted;
    if (r.writeErrors > 0) {
      console.warn(
        `[rebind] ${r.writeErrors} of ${r.attempted} bindings could not be written; ` +
          `those events keep their previous binding until the next pass`
      );
    }
  }
  return rebound;
}

/**
 * Startup/version pass: hands every rebindable id to the stage and lets its own
 * change detection decide, so a row is re-resolved when it was never bound, was
 * bound by an older resolver, or its resolver inputs moved without the writer
 * that changed them calling the stage. Nothing is force-deleted here: the stage
 * replaces a binding in one transaction, so an unchanged row is left untouched
 * and a boot with nothing stale reports 0.
 */
export async function rebindStale(sql: Sql, deps: RebindDeps): Promise<{ rebound: number }> {
  // Bail before touching anything: with the stage off, deleting or clearing
  // bindings here would strip the store of data nothing would put back.
  if (!bindOptionsFromEnv(deps.env).enabled) return { rebound: 0 };
  const rebound = await bindIds(sql, await rebindableIds(sql), deps, false);
  return { rebound };
}

/**
 * After a spine rebuild: force a re-resolve of every rebindable id, because a
 * rebuilt spine renumbers segments under events whose own inputs are unchanged
 * and the stage would otherwise skip them. Then drop any path row still
 * pointing at a segment the rebuild removed.
 */
export async function rebindAll(
  sql: Sql,
  deps: RebindDeps
): Promise<{ rebound: number; prunedSegments: number }> {
  if (!bindOptionsFromEnv(deps.env).enabled) return { rebound: 0, prunedSegments: 0 };
  const rebound = await bindIds(sql, await rebindableIds(sql), deps, true);
  const pruned = await sql<{ observation_id: string }[]>`
    DELETE FROM conditions.observation_segment s
    WHERE NOT EXISTS (SELECT 1 FROM conditions.road_segment rs WHERE rs.segment_id = s.segment_id)
    RETURNING observation_id`;
  return { rebound, prunedSegments: pruned.length };
}
