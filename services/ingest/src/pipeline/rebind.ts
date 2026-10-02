import { RESOLVER_VERSION } from "@openconditions/roads";
import type postgres from "postgres";
import { bindOptionsFromEnv, bindRecords } from "./bind-records.js";

type Sql = postgres.Sql;

/** Ids per `bindRecords` call, so one pass never holds the whole store in memory. */
const BATCH = 500;

interface RebindDeps {
  now: () => string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Everything a rebind pass has to look at: every live road situation, plus
 * every situation that still carries a binding while no longer live. The
 * second branch drops bindings a tombstone or purge left behind without going
 * through the binder.
 */
async function rebindableIds(sql: Sql): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM conditions.situation WHERE tombstoned_at IS NULL AND domain = 'roads'
    UNION
    SELECT b.record_id AS id FROM conditions.record_binding b
      LEFT JOIN conditions.situation s ON s.id = b.record_id
     WHERE b.record_class = 'situation'
       AND (s.id IS NULL OR s.tombstoned_at IS NOT NULL OR s.domain <> 'roads')`;
  return rows.map((r) => r.id);
}

/**
 * Binds `ids` in batches. `force` marks stored bindings obsolete first so
 * `bindRecords` cannot skip them as unchanged, while readers immediately stop
 * applying the old graph and the old spans survive until their transactional
 * replacement succeeds. Returns how many targets were actually re-resolved.
 */
async function bindIds(sql: Sql, ids: string[], deps: RebindDeps, force: boolean): Promise<number> {
  let rebound = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    if (force) {
      await sql`UPDATE conditions.record_binding SET status = 'obsolete'
        WHERE record_class = 'situation' AND record_id = ANY(${slice}::text[])`;
    }
    const r = await bindRecords(sql, slice, deps);
    rebound += r.attempted;
    if (r.writeErrors > 0) {
      console.warn(
        `[rebind] ${r.writeErrors} of ${r.attempted} bindings could not be written; ` +
          `those situations keep their previous binding until the next pass`,
      );
    }
  }
  return rebound;
}

/**
 * Startup pass: hands every rebindable situation to the binder and lets its
 * change detection decide, so a situation is re-resolved when it was never
 * bound or its inputs moved without the binder being called. When stored
 * bindings come from another resolver version, everything is rebound.
 */
export async function rebindOnBoot(sql: Sql, deps: RebindDeps): Promise<{ rebound: number }> {
  // Bail before touching anything: with the stage off, marking or clearing
  // bindings here would strip the store of data nothing would put back.
  if (!bindOptionsFromEnv(deps.env).enabled) return { rebound: 0 };
  const [other] = await sql`
    SELECT 1 FROM conditions.record_binding WHERE resolver_version <> ${RESOLVER_VERSION} LIMIT 1`;
  if (other !== undefined) return { rebound: (await rebindAll(sql, deps)).rebound };
  return { rebound: await bindIds(sql, await rebindableIds(sql), deps, false) };
}

/**
 * After a spine rebuild or a resolver change: force a re-resolve of every
 * rebindable situation, because a rebuilt spine renumbers segments under
 * situations whose own inputs are unchanged and the binder would otherwise
 * skip them. Then drop any span still pointing at a segment the rebuild
 * removed.
 */
export async function rebindAll(
  sql: Sql,
  deps: RebindDeps,
): Promise<{ rebound: number; prunedSegments: number }> {
  if (!bindOptionsFromEnv(deps.env).enabled) return { rebound: 0, prunedSegments: 0 };
  const rebound = await bindIds(sql, await rebindableIds(sql), deps, true);
  const pruned = await sql`
    DELETE FROM conditions.record_segment s
     WHERE NOT EXISTS (SELECT 1 FROM conditions.road_segment rs WHERE rs.segment_id = s.segment_id)
    RETURNING s.record_id`;
  return { rebound, prunedSegments: pruned.length };
}
